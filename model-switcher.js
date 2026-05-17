import fs from 'node:fs';
import { exec } from 'node:child_process';
import http from 'node:http';

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
            
            let envContent = fs.readFileSync(ENV_FILE, 'utf8');
            envContent = envContent.replace(/^MODEL=.*$/m, `MODEL=${targetConfig.modelPath}`);
            envContent = envContent.replace(/^ALIAS=.*$/m, `ALIAS=${targetConfig.alias}`);
            
            fs.writeFileSync('/tmp/llama-server-main.env.tmp', envContent);
            
            await new Promise((resolve, reject) => {
                exec(`sudo -n mv /tmp/llama-server-main.env.tmp ${ENV_FILE} && sudo -n pkill -9 -f "port ${targetPort}" && sudo -n systemctl restart llama-server-main`, (err) => {
                    if (err) reject(err);
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
