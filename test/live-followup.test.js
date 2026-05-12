import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const LIVE_PROXY_PORT = parseInt(process.env.LIVE_PROXY_PORT || '11437', 10);
const LIVE_LOG_FILE = path.resolve(process.env.LIVE_PROXY_LOG_FILE || 'proxy-full.log');
const RUN_LIVE = process.env.RUN_LIVE_PROXY_TESTS === '1';
const maybeTest = RUN_LIVE ? test : test.skip;

function requestLiveProxy(body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: LIVE_PROXY_PORT,
            path: '/v1/responses',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

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
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function waitForLogPatterns(startOffset, patterns, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const content = fs.readFileSync(LIVE_LOG_FILE, 'utf8').slice(startOffset);
        if (patterns.every(pattern => content.includes(pattern))) {
            return content;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error(`Timed out waiting for log entries containing ${patterns.join(', ')}`);
}

maybeTest('Live proxy should recover text-only agentic turns with a follow-up tool call', async () => {
    assert.ok(fs.existsSync(LIVE_LOG_FILE), `Missing live log file: ${LIVE_LOG_FILE}`);

    const startOffset = fs.statSync(LIVE_LOG_FILE).size;

    const response = await requestLiveProxy({
        model: 'gemma4-iq3s',
        stream: true,
        instructions: [
            'You are a coding agent.',
            'If you think the next step is to inspect files or run commands, first say what you will do in one short sentence and do not call a tool yet.',
            'Use the available tool only after the proxy asks you to continue.'
        ].join(' '),
        tools: [
            {
                type: 'function',
                name: 'exec_command',
                description: 'Run a shell command',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }
        ],
        input: [
            {
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: 'Investigate why POST GetCurrentIdentity returns 404. Start by examining rust/crates/tektonos-api/src/handlers/auth_service.rs.'
                }]
            }
        ]
    });

    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /response\.output_item\.done/, 'Expected streamed assistant output');
    assert.match(response.body, /response\.function_call_arguments\.delta/, 'Expected injected tool-call arguments');

    const logSlice = await waitForLogPatterns(startOffset, [
        '"type":"sse_followup"',
        '"type":"response.function_call_arguments.delta"'
    ]);
    assert.match(logSlice, /"type":"sse_followup"/, 'Expected follow-up request to be logged');
    assert.match(logSlice, /"type":"response\.function_call_arguments\.delta"/, 'Expected injected tool-call arguments');
});
