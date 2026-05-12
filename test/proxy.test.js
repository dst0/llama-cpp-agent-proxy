import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

const MOCK_UPSTREAM_PORT = 11440;
const PROXY_PORT = 11441;

// Helper to start the proxy
function startProxy() {
    return spawn('node', ['index.js'], {
        env: {
            ...process.env,
            TARGET_PORT: MOCK_UPSTREAM_PORT.toString(),
            PORT: PROXY_PORT.toString(),
            LOG_FILE: 'test_proxy.log'
        }
    });
}

// Helper to start a mock upstream
function startMockUpstream(onReq) {
    const server = http.createServer(onReq);
    return new Promise((resolve) => {
        server.listen(MOCK_UPSTREAM_PORT, () => resolve(server));
    });
}

test('Proxy should flatten tool calls', async (t) => {
    let receivedBody = null;
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for proxy to start

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
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should handle streaming', async (t) => {
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"text": "Hello"}\n\n');
        setTimeout(() => {
            res.write('data: {"text": " World"}\n\n');
            res.end();
        }, 100);
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should normalize tool outputs for llama-server', async () => {
    let receivedBody = null;
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should normalize streaming assistant content', async () => {
    const mockUpstream = await startMockUpstream((req, res) => {
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

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should normalize input images for llama-server', async () => {
    let receivedBody = null;
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should preserve assistant output text for llama-server', async () => {
    let receivedBody = null;
    const mockUpstream = await startMockUpstream((req, res) => {
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: [] }));
        });
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should strip reasoning outputs', async () => {
    const mockUpstream = await startMockUpstream((req, res) => {
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

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should normalize assistant response content', async () => {
    const mockUpstream = await startMockUpstream((req, res) => {
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

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
        proxy.kill();
        mockUpstream.close();
    }
});

test('Proxy should inject model metadata', async (t) => {
    const mockUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'upstream-model' }] }));
    });

    const proxy = startProxy();
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const req = http.request({
            hostname: 'localhost',
            port: PROXY_PORT,
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
    } finally {
        proxy.kill();
        mockUpstream.close();
    }
});
