import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { OFFLINE_MODELS, switchModel } from './model-switcher.js';

// --- Initialization sequence ---

// 1. Basic Paths & Static Env
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.env.HOME || '', '.llama-cpp-agent-proxy', 'config.toml');

// 2. Pre-load config.toml for port defaults (before const declarations)
let _tomlPorts = null;
let _tomlNonStopPorts = null;
let _tomlTargetHost = null;
let _tomlTargetPort = null;
try {
    if (fs.existsSync(CONFIG_PATH)) {
        const _parsed = parseToml(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (_parsed.network) {
            _tomlPorts = Array.isArray(_parsed.network.ports) ? _parsed.network.ports : null;
            _tomlNonStopPorts = Array.isArray(_parsed.network.non_stop_ports) ? _parsed.network.non_stop_ports : null;
            _tomlTargetHost = _parsed.network.target_host || null;
            _tomlTargetPort = _parsed.network.target_port || null;
        }
    }
} catch {}

// 3. Mutable configuration variables (will be updated by loadConfig)
let TARGET_HOST = process.env.TARGET_HOST || _tomlTargetHost || '127.0.0.1';
let TARGET_PORT = parseInt(process.env.TARGET_PORT || (_tomlTargetPort ? _tomlTargetPort.toString() : null) || '11435', 10);

const LISTEN_PORTS = (process.env.PORT || process.env.PORTS || (_tomlPorts ? _tomlPorts.join(',') : '11450,11451')).split(',').map(p => parseInt(p.trim(), 10));
const NON_STOP_PORTS = (process.env.NON_STOP_PORTS || (process.env.NON_STOP_MODE === 'true' ? process.env.PORT : null) || (_tomlNonStopPorts ? _tomlNonStopPorts.join(',') : '11451') || '').split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

const PROXY_PORT_PRIMARY = LISTEN_PORTS[0] || 11450;
const DEFAULT_LOG_DIR = `~/.llama-cpp-agent-proxy/logs/${PROXY_PORT_PRIMARY}`.replace('~', process.env.HOME || '');
const LOG_DIR = (process.env.LOG_DIR || DEFAULT_LOG_DIR).replace('~', process.env.HOME || '');
const LOG_FILE = (process.env.LOG_FILE || `${LOG_DIR}/proxy.log`).replace('~', process.env.HOME || '');
const FULL_LOG_FILE = (process.env.FULL_LOG_FILE || `${LOG_DIR}/proxy-full.log`).replace('~', process.env.HOME || '');
const STATUS_FILE = (process.env.STATUS_FILE || `${LOG_DIR}/proxy.status`).replace('~', process.env.HOME || '');
const TITLE_MODEL = process.env.TITLE_MODEL || 'qwen2.5-0.5b';

// Global mutable config state
let configState = {
    redirects: [
        {
            host: process.env.BUSY_REDIRECT_HOST || '192.168.8.234',
            port: parseInt(process.env.BUSY_REDIRECT_PORT || '1234'),
            model: process.env.BUSY_REDIRECT_MODEL || 'gemma-4-e4b-it-mlx@4bit',
            api_key: process.env.BUSY_REDIRECT_API_KEY || '',
            available: false
        }
    ],
    backends: {
        monitor_enabled: process.env.MONITOR_ENABLED !== 'false'
    }
};

// 3. Logger setup (needs LOG_FILE initialized)
function writeLog(filePath, line) {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] ${line}\n`;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, formatted);
    } catch (e) {
        console.error(`[Logger] Failed to write to ${filePath}: ${e.message}`);
    }
}
function log(msg) { console.log(msg); writeLog(LOG_FILE, msg); }
function error(msg) { console.error(msg); writeLog(LOG_FILE, `ERROR: ${msg}`); }

let lastConfigHash = '';

// 4. Configuration Loader
function loadConfig() {
    try {
        const isFirstLoad = configState.redirects.length === 0 || !configState.redirects[0].host; // rough check
        if (!fs.existsSync(CONFIG_PATH)) {
            const defaultConfig = {
                network: {
                    target_host: TARGET_HOST,
                    target_port: TARGET_PORT,
                    ports: LISTEN_PORTS,
                    non_stop_ports: NON_STOP_PORTS
                },
                backends: {
                    ports: [11435, 1234],
                    services: ["llama-server-main", "lms-micro"],
                    monitor_enabled: configState.backends.monitor_enabled
                },
                redirects: configState.redirects.map(r => ({ host: r.host, port: r.port, model: r.model, api_key: r.api_key })),
                logging: {
                    dir: LOG_DIR
                }
            };
            
            let tomlStr = `# llama-cpp-agent-proxy configuration\n\n` + 
                `[network]\ntarget_host = "${defaultConfig.network.target_host}"\ntarget_port = ${defaultConfig.network.target_port}\nports = ${JSON.stringify(defaultConfig.network.ports)}\nnon_stop_ports = ${JSON.stringify(defaultConfig.network.non_stop_ports)}\n\n` +
                `[backends]\nports = ${JSON.stringify(defaultConfig.backends.ports)}\nservices = ${JSON.stringify(defaultConfig.backends.services)}\nmonitor_enabled = ${defaultConfig.backends.monitor_enabled}\n\n`;
            
            defaultConfig.redirects.forEach(r => {
                tomlStr += `[[redirects]]\nhost = "${r.host}"\nport = ${r.port}\nmodel = "${r.model}"\napi_key = "${r.api_key}"\n\n`;
            });

            tomlStr += `[logging]\ndir = "${defaultConfig.logging.dir}"\n`;
            
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
            fs.writeFileSync(CONFIG_PATH, tomlStr);
            if (isFirstLoad) console.log(`[Config] Created default configuration at ${CONFIG_PATH}`);
            else log(`[Config] Created default configuration at ${CONFIG_PATH}`);
        }

        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (raw === lastConfigHash && !isFirstLoad) return;
        lastConfigHash = raw;

        const parsed = parseToml(raw);
        
        // Update mutable parts of config (Env takes precedence)
        if (parsed.network) {
            TARGET_HOST = process.env.TARGET_HOST || parsed.network.target_host || TARGET_HOST;
            TARGET_PORT = parseInt(process.env.TARGET_PORT || (parsed.network.target_port ? parsed.network.target_port.toString() : null) || TARGET_PORT.toString(), 10);
        }
        
        if (parsed.redirects && Array.isArray(parsed.redirects)) {
            // Merge existing availability into reloaded config
            configState.redirects = parsed.redirects.map(r => {
                const existing = configState.redirects.find(er => er.host === r.host && er.port === r.port);
                return {
                    host: r.host,
                    port: r.port,
                    model: r.model,
                    api_key: r.api_key || '',
                    available: existing ? existing.available : false
                };
            });
        } else if (parsed.redirect) {
            // Legacy single redirect support
            configState.redirects = [{
                host: parsed.redirect.host,
                port: parsed.redirect.port,
                model: parsed.redirect.model,
                api_key: parsed.redirect.api_key || '',
                available: configState.redirects[0]?.available || false
            }];
        }

        if (parsed.backends && typeof parsed.backends.monitor_enabled === 'boolean') {
            configState.backends.monitor_enabled = parsed.backends.monitor_enabled;
        }
        
        if (isFirstLoad) console.log(`[Config] Loaded configuration from ${CONFIG_PATH}`);
        else log(`[Config] Loaded configuration from ${CONFIG_PATH}`);
    } catch (e) {
        console.error(`[Config] Failed to load config: ${e.message}`);
    }
}

// Initial load
loadConfig();

// Reload every minute
setInterval(loadConfig, 60000).unref();

// Use configState for derived values
const getRedirects = () => configState.redirects;
const isMonitorEnabled = () => configState.backends.monitor_enabled;

function getModelSize(modelName) {
    const match = modelName.match(/(\d+\.?\d*)[bB]/);
    return match ? parseFloat(match[1]) : 0;
}

function pickBestRedirect() {
    const available = configState.redirects.filter(r => r.available);
    if (available.length === 0) return null;
    
    // Sort by model size descending
    return available.sort((a, b) => getModelSize(b.model) - getModelSize(a.model))[0];
}

// Backend config: host:port:service:logFile (logFile optional) or just port
const BACKEND_CONFIGS = (process.env.BACKEND_CONFIGS || process.env.BACKEND_PORTS || `${TARGET_HOST}:${TARGET_PORT}:llama-server:/opt/llama/logs/main-stderr.log`).split(',').map(entry => {
    const parts = entry.trim().split(':');
    if (parts.length === 1 && !isNaN(parseInt(parts[0], 10))) {
        return { host: TARGET_HOST, port: parseInt(parts[0], 10), service: 'llama-server', logFile: null };
    }
    const [host, port, service, logFile] = parts;
    return { host: host || TARGET_HOST, port: parseInt(port, 10), service: service || 'llama-server', logFile: logFile || null };
}).filter(b => !isNaN(b.port));

// Derived for backward compatibility
const BACKEND_PORTS = BACKEND_CONFIGS.map(b => b.port);
const BACKEND_SERVICES = BACKEND_CONFIGS.map(b => b.service);
const BACKEND_LOG_FILES = BACKEND_CONFIGS.map(b => b.logFile || '');

if (!process.env.TARGET_PORT && BACKEND_PORTS.length > 0) {
    TARGET_PORT = BACKEND_PORTS[0];
}

let lastTitle = 'Idle';
let lastTitleText = '';
const activeRedirectRequestsPerTarget = new Map();
const activeRequestsPerPort = new Map();
const backendHTTPActivity = new Map();
BACKEND_PORTS.forEach(p => backendHTTPActivity.set(p, { prefilling: 0, generating: 0 }));
const backendStatuses = BACKEND_CONFIGS.map(b => ({ ...b, status: 'IDLE', progress: undefined, model: undefined }));
const modelPortCache = new Map();
const sseClients = new Set();

class BackendQueue {
    constructor(port, maxParallel = 1) {
        this.port = port;
        this.activeCount = 0;
        this.maxParallel = maxParallel;
        this.waiting = [];
    }

    async acquire() {
        if (this.activeCount < this.maxParallel) {
            this.activeCount++;
            updateStatusFile();
            let released = false;
            return () => { if (!released) { released = true; this.release(); } };
        }
        return new Promise(resolve => {
            this.waiting.push(resolve);
            updateStatusFile();
        }).then(() => {
            // resolve() was called, so slot is already passed to us
            let released = false;
            return () => { if (!released) { released = true; this.release(); } };
        });
    }

    release() {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift();
            // Pass the slot directly to the next waiter
            next();
        } else {
            this.activeCount = Math.max(0, this.activeCount - 1);
            updateStatusFile();
        }
    }

    get active() { return this.activeCount > 0; }
    get size() { return this.waiting.length; }
}

const backendQueues = new Map();
BACKEND_PORTS.forEach(p => {
    // Standardize on 1 slot per backend due to VRAM constraints
    const maxParallel = 1;
    backendQueues.set(p, new BackendQueue(p, maxParallel));
});

// Virtual "all" model queue: routes to least-loaded backend
class VirtualQueue {
    constructor(configs) {
        this.configs = configs;
        this.activeCount = 0;
        this.maxParallel = configs.reduce((sum, b) => sum + (backendQueues.get(b.port)?.maxParallel || 1), 0);
        this.waiting = [];
    }

    async acquire() {
        if (this.activeCount < this.maxParallel) {
            const backend = this.pickBackend();
            this.activeCount++;
            updateStatusFile();
            const bq = backendQueues.get(backend.port);
            const bqRelease = await bq.acquire();
            let released = false;
            return {
                tHost: backend.host,
                tPort: backend.port,
                release: () => {
                    if (released) return;
                    released = true;
                    bqRelease();
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this.dispatchNext();
                    updateStatusFile();
                }
            };
        }
        return new Promise(resolve => {
            this.waiting.push(resolve);
            updateStatusFile();
        });
    }

    pickBackend() {
        let best = null, bestLoad = Infinity;
        for (const b of this.configs) {
            const q = backendQueues.get(b.port);
            const load = (q ? q.activeCount + q.size : 0) +
                        (backendHTTPActivity.get(b.port)?.generating || 0) +
                        (backendHTTPActivity.get(b.port)?.prefilling || 0);
            if (load < bestLoad) { bestLoad = load; best = b; }
        }
        return best;
    }

    dispatchNext() {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift();
            this.acquire().then(next);
        }
    }

    get active() { return this.activeCount > 0; }
    get size() { return this.waiting.length; }
}

const virtualQueue = new VirtualQueue(BACKEND_CONFIGS);
backendQueues.set('all', virtualQueue);

const PROMPT_PROGRESS_RE = /prompt processing,.*?(?:progress\s*=\s*([\d.]+)|([\d.]+)\s*%)/i;

function startLogWatcher() {
    const LOG_FILES = BACKEND_LOG_FILES;
    for (let i = 0; i < BACKEND_CONFIGS.length; i++) {
        const port = BACKEND_CONFIGS[i].port;
        const logFile = LOG_FILES[i];
        if (!port || !logFile) continue;

        const tail = spawn('tail', ['-n', '0', '-F', logFile]);
        tail.on('error', (err) => {
            console.error(`[LogWatcher] Failed to spawn tail for ${logFile}: `, err.message);
        });
        tail.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            let updated = false;
            for (const line of lines) {
                const match = line.match(PROMPT_PROGRESS_RE);
                if (match) {
                    const progress = match[1] !== undefined ? Number.parseFloat(match[1]) : Number.parseFloat(match[2]) / 100;
                    const b = backendStatuses.find(b => b.port === port);
                    if (b) { b.progress = progress; updated = true; }
                } else if (line.includes('llama_print_timings')) {
                    const b = backendStatuses.find(b => b.port === port);
                    if (b) { b.progress = undefined; updated = true; }
                }
            }
            if (updated) updateStatusFile();
        });
    }
}
startLogWatcher();

function getStatus() {
    let prefillProgress = undefined;
    const backends = backendStatuses.map(b => {
        const q = backendQueues.get(b.port);
        let status = b.status;
        
        // Derive detailed status for the "trio" (READY/PREFILL/GEN)
        if (status === 'READY' || status === 'BUSY' || status === 'IDLE') {
            const httpAct = backendHTTPActivity.get(b.port);
            if (httpAct && httpAct.prefilling > 0) {
                status = 'PREFILL';
            } else if (httpAct && httpAct.generating > 0) {
                status = 'GEN';
            } else {
                status = 'READY';
            }
        }
        
        if (status === 'PREFILL' && b.progress !== undefined && b.progress > 0) {
            if (prefillProgress === undefined || b.progress > prefillProgress) prefillProgress = b.progress;
        }
        return { 
            ...b, 
            status, 
            display: `${b.host} → ${b.model || 'None'}`,
            progress: b.progress !== undefined ? b.progress : (status === 'PREFILL' ? 0 : undefined),
            prefill_percent: b.progress !== undefined ? Math.round(b.progress * 100) : (status === 'PREFILL' ? 0 : undefined),
            active_count: q?.activeCount || 0,
            max_parallel: q?.maxParallel || 0,
            queue_size: q?.size || 0
        };
    });

    const portsStatus = {};
    LISTEN_PORTS.forEach(p => {
        const active = activeRequestsPerPort.get(p) || 0;
        portsStatus[p] = { active };
    });

    const queuesStatus = {};
    let totalQueueSize = 0;
    backendQueues.forEach((q, p) => {
        queuesStatus[p] = { 
            size: q.size, 
            active: q.active, 
            active_count: q.activeCount, 
            max_parallel: q.maxParallel 
        };
        if (p !== 'all') totalQueueSize += q.size;
    });

    const bestRedirect = pickBestRedirect();

    return {
        active_requests: Array.from(activeRequestsPerPort.values()).reduce((a, b) => a + b, 0),
        queue_size: totalQueueSize,
        virtual_queue: { 
            model: 'all', 
            size: virtualQueue.size, 
            active: virtualQueue.active, 
            active_count: virtualQueue.activeCount,
            max_parallel: virtualQueue.maxParallel 
        },
        redirect_server: bestRedirect ? {
            host: bestRedirect.host,
            port: bestRedirect.port,
            model: bestRedirect.model,
            display: `${bestRedirect.host} → ${bestRedirect.model}`,
            available: true,
            active_requests: activeRedirectRequestsPerTarget.get(`${bestRedirect.host}:${bestRedirect.port}:${bestRedirect.model}`) || 0
        } : { available: false },
        redirects: configState.redirects.map(r => {
            const key = `${r.host}:${r.port}:${r.model}`;
            return { 
                host: r.host, 
                port: r.port, 
                model: r.model, 
                display: `${r.host} → ${r.model}`,
                available: r.available,
                active_requests: activeRedirectRequestsPerTarget.get(key) || 0
            };
        }),
        ports: portsStatus,
        queues: queuesStatus,
        last_title: lastTitle,
        prefill_progress: prefillProgress,
        backends: backends,
        timestamp: new Date().toISOString()
    };
}

// SSE broadcast interval (5 times per second = 200ms)
const BROADCAST_INTERVAL = 200;

function broadcastStatus(status) {
    const data = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
    const dead = [];
    for (const client of sseClients) {
        try { client.write(data); } catch (e) { dead.push(client); }
    }
    for (const client of dead) sseClients.delete(client);
}

// Start 5Hz broadcast timer
setInterval(() => {
    if (sseClients.size > 0) {
        broadcastStatus(getStatus());
    }
}, BROADCAST_INTERVAL).unref();

// SSE heartbeat: send comment lines every 15s to prevent proxy idle-timeout kills
const SSE_HEARTBEAT_INTERVAL = 15000;
let sseHeartbeatTimer = null;
function startSseHeartbeat() {
    if (sseHeartbeatTimer) return;
    sseHeartbeatTimer = setInterval(() => {
        const data = ': heartbeat\n\n';
        for (const client of sseClients) {
            try { client.write(data); } catch (e) {}
        }
    }, SSE_HEARTBEAT_INTERVAL).unref();
}
function stopSseHeartbeat() {
    if (sseHeartbeatTimer) {
        clearInterval(sseHeartbeatTimer);
        sseHeartbeatTimer = null;
    }
}

function updateStatusFile() {
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(getStatus(), null, 2));
    } catch {}
}

const MODEL_TEMPLATE = {
    id: "llama-server",
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "llama.cpp",
    capabilities: ["completion"],
    supported_reasoning_levels: ["none", "low", "medium", "high"]
};

async function getUpstreamProps(config) {
    return new Promise((resolve) => {
        const req = http.request({ hostname: config.host, port: config.port, path: '/props', method: 'GET', timeout: 2000 }, (res) => {
            let data = ''; res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve({}); }
            });
        });
        req.on('error', () => resolve({}));
        req.on('timeout', () => { req.destroy(); resolve({}); });
        req.end();
    });
}

function normalizeRequestJson(json) {
    if (json.tools && Array.isArray(json.tools)) {
        json.tools = json.tools.map(tool => {
            if (tool.type === 'function') {
                // OpenAI-compatible backends (like llama.cpp) REQUIRE the nested "function" object.
                // Do NOT flatten this structure, or the backend will return a 500 "Missing tool function" error.
                if (tool.function) return tool; // Keep nested
                if (tool.name) {
                    // Nest flat tool from other formats into the required "function" structure
                    return {
                        type: 'function',
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.parameters
                        }
                    };
                }
            }
            return tool;
        });
    }

    const normalizeContent = (content, role = 'user') => {
        // llama.cpp is strict about content types. It expects "text" for text content.
        // Using non-standard types like "input_text" or "output_text" results in 400 "unsupported content[].type".
        if (typeof content === 'string') return [{ type: 'text', text: content }];
        if (Array.isArray(content)) {
            return content.map(item => {
                if (item.type === 'text' || item.type === 'output_text' || item.type === 'input_text') {
                    return { type: 'text', text: item.text };
                }
                if (item.type === 'input_image') return { type: 'input_image', image_url: item.image_url?.url || item.image_url };
                // Map other types (e.g. reasoning) to a safe default if needed or filter
                if (item.type === 'reasoning_text' || item.type === 'reasoning') return null;
                return { type: 'text', text: typeof item.text === 'string' ? item.text : '' };
            }).filter(item => item !== null);
        }
        return [{ type: 'text', text: '' }];
    };

    if (json.messages && Array.isArray(json.messages)) {
        json.messages = json.messages.filter(m => {
            if (m.role === 'assistant' && Array.isArray(m.content)) {
                return m.content.some(item => item.type !== 'reasoning_text' && item.type !== 'reasoning');
            }
            return true;
        }).map(m => ({
            ...m,
            content: normalizeContent(m.content, m.role)
        }));
    }

    if (json.input && Array.isArray(json.input)) {
        json.input = json.input.filter(item => {
            if (item.role === 'assistant' && Array.isArray(item.content)) {
                return item.content.some(c => c.type !== 'reasoning_text' && c.type !== 'reasoning');
            }
            return true;
        }).map(item => {
            if (item.type === 'function_call_output') {
                return { ...item, output: normalizeContent(item.output, 'tool') }; // tool output is normalized to "text"
            }
            if (item.role === 'tool') {
                return { type: 'function_call_output', call_id: item.tool_call_id, output: normalizeContent(item.content, 'tool') };
            }
            if (item.role === 'user' || item.role === 'assistant') {
                return { type: 'message', role: item.role, content: normalizeContent(item.content, item.role) };
            }
            return item;
        });
    }

    return json;
}

function normalizeResponseJson(json) {
    const normalizeMsg = (msg) => {
        if (!msg || msg.content === undefined) return msg;
        
        let content = msg.content;
        let items = [];
        if (typeof content === 'string') {
            if (content.length > 0 || !msg.tool_calls) {
                items.push({ type: 'output_text', text: content });
            }
        } else if (Array.isArray(content)) {
            items = content.map(item => {
                if (item.type === 'text' || item.type === 'output_text') return { type: 'output_text', text: item.text };
                return item;
            }).filter(item => item.type !== 'reasoning_text' && item.type !== 'reasoning');
        }

        // Preserve reasoning_content if present (common in some llama.cpp forks/models)
        if (msg.reasoning_content && !items.some(i => i.type === 'reasoning')) {
            items.unshift({ type: 'reasoning', text: msg.reasoning_content });
        }

        return { ...msg, content: items };
    };

    if (json.choices) {
        json.choices = json.choices.map(c => {
            const msg = c.message || c.delta;
            if (!msg) return c;
            return {
                ...c,
                [c.message ? 'message' : 'delta']: normalizeMsg(msg)
            };
        });
    }

    const processOutput = (output) => {
        if (!Array.isArray(output)) return output;
        const hasMessage = output.some(item => item.type === 'message');
        return output.filter(item => {
            if (item.type === 'reasoning' && hasMessage) return false;
            return true;
        }).map(item => {
            if (item.type === 'message') {
                return normalizeMsg(item);
            }
            return item;
        });
    };

    if (json.output) {
        json.output = processOutput(json.output);
    }
    if (json.response?.output) {
        json.response.output = processOutput(json.response.output);
    }

    return json;
}

function createSseNormalizer(pRes, res, options = {}) {
    const { onNormalizedEvent, onCompleted, suppressDone } = options;
    let buffer = '';
    let lastResponse = null;

    pRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    if (!suppressDone) res.write('data: [DONE]\n\n');
                    continue;
                }
                try {
                    let json = JSON.parse(data);
                    json = normalizeResponseJson(json);
                    lastResponse = json;
                    if (onNormalizedEvent) onNormalizedEvent(json);
                    res.write(`data: ${JSON.stringify(json)}\n\n`);
                } catch (e) {
                    res.write(`${line}\n\n`);
                }
            } else if (line.trim() || line === '') {
                // Preserve empty lines as SSE delimiters, but only one
                res.write(`${line}\n`);
            }
        }
    });

    pRes.on('end', async () => {
        if (buffer.trim()) {
            const line = buffer;
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data !== '[DONE]') {
                    try {
                        let json = JSON.parse(data);
                        json = normalizeResponseJson(json);
                        lastResponse = json;
                        if (onNormalizedEvent) onNormalizedEvent(json);
                        res.write(`data: ${JSON.stringify(json)}\n\n`);
                    } catch (e) {}
                }
            }
        }
        if (onCompleted) {
            await onCompleted(lastResponse);
        } else {
            if (!suppressDone) res.write('data: [DONE]\n\n');
            res.end();
        }
    });
}

async function getTargetPortForModel(modelName) {
    if (!modelName) return TARGET_PORT;
    if (modelPortCache.has(modelName)) return modelPortCache.get(modelName);
    
    // Check which backend currently has this model
    for (const b of backendStatuses) {
        if (b.model === modelName) {
            modelPortCache.set(modelName, b.port);
            return b.port;
        }
    }
    
    // Default to main port
    return TARGET_PORT;
}

function createRequestHandler(port, isNonStop) {
    return (req, res) => {
        const isStatus = req.method === 'GET' && req.url === '/v1/status';
        const isStatusEvents = req.method === 'GET' && req.url === '/v1/status/events';
        const isMetadata = req.method === 'GET' && (req.url.startsWith('/v1/models') || req.url.startsWith('/v1/props'));

        if (!isStatus && !isStatusEvents && !isMetadata) {
            activeRequestsPerPort.set(port, (activeRequestsPerPort.get(port) || 0) + 1);
            updateStatusFile();
        }

        let decremented = false;
        let releaseBackend = null;
        let isRedirect = false;
        let currentRedirect = null;
        let markFinished = () => {};
        let cleanup = () => {
            if (!decremented) {
                if (!isStatus && !isStatusEvents && !isMetadata) {
                    activeRequestsPerPort.set(port, Math.max(0, (activeRequestsPerPort.get(port) || 0) - 1));
                    if (isRedirect && currentRedirect) {
                        const key = `${currentRedirect.host}:${currentRedirect.port}:${currentRedirect.model}`;
                        activeRedirectRequestsPerTarget.set(key, Math.max(0, (activeRedirectRequestsPerTarget.get(key) || 0) - 1));
                    }
                    markFinished();
                    updateStatusFile();
                }
                decremented = true;
                if (releaseBackend) { releaseBackend(); releaseBackend = null; }
            }
        };
        res.on('finish', cleanup); res.on('close', cleanup);
        // Safety timeout: 10 minutes max for any request to prevent count leaks
        setTimeout(cleanup, 600000);

        const isModels = req.method === 'GET' && req.url.startsWith('/v1/models');
        const isResponses = req.method === 'POST' && req.url.startsWith('/v1/responses');
        const isCompletions = req.method === 'POST' && (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/completions'));

        if (isStatusEvents) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
            sseClients.add(res);
            req.on('close', () => { sseClients.delete(res); if (sseClients.size === 0) stopSseHeartbeat(); });
            startSseHeartbeat();
            return;
        }

        if (isStatus) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getStatus(), null, 2));
            return;
        }


        const createProxyReq = (options = {}, tPortOverride, tHostOverride) => {
            const actualPort = tPortOverride || TARGET_PORT;
            const actualHost = tHostOverride || TARGET_HOST;
            const cleanHeaders = { ...req.headers };
            delete cleanHeaders['host']; delete cleanHeaders['content-length'];
            delete cleanHeaders['transfer-encoding']; delete cleanHeaders['connection'];
            const { headers: extraHeaders = {}, ...rest } = options;

            if (isRedirect && currentRedirect?.api_key) {
                extraHeaders['Authorization'] = `Bearer ${currentRedirect.api_key}`;
            }

            const pReq = http.request({
                hostname: actualHost, port: actualPort, path: req.url, method: req.method,
                headers: { ...cleanHeaders, 'host': `${actualHost}:${actualPort}`, 'connection': 'keep-alive', ...extraHeaders },
                ...rest
            });
            pReq.on('error', (err) => {
                error(`Upstream Error (${req.method} ${req.url} -> ${actualPort}): ${err.message}`);
                const b = backendStatuses.find(b => b.port === actualPort);
                if (b) { b.status = 'STOPPED'; b.progress = undefined; updateStatusFile(); }
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Upstream server unavailable", details: err.message }));
                } else {
                    // If we already started streaming, we should probably still close the connection
                    // and maybe write an error event if it's SSE
                    if (req.url.includes('stream=true') || req.headers.accept === 'text/event-stream') {
                        res.write(`data: ${JSON.stringify({ error: "Upstream server connection failed during stream", details: err.message })}\n\n`);
                        res.write('data: [DONE]\n\n');
                    }
                    res.end();
                }
            });
            pReq.setTimeout(0); return pReq;
        };


        if (isModels) {
            Promise.all(BACKEND_CONFIGS.map(config => {
                return new Promise((resolve) => {
                    const pReq = http.request({ hostname: config.host, port: config.port, path: req.url, method: req.method, headers: { 'host': `${config.host}:${config.port}` } });
                    pReq.on('response', (pRes) => {
                        let data = ''; pRes.on('data', (c) => data += c);
                        pRes.on('end', async () => {
                            const props = await getUpstreamProps(config);
                            try { resolve({ json: JSON.parse(data), props, statusCode: pRes.statusCode }); } catch { resolve(null); }
                        });
                    });
                    pReq.on('error', () => resolve(null));
                    pReq.setTimeout(1000, () => { pReq.destroy(); resolve(null); });
                    pReq.end();
                });
            })).then(results => {
                let allModels = []; let statusCode = 502;
                for (const r of results) {
                    if (r && r.json) {
                        const models = r.json.models || r.json.data || [];
                        if (Array.isArray(models)) {
                            statusCode = 200;
                            allModels = allModels.concat(models.map(m => {
                                const caps = ["completion"]; if (r.props.modalities?.vision) caps.push("multimodal", "vision");
                                const name = m.name || m.id || m.model || MODEL_TEMPLATE.slug;
                                return { ...MODEL_TEMPLATE, ...m, name, slug: m.slug || name, display_name: m.display_name || name, capabilities: caps };
                            }));
                        }
                    }
                }
                if (allModels.length > 0) {
                    allModels.push({ ...MODEL_TEMPLATE, id: "all", name: "all", slug: "all", display_name: "Least Loaded Backend (Virtual)", capabilities: ["completion"] });
                    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ object: "list", data: allModels, models: allModels }));
                } else {
                    res.writeHead(502); res.end(JSON.stringify({ error: "No backends available" }));
                }
            });
            return;
        }

        if (isResponses || isCompletions) {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    let json = JSON.parse(body);
                    json = normalizeRequestJson(json);
                    let tPort = TARGET_PORT;
                    let tHost = TARGET_HOST;
                    const isAllModel = json.model === 'all';

                    // Virtual "all" model: route to least-loaded backend via virtual queue
                    if (isAllModel) {
                        log(`[Proxy] Virtual "all" model request. Picking least-loaded backend...`);
                        const vqResult = await virtualQueue.acquire();
                        tHost = vqResult.tHost;
                        tPort = vqResult.tPort;
                        releaseBackend = () => {
                            vqResult.release();
                        };
                        log(`[Proxy] "all" -> ${tHost}:${tPort}`);
                    } else {
                        tPort = await getTargetPortForModel(json.model);

                        // Dynamic Model Switching Logic
                        // Ensure request pauses in queue if a switch is necessary
                        const targetOfflineModel = OFFLINE_MODELS.find(m => m.id === json.model || m.alias === json.model);
                        const currentModel = backendStatuses.find(b => b.port === tPort)?.model;
                        const needsSwitch = targetOfflineModel && (currentModel !== targetOfflineModel.id && currentModel !== targetOfflineModel.alias);

                        if (needsSwitch) {
                            // We will force the request into the main queue (TARGET_PORT) if we need to switch
                            const switchTargetPort = TARGET_PORT;
                            tPort = switchTargetPort;
                            
                            const queue = backendQueues.get(tPort);
                            if (queue) {
                                log(`[Proxy] Model switch required for ${json.model}. Waiting in queue for port ${tPort}...`);
                                const release = await queue.acquire();
                                releaseBackend = () => {
                                    const b = backendStatuses.find(b => b.port === tPort);
                                    if (b) b.progress = undefined;
                                    release();
                                };
                                
                                // Once acquired, execute the switch
                                const switchSuccess = await switchModel(json.model, tPort, log);
                                if (!switchSuccess) {
                                    error(`[Proxy] Failed to switch to model ${json.model}`);
                                    // If switch failed, we should probably not proceed with a stale model
                                    res.writeHead(503, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: "Model switch failed", model: json.model }));
                                    if (releaseBackend) releaseBackend();
                                    return;
                                }
                                // Trigger immediate status refresh after switch
                                if (typeof checkBackend === 'function') checkBackend(tPort);
                            }
                        } else if (tPort === TARGET_PORT && (backendQueues.get(tPort)?.activeCount >= backendQueues.get(tPort)?.maxParallel)) {
                            const bestRedirect = pickBestRedirect();
                            if (bestRedirect) {
                                log(`[Proxy] Main server busy (${backendQueues.get(tPort).activeCount}/${backendQueues.get(tPort).maxParallel}), redirecting to MLX: ${bestRedirect.host}`);
                                currentRedirect = bestRedirect;
                                tPort = bestRedirect.port; tHost = bestRedirect.host; json.model = bestRedirect.model; isRedirect = true;
                                const key = `${bestRedirect.host}:${bestRedirect.port}:${bestRedirect.model}`;
                                activeRedirectRequestsPerTarget.set(key, (activeRedirectRequestsPerTarget.get(key) || 0) + 1);
                                updateStatusFile();
                            }
                        }
                    }

                    log(`[Proxy] Port ${port} Request: ${json.model} -> ${tHost}:${tPort} (non_stop=${isNonStop})`);

                    // Standard Backend Queuing logic for non-switching requests
                    if (!releaseBackend) {
                        const queue = backendQueues.get(tPort);
                        if (queue) {
                            log(`[Proxy] Enqueuing request for backend port ${tPort}. Current queue size: ${queue.size}`);
                            const release = await queue.acquire();
                            releaseBackend = () => {
                                const b = backendStatuses.find(b => b.port === tPort);
                                if (b) b.progress = undefined;
                                release();
                            };
                        } else {
                            log(`[Proxy] Warning: No queue found for port ${tPort}. Proceeding without queue.`);
                        }
                    }

                    const activity = backendHTTPActivity.get(tPort);
                    let hasStartedGenerating = false;
                    let hasFinished = false;
                    if (activity) {
                        activity.prefilling++;
                        updateStatusFile();
                    }
                    const markGenerating = () => {
                        if (!hasStartedGenerating && !hasFinished && activity) {
                            hasStartedGenerating = true;
                            activity.prefilling = Math.max(0, activity.prefilling - 1);
                            activity.generating++;
                            updateStatusFile();
                        }
                    };
                    markFinished = () => {
                        if (!hasFinished && activity) {
                            hasFinished = true;
                            if (hasStartedGenerating) {
                                activity.generating = Math.max(0, activity.generating - 1);
                            } else {
                                activity.prefilling = Math.max(0, activity.prefilling - 1);
                            }
                            updateStatusFile();
                        }
                    };

                    const patched = Buffer.from(JSON.stringify(json));
                    
                    async function executeBackendRequest(currentJson, attempt = 1) {
                        const currentPatched = Buffer.from(JSON.stringify(currentJson));
                        const pReq = createProxyReq({ headers: { 'content-length': currentPatched.length } }, tPort, tHost);
                        
                        return new Promise((resolve, reject) => {
                            pReq.on('response', (pRes) => {
                                if (pRes.statusCode >= 300 && pRes.statusCode < 400 && pRes.headers.location) {
                                    const newHeaders = { ...pRes.headers };
                                    delete newHeaders['location'];
                                    res.writeHead(pRes.statusCode, newHeaders);
                                    pRes.on('data', (c) => {
                                        let chunkStr = c.toString();
                                        chunkStr = chunkStr.replace(/"model":\s*"[^"]+"/g, `"model":"${currentJson.model}"`);
                                        res.write(chunkStr);
                                    });
                                    pRes.on('end', () => {
                                        res.end();
                                        resolve();
                                    });
                                    return;
                                }

                                if (!currentJson.stream) {
                                    let resChunks = []; pRes.on('data', c => resChunks.push(c));
                                    pRes.on('end', async () => {
                                        const data = Buffer.concat(resChunks).toString();
                                        try {
                                            const resJson = normalizeResponseJson(JSON.parse(data));
                                            
                                            // Extraction for Recovery Logic
                                            let content = '';
                                            let hasToolCall = false;
                                            let isFinished = false;

                                            if (resJson.choices?.[0]) {
                                                const choice = resJson.choices[0];
                                                content = (typeof choice.message?.content === 'string' ? choice.message.content : 
                                                          (Array.isArray(choice.message?.content) ? choice.message.content.map(c => c.text || '').join('') : ''));
                                                hasToolCall = !!choice.message?.tool_calls?.length;
                                                isFinished = choice.finish_reason === 'stop';
                                            }
                                            
                                            const processOutputForRecovery = (output) => {
                                                if (!Array.isArray(output)) return;
                                                for (const item of output) {
                                                    if (item.type === 'message') {
                                                        content += (Array.isArray(item.content) ? item.content.map(c => c.text || '').join('') : '');
                                                        if (item.tool_calls?.length) hasToolCall = true;
                                                        if (item.status === 'completed') isFinished = true;
                                                    }
                                                    if (item.type === 'function_call') hasToolCall = true;
                                                }
                                            };

                                            if (resJson.output) processOutputForRecovery(resJson.output);
                                            if (resJson.response?.output) processOutputForRecovery(resJson.response.output);
                                            
                                            if (content.includes('FINISHED')) isFinished = true;
                                            const isContentEmpty = !content.trim();

                                                if (resJson.choices || resJson.output || resJson.response?.output) {
                                                    if (isNonStop && isFinished && !hasToolCall && attempt < 3) {
                                                        log(`[Proxy] Non-Stop: Model finished on port ${port}. Injecting follow-up (attempt ${attempt})...`);
                                                        const nextJson = { ...currentJson };
                                                        nextJson.input = [...(nextJson.input || []),
                                                            // llama.cpp requires "text" type. Do NOT use "output_text" or "input_text" here or it will 400.
                                                            { type: 'message', role: 'assistant', content: [{ type: 'text', text: content }] },
                                                            { type: 'message', role: 'user', content: [{ type: 'text', text: "Please continue with the next step. If the task is fully complete, provide a final summary of what was accomplished." }] }
                                                        ];
                                                        if (releaseBackend) { releaseBackend(); releaseBackend = null; }
                                                        resolve(executeBackendRequest(nextJson, attempt + 1));
                                                        return;
                                                    }
                                                    
                                                    if (attempt < 3 && !hasToolCall && !isFinished && isContentEmpty) {
                                                        log(`[Proxy] Recovery: Model stalled (no content, no tool call). Retrying (attempt ${attempt})...`);
                                                        if (releaseBackend) { releaseBackend(); releaseBackend = null; }
                                                        resolve(executeBackendRequest(currentJson, attempt + 1));
                                                        return;
                                                    }

                                                    // Recovery Flow: Review prompt for non-streaming
                                                    if (currentJson.tools?.length > 0 && !isNonStop && isFinished && !hasToolCall && attempt < 2 && content.length < 50) {
                                                        log(`[Proxy] Recovery: Model finished without tool call and short content. Injecting review prompt...`);
                                                        const nextJson = { ...currentJson };
                                                        nextJson.input = [...(nextJson.input || []),
                                                            // llama.cpp requires "text" type. Do NOT use "output_text" or "input_text" here or it will 400.
                                                            { type: 'message', role: 'assistant', content: [{ type: 'text', text: content }] },
                                                            { type: 'message', role: 'user', content: [{ type: 'text', text: "You haven't called a tool yet. Please check the available tools and call the appropriate one to proceed." }] }
                                                        ];
                                                        if (releaseBackend) { releaseBackend(); releaseBackend = null; }
                                                        resolve(executeBackendRequest(nextJson, attempt + 1));
                                                        return;
                                                    }
                                                }

                                            const final = JSON.stringify(resJson);
                                            const h = { ...pRes.headers }; delete h['content-length']; delete h['transfer-encoding'];
                                            h['content-length'] = Buffer.byteLength(final);
                                            res.writeHead(pRes.statusCode, h); res.end(final);
                                            resolve();
                                        } catch (e) { 
                                            error(`Error in non-stream response: ${e.message}`);
                                            res.writeHead(pRes.statusCode, pRes.headers); res.end(data); 
                                            resolve();
                                        }
                                    });
                                } else {
                                    if (attempt === 1) res.writeHead(pRes.statusCode, pRes.headers);
                                    
                                    let fullContent = '';
                                    let lastFinishReason = null;
                                    let hasSeenToolCall = false;

                                    createSseNormalizer(pRes, res, {
                                        onNormalizedEvent(norm) {
                                            // Extract from choices
                                            if (norm.choices?.[0]?.delta?.content) fullContent += norm.choices[0].delta.content;
                                            if (norm.choices?.[0]?.delta?.tool_calls) hasSeenToolCall = true;
                                            if (norm.choices?.[0]?.finish_reason) lastFinishReason = norm.choices[0].finish_reason;

                                            // Extract from output array (top-level or nested)
                                            const extract = (output) => {
                                                if (!Array.isArray(output)) return;
                                                for (const item of output) {
                                                    if (item.type === 'message' && item.content) {
                                                        fullContent += (Array.isArray(item.content) ? item.content.map(c => c.text || '').join('') : '');
                                                        if (item.tool_calls?.length) hasSeenToolCall = true;
                                                        if (item.status === 'completed') lastFinishReason = 'stop';
                                                    }
                                                    if (item.type === 'function_call') hasSeenToolCall = true;
                                                }
                                            };
                                            extract(norm.output);
                                            extract(norm.response?.output);

                                            if (norm.type === 'response.completed' && norm.response?.status === 'completed') {
                                                lastFinishReason = 'stop';
                                            }
                                        },
                                        async onCompleted(comp) {
                                            if (fullContent.includes('FINISHED')) lastFinishReason = 'stop';
                                            
                                            // Non-Stop Mode: If it finished with "stop" reason and no tool call, inject follow-up
                                            if (isNonStop && lastFinishReason === 'stop' && !hasSeenToolCall && attempt < 3) {
                                                log(`[Proxy] Non-Stop: Model finished stream on port ${port}. Injecting follow-up (attempt ${attempt})...`);
                                                const nextJson = { ...currentJson };
                                                nextJson.input = [...(nextJson.input || []),
                                                    // llama.cpp requires "text" type. Do NOT use "output_text" or "input_text" here or it will 400.
                                                    { type: 'message', role: 'assistant', content: [{ type: 'text', text: fullContent }] },
                                                    { type: 'message', role: 'user', content: [{ type: 'text', text: "Please continue. What is the next logical action?" }] }
                                                ];
                                                if (releaseBackend) { log(`[Proxy] Releasing backend before recursive call`); releaseBackend(); releaseBackend = null; }
                                                resolve(executeBackendRequest(nextJson, attempt + 1));
                                                return;
                                            }

                                            // Recovery Flow: If it finished without a tool call but work is likely pending
                                            if (currentJson.tools?.length > 0 && !isNonStop && lastFinishReason === 'stop' && !hasSeenToolCall && attempt < 2 && fullContent.length < 50) {
                                                log(`[Proxy] Recovery: Model finished without tool call and short content. Injecting review prompt (attempt ${attempt})...`);
                                                const nextJson = { ...currentJson };
                                                nextJson.input = [...(nextJson.input || []),
                                                    // llama.cpp requires "text" type. Do NOT use "output_text" or "input_text" here or it will 400.
                                                    { type: 'message', role: 'assistant', content: [{ type: 'text', text: fullContent }] },
                                                    { type: 'message', role: 'user', content: [{ type: 'text', text: "You haven't called a tool yet. Please check the available tools and call the appropriate one to proceed." }] }
                                                ];
                                                if (releaseBackend) { log(`[Proxy] Releasing backend before recursive call`); releaseBackend(); releaseBackend = null; }
                                                resolve(executeBackendRequest(nextJson, attempt + 1));
                                                return;
                                            }
                                            
                                            // Fallback Injection: If all else fails and it's definitely stuck
                                            if (lastFinishReason === 'stop' && !hasSeenToolCall && attempt >= 3) {
                                                log(`[Proxy] Recovery: Model stuck after multiple attempts. Injecting fallback tool call (ls -F)...`);
                                                const fallbackToolCall = {
                                                    id: `call_${Date.now()}`,
                                                    type: 'function',
                                                    function: { name: 'bash', arguments: JSON.stringify({ command: 'ls -F' }) }
                                                };
                                                const injectEvt = {
                                                    choices: [{
                                                        delta: { tool_calls: [fallbackToolCall] },
                                                        index: 0,
                                                        finish_reason: 'tool_calls'
                                                    }]
                                                };
                                                res.write(`data: ${JSON.stringify(injectEvt)}\n\n`);
                                            }

                                            log(`[Proxy] Finishing stream for port ${port} after attempt ${attempt}`);
                                            res.write('data: [DONE]\n\n');
                                            res.end();
                                            resolve();
                                        },
                                        suppressDone: true // New option to prevent [DONE] until we are actually finished
                                    });
                                }
                            });
                            pReq.on('error', reject);
                            pReq.write(currentPatched);
                            pReq.end();
                        });
                    }

                    try {
                        await executeBackendRequest(json);
                    } catch (e) {
                        cleanup();
                        if (!res.headersSent) {
                            res.writeHead(500);
                            res.end(e.message);
                        }
                    }
                } catch (e) { cleanup(); res.writeHead(500); res.end(e.message); }
            });
            return;
        }

        const pReq = createProxyReq();
        pReq.on('response', (pRes) => { res.writeHead(pRes.statusCode, pRes.headers); pRes.pipe(res); });
        req.pipe(pReq);
    };
}

LISTEN_PORTS.forEach(port => {
    const isNonStop = NON_STOP_PORTS.includes(port);
    http.createServer(createRequestHandler(port, isNonStop)).listen(port, "0.0.0.0", () => {
        log(`[Proxy] Listening on 0.0.0.0:${port} (non_stop=${isNonStop})`);
    });
});

function restartLlamaService(name, port, reason) {
    log(`[Monitor] Restarting ${name} on port ${port}: ${reason}`);
    
    // We try multiple ways to restart the service:
    // 1. systemctl --user (if it's a user service)
    // 2. sudo -n systemctl (if it's a system service and we have NOPASSWD sudo)
    // 3. pkill (as a fallback, if we have permission to kill the process)
    
    const cmd = `(systemctl --user restart ${name} 2>/dev/null) || ` +
                `(sudo -n systemctl restart ${name} 2>/dev/null) || ` +
                `(pkill -9 -f "[p]ort ${port}" 2>/dev/null && echo "Killed via pkill") || ` +
                `(sudo -n pkill -9 -f "[p]ort ${port}" 2>/dev/null && echo "Killed via sudo pkill")`;

    exec(cmd, (err, stdout, stderr) => {
        if (err) {
            error(`[Monitor] All restart attempts failed for ${name}: ${err.message}. Stderr: ${stderr}`);
        } else {
            const output = stdout.trim();
            log(`[Monitor] ${name} restart command executed. ${output ? '(' + output + ')' : ''}`);
        }
    });
}

const lastReadyTime = new Map();

const checkBackend = (port) => {
    const config = BACKEND_CONFIGS.find(b => b.port === port);
    const name = config?.service || BACKEND_SERVICES[0];
    if (!config) return;

    // Fetch props for ctx and batch size
    getUpstreamProps(config).then(props => {
        const b = backendStatuses.find(b => b.port === port);
        if (b) {
            if (props.n_ctx) {
                b.n_ctx = props.n_ctx;
                b.ctx = props.n_ctx;
            }
            // n_batch might be in different places depending on llama.cpp version
            const n_batch = props.default_generation_settings?.n_batch || props.n_batch;
            if (n_batch) {
                b.n_batch = n_batch;
                b.batch_size = n_batch;
            }
            // Fallback to env if needed (specifically for the main port)
            if (!b.n_batch && port === 11435) {
                b.n_batch = 128;
                b.batch_size = 128;
            }
            if (!b.n_ctx && port === 11435) {
                b.n_ctx = 65536;
                b.ctx = 65536;
            }
        }
    });

    // Fetch model name
    http.get({ hostname: TARGET_HOST, port, path: '/v1/models', timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                const models = json.models || json.data || [];
                const b = backendStatuses.find(b => b.port === port);
                if (b && models.length > 0) {
                    b.model = models[0].name || models[0].id || models[0].slug;
                }
            } catch {}
        });
    }).on('error', () => {});

    http.get({ hostname: TARGET_HOST, port, path: '/health', timeout: 10000 }, (res) => {
        const b = backendStatuses.find(b => b.port === port);
        if (b) {
            if (res.statusCode === 200) {
                b.status = 'READY';
                lastReadyTime.set(port, Date.now());
            } else if (res.statusCode === 503) {
                b.status = 'LOADING';
            } else {
                b.status = 'ERROR';
                b.progress = undefined;
                // Only restart if it was ready recently or if it's been in error state for a long time
                const lastReady = lastReadyTime.get(port) || 0;
                if (isMonitorEnabled() && (Date.now() - lastReady > 60000)) {
                    restartLlamaService(name, port, `Health status ${res.statusCode}`);
                }
            }
        }
        updateStatusFile();
    }).on('error', (err) => {
        const b = backendStatuses.find(b => b.port === port);
        if (b) { 
            const wasReady = b.status === 'READY' || b.status === 'LOADING';
            b.status = 'STOPPED'; 
            b.progress = undefined; 
            updateStatusFile(); 
            
            // Only auto-restart if it was previously functioning and now crashed, 
            // or if it has been ready at least once and then stopped for more than 2 minutes.
            const lastReady = lastReadyTime.get(port) || 0;
            const timeSinceReady = lastReady > 0 ? Date.now() - lastReady : -1;
            
            if (isMonitorEnabled()) {
                if (wasReady) {
                    restartLlamaService(name, port, err.message);
                } else if (lastReady > 0 && timeSinceReady > 120000) {
                    restartLlamaService(name, port, `Stuck for ${Math.round(timeSinceReady/1000)}s: ${err.message}`);
                }
            }
        }
    }).on('timeout', () => {
        const b = backendStatuses.find(b => b.port === port);
        if (b) { b.status = 'STOPPED'; b.progress = undefined; updateStatusFile(); }
        // Timeout usually means stuck, restart if it was ready
        if (isMonitorEnabled() && lastReadyTime.has(port)) {
            restartLlamaService(name, port, 'Health timeout');
        }
    });
};

const checkBackends = () => {
    // Check Redirect Servers
    configState.redirects.forEach(r => {
        const checkReq = http.get({ hostname: r.host, port: r.port, path: '/v1/models', timeout: 5000 }, (res) => {
            r.available = (res.statusCode === 200);
            updateStatusFile();
            res.resume();
        });
        checkReq.on('error', () => {
            r.available = false;
            updateStatusFile();
        });
        checkReq.on('timeout', () => {
            checkReq.destroy();
            r.available = false;
            updateStatusFile();
        });
    });

    BACKEND_PORTS.forEach(port => checkBackend(port));
};

setInterval(checkBackends, 60000).unref();
setTimeout(checkBackends, 1000).unref(); // Initial check shortly after startup
