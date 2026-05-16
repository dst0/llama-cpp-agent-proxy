
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PROXY_PATH = path.resolve('index.js');

test('Proxy /v1/status API endpoint', async (t) => {
    const proxyPort = 11440;
    const targetPort = 11441;
    const statusFile = path.join(os.tmpdir(), `test-proxy-${proxyPort}.status`);
    
    if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);

    const proxy = spawn('node', [PROXY_PATH], {
        env: {
            ...process.env,
            PORT: proxyPort.toString(),
            TARGET_PORT: targetPort.toString(),
            BACKEND_PORTS: targetPort.toString(),
            STATUS_FILE: statusFile,
            TITLE_MODEL: 'none'
        }
    });

    // Wait for proxy to start
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            proxy.kill();
            reject(new Error('Proxy timed out starting'));
        }, 5000);

        const check = () => {
            http.get(`http://127.0.0.1:${proxyPort}/v1/status`, (res) => {
                if (res.statusCode === 200) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
                res.resume();
            }).on('error', () => {
                setTimeout(check, 100);
            });
        };
        check();
    });

    await t.test('returns status as JSON', async () => {
        const res = await new Promise((resolve) => {
            http.get(`http://127.0.0.1:${proxyPort}/v1/status`, resolve);
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-type'], 'application/json');

        const body = await new Promise((resolve) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });

        assert.ok(body.timestamp);
        assert.strictEqual(typeof body.active_requests, 'number');
        assert.ok(Array.isArray(body.backends));
        assert.strictEqual(body.backends[0].port, targetPort);
    });

    // Cleanup
    proxy.kill();
    if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);
});
