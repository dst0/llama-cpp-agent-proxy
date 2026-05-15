import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { getAvailablePort, startMockUpstream } from './helpers.js';

const TEST_LOG_FILE = path.join(os.tmpdir(), `llama-cpp-agent-proxy-test-${process.pid}.log`);

async function startProxy(envOverrides = {}, proxyPort, targetPort) {
    const proxyPortStr = proxyPort ?? await getAvailablePort();
    const targetPortStr = targetPort ?? 11460;
    return new Promise(async (resolve, reject) => {
        const child = spawn('node', ['index.js'], {
            env: {
                ...process.env,
                NODE_ENV: 'test',
                TARGET_HOST: '127.0.0.1',
                TARGET_PORT: targetPortStr.toString(),
                PORT: proxyPortStr.toString(),
                BACKEND_PORTS: targetPortStr.toString(),
                MONITOR_ENABLED: 'false',
                TITLE_MODEL: 'none', // Disable title generation in tests
                LOG_FILE: TEST_LOG_FILE,
                STATUS_FILE: path.join(os.tmpdir(), `proxy-${proxyPortStr}.status`),
                ...envOverrides
            }
        });
        
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);

        const wait = new Promise((ok, fail) => {
            const timeout = setTimeout(() => fail(new Error(`Proxy failed to start: ${stderr}`)), 5000);
            const check = () => {
                const req = http.get(`http://127.0.0.1:${proxyPortStr}/v1/models`, (res) => {
                    res.destroy();
                    clearTimeout(timeout);
                    ok();
                });
                req.on('error', () => setTimeout(check, 100));
            };
            check();
        });
        try {
            await wait;
            resolve({ child, proxyPort: proxyPortStr, getLogs: () => ({ stdout, stderr }) });
        } catch (e) {
            child.kill();
            reject(e);
        }
    });
}

function requestProxy({ path: requestPath, method, body, headers, timeout = 0 }, proxyPort) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: requestPath,
            method,
            headers
        });

        if (timeout > 0) {
            req.setTimeout(timeout, () => {
                req.destroy(new Error(`Request timed out after ${timeout}ms`));
            });
        }

        req.on('response', (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    body: Buffer.concat(chunks).toString()
                });
            });
        });
        req.on('error', reject);

        if (body !== undefined) {
            req.write(body);
        }

        req.end();
    });
}

function startMockServer(onReq, port = null) {
    return startMockUpstream((req, res) => {
        if (req.url === '/v1/models' || req.url === '/props' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                models: [{ name: 'test-model' }, { id: 'test' }],
                data: [{ id: 'test-model' }, { id: 'test' }],
                status: 'ok'
            }));
            return;
        }
        onReq(req, res);
    }, port);
}

async function runTest(name, fn) {
    test(name, async (t) => {
        console.log(`\n[TEST START] ${name}`);
        const state = { mockServers: [], proxy: null, getProxyLogs: null };

        const cleanup = async () => {
            if (state.proxy) {
                try { state.proxy.kill('SIGKILL'); } catch {}
            }
            for (const ms of state.mockServers) {
                try { ms.server.close(); } catch {}
            }
        };

        try {
            await fn({ state, cleanup });
        } catch (e) {
            if (state.getProxyLogs) {
                const logs = state.getProxyLogs();
                console.error(`[Proxy Stdout]\n${logs.stdout}`);
                console.error(`[Proxy Stderr]\n${logs.stderr}`);
            }
            throw e;
        } finally {
            await cleanup();
        }
    });
}

runTest('Proxy should flatten tool calls', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const payload = {
        model: 'test-model',
        tools: [{
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'Get the weather',
                parameters: { type: 'object', properties: {} }
            }
        }],
        input: []
    };

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }, proxyPort);

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(receivedBody.tools[0].name, 'get_weather');
    assert.strictEqual(receivedBody.tools[0].type, 'function');
    assert.strictEqual(receivedBody.tools[0].function, undefined);
});

runTest('Proxy should handle streaming', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"text": "Hello"}\n\n');
        setTimeout(() => {
            res.write('data: {"text": " World"}\n\n');
            res.end();
        }, 50);
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, input: [] })
    }, proxyPort);

    assert.ok(response.body.includes('Hello'));
    assert.ok(response.body.includes('World'));
});

runTest('Proxy should normalize tool outputs for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    type: 'function_call_output',
                    call_id: 'call_1',
                    output: [{ type: 'output_text', text: 'Sunny' }]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_2',
                    content: [{ type: 'output_text', text: 'Done' }]
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input[0], {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_text', text: 'Sunny' }]
    });
    assert.deepStrictEqual(receivedBody.input[1], {
        type: 'function_call_output',
        call_id: 'call_2',
        output: [{ type: 'input_text', text: 'Done' }]
    });
});

runTest('Proxy should preserve input_text parts for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hi there' }]
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input[0].content, [
        { type: 'input_text', text: 'hi there' }
    ]);
});

runTest('Proxy should preserve function_call items for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    type: 'function_call',
                    call_id: 'call_123',
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}'
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input[0], {
        type: 'function_call',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"city":"Paris"}'
    });
});

runTest('Proxy should drop reasoning-only assistant turns before forwarding', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    role: 'assistant',
                    content: [{ type: 'reasoning_text', text: 'hidden' }]
                },
                {
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hello again' }]
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input, [
        {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello again' }]
        }
    ]);
});

runTest('Proxy should normalize streaming assistant content', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
            output: [
                {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        { type: 'text', text: 'Hello from stream' },
                        { type: 'reasoning_text', text: 'hidden' }
                    ]
                }
            ]
        }) + '\n\n');
        res.end();
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, input: [] })
    }, proxyPort);

    assert.ok(response.body.includes('output_text'));
    assert.ok(response.body.includes('Hello from stream'));
    assert.ok(!response.body.includes('reasoning_text'));
});

runTest('Proxy should normalize input images for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_image', image_url: { url: 'http://example.com/test.png' } },
                        { type: 'text', text: 'Describe this image' }
                    ]
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input[0].content, [
        { type: 'input_image', image_url: 'http://example.com/test.png' },
        { type: 'input_text', text: 'Describe this image' }
    ]);
});

runTest('Proxy should preserve assistant output text for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'That was a reference to Usik.' },
                        { type: 'output_text', text: 'Keep going.' },
                        { type: 'refusal', refusal: 'Nope' }
                    ]
                }
            ]
        })
    }, proxyPort);

    assert.deepStrictEqual(receivedBody.input[0].content, [
        { type: 'output_text', text: 'That was a reference to Usik.' },
        { type: 'output_text', text: 'Keep going.' },
        { type: 'refusal', refusal: 'Nope' }
    ]);
});

runTest('Proxy should strip reasoning outputs', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            output: [
                {
                    id: 'rs_1',
                    type: 'reasoning',
                    content: [{ type: 'reasoning_text', text: 'Thinking...' }],
                    summary: []
                },
                {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'Done' }]
                }
            ]
        }));
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', input: [] })
    }, proxyPort);

    const json = JSON.parse(response.body);
    assert.deepStrictEqual(json.output, [
        {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done' }]
        }
    ]);
});

runTest('Proxy should preserve reasoning-only outputs', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            output: [
                {
                    id: 'rs_1',
                    type: 'reasoning',
                    content: [{ type: 'reasoning_text', text: 'Thinking...' }],
                    summary: []
                }
            ]
        }));
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', input: [] })
    }, proxyPort);

    const json = JSON.parse(response.body);
    assert.deepStrictEqual(json.output, [
        {
            id: 'rs_1',
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'Thinking...' }],
            summary: []
        }
    ]);
});

runTest('Proxy should normalize assistant response content', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            output: [
                {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        { type: 'text', text: 'That was a reference to Usik.' },
                        { type: 'reasoning_text', text: 'hidden thought' },
                        { type: 'refusal', refusal: 'Nope' }
                    ]
                }
            ]
        }));
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', input: [] })
    }, proxyPort);

    const json = JSON.parse(response.body);
    assert.deepStrictEqual(json.output[0].content, [
        { type: 'output_text', text: 'That was a reference to Usik.' },
        { type: 'refusal', refusal: 'Nope' }
    ]);
});

runTest('Proxy should inject model metadata', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [{ name: 'upstream-model' }] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({ 
        TARGET_PORT: mockUpstream.port.toString(),
        BACKEND_PORTS: mockUpstream.port.toString()
    }, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/models',
        method: 'GET'
    }, proxyPort);

    const json = JSON.parse(response.body);
    const model = json.models[0];
    assert.strictEqual(model.name, 'test-model');
});

runTest('Proxy should handle stalled upstream props requests', async ({ state, cleanup }) => {
    const mockUpstream = await startMockServer((req, res) => {
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [{ name: 'upstream-model' }] }));
            return;
        }
        if (req.url === '/props') {
            // Intentionally stall
            return;
        }
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({ 
        TARGET_PORT: mockUpstream.port.toString(),
        BACKEND_PORTS: mockUpstream.port.toString()
    }, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/models',
        method: 'GET',
        timeout: 2000
    }, proxyPort);

    assert.strictEqual(response.statusCode, 200);
    const json = JSON.parse(response.body);
    assert.strictEqual(json.models[0].name, 'test-model');
});

runTest('Proxy should honor LOG_FILE without logging request content', async ({ state, cleanup }) => {
    const logFile = path.join(os.tmpdir(), `llama-cpp-agent-proxy-log-${process.pid}-${Date.now()}.log`);
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({ LOG_FILE: logFile }, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test',
            input: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: 'super secret prompt contents' }]
                }
            ]
        })
    }, proxyPort);

    const logContents = fs.readFileSync(logFile, 'utf8');
    assert.ok(logContents.includes('Request: test'));
    assert.ok(!logContents.includes('super secret prompt contents'));
    fs.rmSync(logFile, { force: true });
});

runTest('Proxy should inject follow-up tool call when agentic response has text but no tool call', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            upstreamCallCount++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });

            if (upstreamCallCount === 1) {
                res.write('data: ' + JSON.stringify({
                    type: 'response.completed',
                    response: {
                        id: 'resp_1', object: 'response', status: 'completed', model: 'test-model',
                        output: [
                            { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
                              content: [{ type: 'output_text', text: "I'll search for the file now." }] }
                        ],
                        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
                    }
                }) + '\n\n');
            } else {
                res.write('data: ' + JSON.stringify({
                    type: 'response.completed',
                    response: {
                        id: 'resp_2', object: 'response', status: 'completed', model: 'test-model',
                        output: [
                            { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'shell', arguments: '{"command":"grep -r foo ."}' }
                        ],
                        usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 }
                    }
                }) + '\n\n');
            }
            res.end();
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    const response = await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'Find usages of foo' }] }]
        })
    }, proxyPort);

    assert.strictEqual(upstreamCallCount, 2);
    assert.ok(response.body.includes('response.output_item.added'));
    assert.ok(response.body.includes('"shell"'));
});

runTest('Proxy should not inject follow-up when response already has a tool call', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            upstreamCallCount++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'resp_1', object: 'response', status: 'completed', model: 'test-model',
                    output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}' }],
                    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 }
                }
            }) + '\n\n');
            res.end();
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'do something' }] }]
        })
    }, proxyPort);

    assert.strictEqual(upstreamCallCount, 1);
});

runTest('Proxy should not inject follow-up when no tools are registered', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            upstreamCallCount++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'resp_1', object: 'response', status: 'completed', model: 'test-model',
                    output: [
                        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
                          content: [{ type: 'output_text', text: "I'll search for the file now." }] }
                    ],
                    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 }
                }
            }) + '\n\n');
            res.end();
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', stream: true, input: [{ role: 'user', content: 'hi' }] })
    }, proxyPort);

    assert.strictEqual(upstreamCallCount, 1);
});

runTest('Proxy should not inject follow-up when model replies FINISHED', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockUpstream = await startMockServer((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            upstreamCallCount++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const output = upstreamCallCount === 1
                ? [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I'll check the backlog." }] }]
                : [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'FINISHED' }] }];
            res.write('data: ' + JSON.stringify({
                type: 'response.completed',
                response: { id: `resp_${upstreamCallCount}`, object: 'response', status: 'completed', model: 'test-model', output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } }
            }) + '\n\n');
            res.end();
        });
    });
    state.mockServers.push(mockUpstream);

    const { child: proxyProc, proxyPort, getLogs } = await startProxy({}, undefined, mockUpstream.port);
    state.proxy = proxyProc;
    state.getProxyLogs = getLogs;

    await requestProxy({
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'are we done?' }] }]
        })
    }, proxyPort);

    assert.strictEqual(upstreamCallCount, 2);
});
