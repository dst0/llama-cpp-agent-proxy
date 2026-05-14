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
                TARGET_PORT: targetPortStr.toString(),
                PORT: proxyPortStr.toString(),
                LOG_FILE: TEST_LOG_FILE,
                ...envOverrides
            }
        });
        const wait = new Promise((ok) => {
            const check = () => {
                const req = http.get(`http://localhost:${proxyPortStr}/v1/models`, (res) => {
                    res.destroy();
                    ok();
                });
                req.on('error', () => setTimeout(check, 50));
            };
            check();
        });
        try {
            await wait;
            resolve({ child, proxyPort: proxyPortStr });
        } catch (e) {
            reject(e);
        }
    });
}

function requestProxy({ path: requestPath, method, body, headers, timeout = 0 }, proxyPort) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
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

async function runTest(name, fn) {
    test(name, async (t) => {
        console.log(`\n[TEST START] ${name}`);
        const state = { mockServers: [], proxy: null };

        const cleanup = async () => {
            if (state.proxy) {
                try { state.proxy.kill('SIGKILL'); } catch {}
            }
            for (const ms of state.mockServers) {
                try { ms.close(); } catch {}
            }
        };

        process.on('exit', () => cleanup());

        try {
            await fn({ state, cleanup });
        } finally {
            await cleanup();
        }
    });
}

runTest('Proxy should flatten tool calls', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    }, mockPort);
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
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

        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify(payload));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        assert.strictEqual(receivedBody.tools[0].name, 'get_weather');
        assert.strictEqual(receivedBody.tools[0].type, 'function');
        assert.strictEqual(receivedBody.tools[0].function, undefined);
    } finally {
    }
});

runTest('Proxy should handle streaming', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }, mockPort, mockPort, mockPort);
        res.write('data: {"text": "Hello"}\n\n');
        setTimeout(() => {
            res.write('data: {"text": " World"}\n\n');
            res.end();
        }, 100);
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({ model: 'test', stream: true, input: [] }));
        req.end();

        const chunks = [];
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => chunks.push(chunk.toString()));
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        const fullResponse = chunks.join('');
        assert.ok(fullResponse.includes('Hello'));
        assert.ok(fullResponse.includes('World'));
    } finally {
    }
});

runTest('Proxy should normalize tool outputs for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    }, mockPort);
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({
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
        }));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

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
    } finally {
    }
});

runTest('Proxy should preserve input_text parts for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
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
    } finally {
    }
});

runTest('Proxy should preserve function_call items for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
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
    } finally {
    }
});

runTest('Proxy should drop reasoning-only assistant turns before forwarding', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
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
    } finally {
    }
});

runTest('Proxy should normalize streaming assistant content', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }, mockPort, mockPort, mockPort);
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({ model: 'test', stream: true, input: [] }));
        req.end();

        let body = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => body += chunk.toString());
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        assert.ok(body.includes('output_text'));
        assert.ok(body.includes('Hello from stream'));
        assert.ok(!body.includes('reasoning_text'));
    } finally {
    }
});

runTest('Proxy should normalize input images for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    }, mockPort);
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({
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
        }));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        assert.deepStrictEqual(receivedBody.input[0].content, [
            { type: 'input_image', image_url: 'http://example.com/test.png' },
            { type: 'input_text', text: 'Describe this image' }
        ]);
    } finally {
    }
});

runTest('Proxy should preserve assistant output text for llama-server', async ({ state, cleanup }) => {
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    }, mockPort);
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({
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
        }));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        assert.deepStrictEqual(receivedBody.input[0].content, [
            { type: 'output_text', text: 'That was a reference to Usik.' },
            { type: 'output_text', text: 'Keep going.' },
            { type: 'refusal', refusal: 'Nope' }
        ]);
    } finally {
    }
});

runTest('Proxy should strip reasoning outputs', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }, mockPort, mockPort, mockPort);
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({ model: 'test', input: [] }));
        req.end();

        let data = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => data += chunk);
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        const json = JSON.parse(data);
        assert.deepStrictEqual(json.output, [
            {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Done' }]
            }
        ]);
    } finally {
    }
});

runTest('Proxy should preserve reasoning-only outputs', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }, mockPort, mockPort, mockPort);
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({ model: 'test', input: [] }));
        req.end();

        let data = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => data += chunk);
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        const json = JSON.parse(data);
        assert.deepStrictEqual(json.output, [
            {
                id: 'rs_1',
                type: 'reasoning',
                content: [{ type: 'reasoning_text', text: 'Thinking...' }],
                summary: []
            }
        ]);
    } finally {
    }
});

runTest('Proxy should normalize assistant response content', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }, mockPort, mockPort, mockPort);
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        req.write(JSON.stringify({ model: 'test', input: [] }));
        req.end();

        let data = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => data += chunk);
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        const json = JSON.parse(data);
        assert.deepStrictEqual(json.output[0].content, [
            { type: 'output_text', text: 'That was a reference to Usik.' },
            { type: 'refusal', refusal: 'Nope' }
        ]);
    } finally {
    }
});

runTest('Proxy should inject model metadata', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }, mockPort, mockPort, mockPort);
        res.end(JSON.stringify({ models: [{ name: 'upstream-model' }] }));
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/models',
            method: 'GET'
        });
        req.end();

        let data = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.on('data', chunk => data += chunk);
                res.on('end', resolve);
            });
            req.on('error', reject);
        });

        const json = JSON.parse(data);
        const model = json.models[0];
        assert.strictEqual(model.name, 'upstream-model');
        assert.strictEqual(model.display_name, 'upstream-model');
        assert.strictEqual(model.slug, 'upstream-model');
        assert.ok(model.supported_reasoning_levels);
        assert.ok(model.truncation_policy, 'Model should have truncation_policy');
        assert.strictEqual(model.truncation_policy.type, 'auto');
    } finally {
    }
});

runTest('Proxy should handle stalled upstream props requests', async ({ state, cleanup }) => {
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' }, mockPort, mockPort, mockPort);
            res.end(JSON.stringify({ models: [{ name: 'upstream-model' }] }));
            return;
        }

        if (req.url === '/props') {
            return;
        }

        res.writeHead(404);
        res.end();
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const response = await requestProxy({
            path: '/v1/models',
            method: 'GET',
            timeout: 1500
        }, proxyPort);

        assert.strictEqual(response.statusCode, 200);
        const json = JSON.parse(response.body);
        assert.strictEqual(json.models[0].name, 'upstream-model');
        assert.strictEqual(json.models[0].display_name, 'upstream-model');
    } finally {
    }
});

runTest('Proxy should honor LOG_FILE without logging request content', async ({ state, cleanup }) => {
    const logFile = path.join(os.tmpdir(), `llama-cpp-agent-proxy-log-${process.pid}-${Date.now()}.log`);
    let receivedBody = null;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);

    const { child: proxyProc, proxyPort } = await startProxy({ LOG_FILE: logFile }, undefined, mockPort);
    state.proxy = proxyProc;

    try {
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

        assert.ok(receivedBody);
        const logContents = fs.readFileSync(logFile, 'utf8');
        assert.ok(logContents.includes('Request: test'));
        assert.ok(!logContents.includes('super secret prompt contents'));
    } finally {
        proxyProc.kill();
        mock11438.close();
        mockUpstream.close();
        fs.rmSync(logFile, { force: true });
    }
});

runTest('Proxy should inject follow-up tool call when agentic response has text but no tool call', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.write(JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'Find usages of foo' }] }]
        }));
        req.end();

        let body = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => { res.on('data', c => { body += c.toString(); }); res.on('end', resolve); });
            req.on('error', reject);
        });

        assert.strictEqual(upstreamCallCount, 2, 'Expected proxy to make a follow-up request');
        assert.ok(body.includes('response.output_item.added'), 'Expected output_item.added event');
        assert.ok(body.includes('response.function_call_arguments.delta'), 'Expected arguments delta event');
        assert.ok(body.includes('response.output_item.done'), 'Expected output_item.done event');
        assert.ok(body.includes('"shell"'), 'Expected function call name');
        assert.ok(body.includes('"fc_1"'), 'Expected function call id');

        const lines = body.split('\n').filter(l => l.startsWith('data: '));
        const completedLine = [...lines].reverse().find(l => {
            try { return JSON.parse(l.slice(5)).type === 'response.completed'; } catch { return false; }
        });
        assert.ok(completedLine, 'Expected response.completed event');
        const completed = JSON.parse(completedLine.slice(5));
        const outputTypes = completed.response.output.map(i => i.type);
        assert.ok(outputTypes.includes('message'), 'Expected message in merged output');
        assert.ok(outputTypes.includes('function_call'), 'Expected function_call in merged output');
    } finally {
    }
});

runTest('Proxy should not inject follow-up when response already has a tool call', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.write(JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'do something' }] }]
        }));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', reject);
        });

        assert.strictEqual(upstreamCallCount, 1, 'Should not make follow-up when tool call already present');
    } finally {
    }
});

runTest('Proxy should not inject follow-up when no tools are registered', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.write(JSON.stringify({ model: 'test-model', stream: true, input: [{ role: 'user', content: 'hi' }] }));
        req.end();

        await new Promise((resolve, reject) => {
            req.on('response', (res) => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', reject);
        });

        assert.strictEqual(upstreamCallCount, 1, 'Should not make follow-up when no tools registered');
    } finally {
    }
});

runTest('Proxy should not inject follow-up when model replies FINISHED', async ({ state, cleanup }) => {
    let upstreamCallCount = 0;
    const mockPort = await getAvailablePort();
    const mockUpstream = await startMockUpstream((req, res) => {
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
    state.mockServers.push(mockUpstream.server);
    const mock11438 = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', models: [{ name: 'test-model' }] }));
    }, 11438);
    state.mockServers.push(mock11438.server);

    const { child: proxyProc, proxyPort } = await startProxy({}, undefined, mockPort);
    state.proxy = proxyProc;

    try {
        const req = http.request({
            hostname: 'localhost',
            port: proxyPort,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.write(JSON.stringify({
            model: 'test-model', stream: true,
            tools: [{ type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'are we done?' }] }]
        }));
        req.end();

        let body = '';
        await new Promise((resolve, reject) => {
            req.on('response', (res) => { res.on('data', c => { body += c; }); res.on('end', resolve); });
            req.on('error', reject);
        });

        assert.strictEqual(upstreamCallCount, 2, 'Should make follow-up when text-only');
        const lines = body.split('\n').filter(l => l.startsWith('data: '));
        const completedLine = [...lines].reverse().find(l => {
            try { return JSON.parse(l.slice(5)).type === 'response.completed'; } catch { return false; }
        });
        assert.ok(completedLine, 'Expected response.completed');
        const completed = JSON.parse(completedLine.slice(5));
        assert.ok(!completed.response.output.some(i => i.type === 'function_call'), 'Should not inject FC when FINISHED');
    } finally {
    }
});
