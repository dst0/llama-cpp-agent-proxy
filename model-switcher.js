import fs from 'node:fs';
import { exec } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const ENV_FILE = '/etc/llama/llama-server-main.env';

export const OFFLINE_MODELS = [
    {
        id: "qwen36-35b-iq1",
        alias: "qwen36-35b-iq1",
        modelPath: "/home/dst/models/unsloth_Qwen3.6-35B-A3B-GGUF_Qwen3.6-35B-A3B-UD-IQ1_M.gguf"
    },
    {
        id: "qwen36-27b",
        alias: "qwen36-27b-q3km",
        modelPath: "/home/dst/models/unsloth/Qwen3.6-27B-Q3KM/Qwen3.6-27B-Q3_K_M.gguf"
    }
];

let isSwitching = false;
let switchPromise = null;

export async function switchModel(targetModelId, targetPort, log = console.log) {
    const targetConfig = OFFLINE_MODELS.find(m => m.id === targetModelId || m.alias === targetModelId);
    if (!targetConfig) return false;

    if (isSwitching) {
        log(`[ModelSwitcher] Waiting for ongoing switch...`);
        await switchPromise;
        return true;
    }

    isSwitching = true;
    switchPromise = (async () => {
        try {
            log(`[ModelSwitcher] Initiating switch to ${targetConfig.id}`);
            
            let envContent = '';
            try {
                envContent = fs.readFileSync(ENV_FILE, 'utf8');
            } catch (e) {
                log(`[ModelSwitcher] Warning: Could not read ${ENV_FILE}, using empty base.`);
            }

            const updateOrAdd = (content, key, value) => {
                const re = new RegExp(`^${key}=.*$`, 'm');
                if (re.test(content)) {
                    return content.replace(re, `${key}=${value}`);
                } else {
                    return content + (content.endsWith('\n') || content === '' ? '' : '\n') + `${key}=${value}\n`;
                }
            };

            envContent = updateOrAdd(envContent, 'MODEL', targetConfig.modelPath);
            envContent = updateOrAdd(envContent, 'ALIAS', targetConfig.alias);
            
            const tmpPath = path.join(process.env.HOME || '', '.llama-cpp-agent-proxy', 'env.tmp');
            fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
            fs.writeFileSync(tmpPath, envContent);
            
            await new Promise((resolve, reject) => {
                // Ensure mv succeeds before trying to restart. pkill is allowed to "fail".
                // Ensure the new env file is world-readable so the 'llama' user can read it.
                const cmd = `sudo -n mv ${tmpPath} ${ENV_FILE} && sudo -n chmod 644 ${ENV_FILE} && (sudo -n pkill -9 -f "port ${targetPort}" || true) && sudo -n systemctl restart llama-server-main`;
                exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        log(`[ModelSwitcher] Command failed. Stdout: ${stdout}, Stderr: ${stderr}`);
                        reject(err);
                    }
                    else resolve();
                });
            });
            
            log(`[ModelSwitcher] Restart triggered, waiting for health check on port ${targetPort}...`);
            
            // Wait for health endpoint to return 200
            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const isReady = await new Promise(resolve => {
                    http.get({ hostname: '127.0.0.1', port: targetPort, path: '/health', timeout: 1000 }, (res) => {
                        resolve(res.statusCode === 200);
                    }).on('error', () => resolve(false)).on('timeout', () => resolve(false));
                });
                
                if (isReady) {
                    log(`[ModelSwitcher] Model ${targetConfig.id} is now READY.`);
                    return true;
                }
            }
            throw new Error("Timeout waiting for model to load.");
        } catch (e) {
            log(`[ModelSwitcher] Failed to switch: ${e.message}`);
            return false;
        } finally {
            isSwitching = false;
            switchPromise = null;
        }
    })();
    
    await switchPromise;
    return true;
}
