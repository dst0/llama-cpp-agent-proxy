import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function writeExecutable(filePath, contents) {
    fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function waitForExit(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve({ code: child.exitCode, signal: child.signalCode });
            return;
        }

        const timer = setTimeout(() => reject(new Error(`Timed out waiting for pid ${child.pid} to exit`)), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}

function runScript(scriptPath, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [scriptPath, '--service-name', 'llama-cpp-agent-proxy-test'], {
            cwd: ROOT_DIR,
            env
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => stdout += chunk.toString());
        child.stderr.on('data', chunk => stderr += chunk.toString());
        child.on('error', reject);
        child.on('exit', code => resolve({ code, stdout, stderr }));
    });
}

test('install-service reinstall stops, kills, and starts systemd service on Linux', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-cpp-agent-proxy-install-'));
    const mockBinDir = path.join(tempDir, 'bin');
    const systemctlLogPath = path.join(tempDir, 'systemctl.log');
    fs.mkdirSync(mockBinDir, { recursive: true });

    writeExecutable(path.join(mockBinDir, 'uname'), '#!/usr/bin/env bash\necho Linux\n');
    writeExecutable(
        path.join(mockBinDir, 'systemctl'),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG_PATH"\nexit 0\n'
    );
    writeExecutable(
        path.join(mockBinDir, 'ps'),
        '#!/usr/bin/env bash\nprintf " %s /usr/bin/node %s/index.js\\n" "$TEST_PROXY_PID" "$TEST_ROOT_DIR"\n'
    );

    const proxyProcess = spawn('sleep', ['1000']);

    try {
        const result = await runScript(path.join(ROOT_DIR, 'scripts/install-service.sh'), {
            ...process.env,
            HOME: tempDir,
            PATH: `${mockBinDir}:${process.env.PATH}`,
            SYSTEMCTL_LOG_PATH: systemctlLogPath,
            TEST_PROXY_PID: String(proxyProcess.pid),
            TEST_ROOT_DIR: ROOT_DIR
        });

        assert.strictEqual(result.code, 0, result.stderr);

        const exit = await waitForExit(proxyProcess);
        assert.strictEqual(exit.signal, 'SIGTERM');

        const systemctlCalls = fs.readFileSync(systemctlLogPath, 'utf8').trim().split('\n');
        assert.deepStrictEqual(systemctlCalls, [
            '--user stop llama-cpp-agent-proxy-test.service',
            '--user daemon-reload',
            '--user enable llama-cpp-agent-proxy-test.service',
            '--user start llama-cpp-agent-proxy-test.service',
            '--user is-active --quiet llama-cpp-agent-proxy-test.service'
        ]);

        const unitPath = path.join(tempDir, '.config/systemd/user/llama-cpp-agent-proxy-test.service');
        assert.ok(fs.existsSync(unitPath));
        assert.ok(fs.readFileSync(unitPath, 'utf8').includes(`${ROOT_DIR}/index.js`));
    } finally {
        proxyProcess.kill('SIGTERM');
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
