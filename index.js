import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { OFFLINE_MODELS, switchModel } from './model-switcher.js';

// --- Initialization sequence ---

// 1. Basic Paths & Static Env
const CONFIG_PATH = path.join(process.env.HOME || '', '.llama-cpp-agent-proxy', 'config.toml');

// 2. Mutable configuration variables (will be updated by loadConfig)
let TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
let TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);

const LISTEN_PORTS = (process.env.PORTS || process.env.PORT || '11450,11451').split(',').map(p => parseInt(p.trim(), 10));
const NON_STOP_PORTS = (process.env.NON_STOP_PORTS || (process.env.NON_STOP_MODE === 'true' ? process.env.PORT : '11451') || '').split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

const PROXY_PORT_PRIMARY = LISTEN_PORTS[0] || 11450;
const DEFAULT_LOG_DIR = `~/.llama-cpp-agent-proxy/logs/${PROXY_PORT_PRIMARY}`.replace('~', process.env.HOME || '');
const LOG_DIR = (process.env.LOG_DIR || DEFAULT_LOG_DIR).replace('~', process.env.HOME || '');
const LOG_FILE = (process.env.LOG_FILE || `${LOG_DIR}/proxy.log`).replace('~', process.env.HOME || '');
const FULL_LOG_FILE = (process.env.FULL_LOG_FILE || `${LOG_DIR}/proxy-full.log`).replace('~', process.env.HOME || '');
const STATUS_FILE = (process.env.STATUS_FILE || `${LOG_DIR}/proxy.status`).replace('~', process.env.HOME || '');
const TITLE_MODEL = process.env.TITLE_MODEL || 'qwen2.5-0.5b';

// Global mutable config state
let configState = {
    redirect: {
        host: process.env.BUSY_REDIRECT_HOST || '192.168.8.234',
        port: parseInt(process.env.BUSY_REDIRECT_PORT || '1234'),
        model: process.env.BUSY_REDIRECT_MODEL || 'gemma-4-26b-a4b-it-mlx',
        api_key: process.env.BUSY_REDIRECT_API_KEY || ''
    },
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

// 4. Configuration Loader
function loadConfig() {
    try {
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
                redirect: configState.redirect,
                logging: {
                    dir: LOG_DIR
                }
            };
            const tomlStr = `# llama-cpp-agent-proxy configuration\n\n` + 
                `[network]\ntarget_host = "${defaultConfig.network.target_host}"\ntarget_port = ${defaultConfig.network.target_port}\nports = ${JSON.stringify(defaultConfig.network.ports)}\nnon_stop_ports = ${JSON.stringify(defaultConfig.network.non_stop_ports)}\n\n` +
                `[backends]\nports = ${JSON.stringify(defaultConfig.backends.ports)}\nservices = ${JSON.stringify(defaultConfig.backends.services)}\nmonitor_enabled = ${defaultConfig.backends.monitor_enabled}\n\n` +
                `[redirect]\nhost = "${defaultConfig.redirect.host}"\nport = ${defaultConfig.redirect.port}\nmodel = "${defaultConfig.redirect.model}"\napi_key = "${defaultConfig.redirect.api_key}"\n\n` +
                `[logging]\ndir = "${defaultConfig.logging.dir}"\n`;
            
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
            fs.writeFileSync(CONFIG_PATH, tomlStr);
            log(`[Config] Created default configuration at ${CONFIG_PATH}`);
        }

        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = parseToml(raw);
        
        // Update mutable parts of config
        if (parsed.network) {
            TARGET_HOST = parsed.network.target_host || TARGET_HOST;
            TARGET_PORT = parsed.network.target_port || TARGET_PORT;
        }
        if (parsed.redirect) {
            configState.redirect.host = parsed.redirect.host || configState.redirect.host;
            configState.redirect.port = parsed.redirect.port || configState.redirect.port;
            configState.redirect.model = parsed.redirect.model || configState.redirect.model;
            configState.redirect.api_key = parsed.redirect.api_key || configState.redirect.api_key;
        }
        if (parsed.backends && typeof parsed.backends.monitor_enabled === 'boolean') {
            configState.backends.monitor_enabled = parsed.backends.monitor_enabled;
        }
        
        log(`[Config] Loaded configuration from ${CONFIG_PATH}`);
    } catch (e) {
        error(`[Config] Failed to load config: ${e.message}`);
    }
}

// Initial load
loadConfig();

// Reload every minute
setInterval(loadConfig, 60000);

// Use configState for derived values
const getBusyRedirectHost = () => configState.redirect.host;
const getBusyRedirectPort = () => configState.redirect.port;
const getBusyRedirectModel = () => configState.redirect.model;
const getBusyRedirectApiKey = () => configState.redirect.api_key;
const isMonitorEnabled = () => configState.backends.monitor_enabled;

// Backend config: host:port:service:logFile (logFile optional)
const BACKEND_CONFIGS = (process.env.BACKEND_CONFIGS || `${TARGET_HOST}:${TARGET_PORT}:llama-server:/opt/llama/logs/main-stderr.log`).split(',').map(entry => {
    const [host, port, service, logFile] = entry.trim().split(':');
    return { host: host || TARGET_HOST, port: parseInt(port, 10), service: service || 'llama-server', logFile: logFile || null };
}).filter(b => !isNaN(b.port));

// Derived for backward compatibility
const BACKEND_PORTS = BACKEND_CONFIGS.map(b => b.port);
const BACKEND_SERVICES = BACKEND_CONFIGS.map(b => b.service);
const BACKEND_LOG_FILES = BACKEND_CONFIGS.map(b => b.logFile || '');

let lastTitle = 'Idle';
let lastTitleText = '';
let redirectServerAvailable = false;
let activeRedirectRequests = 0;
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
            const release = await bq.acquire();
            let released = false;
            return {
                tHost: backend.host,
                tPort: backend.port,
                release: () => {
                    if (released) return;
                    released = true;
                    release();
                    this.activeCount--;
                    this.dispatchNext();
                    updateStatusFile();
                }
            };
        }
        return new Promise(resolve => {
            this.waiting.push(resolve);
            updateStatusFile();
        }).then(() => this.acquire());
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
            next();
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
        redirect_server: {
            host: getBusyRedirectHost(),
            port: getBusyRedirectPort(),
            model: getBusyRedirectModel(),
            available: redirectServerAvailable,
            active_requests: activeRedirectRequests
        },
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
}, BROADCAST_INTERVAL);

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
    }, SSE_HEARTBEAT_INTERVAL);
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
    capabilities: ["completion"]
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

function normalizeResponseJson(json) {
    if (!json.choices) return json;
    const choices = json.choices.map(c => {
        if (!c.message || c.message.content === undefined) return c;
        let content = c.message.content;
        let items = [];
        if (typeof content === 'string') {
            items.push({ type: 'output_text', text: content });
        } else if (Array.isArray(content)) {
            items = content;
        }
        return {
            ...c,
            message: {
                ...c.message,
                content: items
            }
        };
    });
    return { ...json, choices };
}

function createSseNormalizer(pRes, res, options = {}) {
    const { onNormalizedEvent, onCompleted } = options;
    let buffer = '';
    let lastResponse = null;

    pRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                    res.write('data: [DONE]\n\n');
                    continue;
                }
                try {
                    const json = JSON.parse(data);
                    lastResponse = json;
                    // For SSE, we just proxy the chunk but could normalize here if needed
                    res.write(`data: ${JSON.stringify(json)}\n\n`);
                } catch (e) {
                    res.write(`${line}\n`);
                }
            } else {
                res.write(`${line}\n`);
            }
        }
    });

    pRes.on('end', () => {
        if (onCompleted && lastResponse) {
            onCompleted(lastResponse);
        } else {
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
        let markFinished = () => {};
        let cleanup = () => {
            if (!decremented) {
                if (!isStatus && !isStatusEvents && !isMetadata) {
                    activeRequestsPerPort.set(port, Math.max(0, (activeRequestsPerPort.get(port) || 0) - 1));
                    if (isRedirect) activeRedirectRequests = Math.max(0, activeRedirectRequests - 1);
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
            res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
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
            const actualPort = tPortOverride || tPort;
            const actualHost = tHostOverride || tHost;
            const cleanHeaders = { ...req.headers };
            delete cleanHeaders['host']; delete cleanHeaders['content-length'];
            delete cleanHeaders['transfer-encoding']; delete cleanHeaders['connection'];
            const { headers: extraHeaders = {}, ...rest } = options;
            
            if (isRedirect && getBusyRedirectApiKey()) extraHeaders['Authorization'] = `Bearer ${getBusyRedirectApiKey()}`;
            
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
                }
            });
            pReq.setTimeout(0); return pReq;
        };

        if (isModels) {
            Promise.all(BACKEND_CONFIGS.map(config => {
                return new Promise((resolve) => {
                    const pReq = http.request({ hostname: config.host, port: config.port, path: req.url, method: req.method, headers: { 'host': `${config.host}:${config.port}` } });
                    pReq.on('response', (pRes) => {
                        let chunks = []; pRes.on('data', c => chunks.push(c));
                        pRes.on('end', async () => {
                            const data = Buffer.concat(chunks).toString(); const props = await getUpstreamProps(config);
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
                    res.end(JSON.stringify({ object: "list", data: allModels }));
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
                        } else if (tPort === TARGET_PORT && (backendQueues.get(tPort)?.activeCount >= backendQueues.get(tPort)?.maxParallel) && redirectServerAvailable) {
                            log(`[Proxy] Main server busy (${backendQueues.get(tPort).activeCount}/${backendQueues.get(tPort).maxParallel}), redirecting to MLX: ${getBusyRedirectHost()}`);
                            tPort = getBusyRedirectPort(); tHost = getBusyRedirectHost(); json.model = getBusyRedirectModel(); isRedirect = true;
                            activeRedirectRequests++;
                            updateStatusFile();
                        }
                    }

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
                    const pReq = createProxyReq({ headers: { 'content-length': patched.length } }, tPort, tHost);
                    
                    pReq.on('response', (pRes) => {
                        if (pRes.statusCode >= 300 && pRes.statusCode < 400 && pRes.headers.location) {
                            const newHeaders = { ...pRes.headers };
                            delete newHeaders['location'];
                            res.writeHead(pRes.statusCode, newHeaders);
                            pRes.on('data', (c) => {
                                let chunkStr = c.toString();
                                chunkStr = chunkStr.replace(/"model":\s*"[^"]+"/g, `"model":"${json.model}"`);
                                res.write(chunkStr);
                            });
                            pRes.on('end', () => {
                                res.end();
                            });
                            return;
                        }

                        if (!json.stream) {
                            let resChunks = []; pRes.on('data', c => resChunks.push(c));
                            pRes.on('end', () => {
                                const data = Buffer.concat(resChunks).toString();
                                try {
                                    const resJson = normalizeResponseJson(JSON.parse(data));
                                    const final = JSON.stringify(resJson);
                                    const h = { ...pRes.headers }; delete h['content-length']; delete h['transfer-encoding'];
                                    h['content-length'] = Buffer.byteLength(final);
                                    res.writeHead(pRes.statusCode, h); res.end(final);
                                } catch { res.writeHead(pRes.statusCode, pRes.headers); res.end(data); }
                            });
                        } else {
                            res.writeHead(pRes.statusCode, pRes.headers);
                            let textOut = '';
                            createSseNormalizer(pRes, res, {
                                onNormalizedEvent(norm) {
                                    if (norm.type === 'response.output_text.delta') textOut += norm.delta;
                                    if (norm.type === 'response.output_text.done') textOut = norm.text;
                                    const itemText = norm.item?.content?.find?.(c => c.type === 'output_text')?.text;
                                    if (itemText) textOut = itemText;
                                },
                                async onCompleted(comp) {
                                    const out = comp.response?.output ?? [];
                                    const finalEvt = normalizeResponseJson({ ...comp, response: { ...comp.response, output: out } });
                                    res.write(`data: ${JSON.stringify(finalEvt)}\n\n`); res.end();
                                }
                            });
                        }
                    });
                    pReq.write(patched); pReq.end();
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
    exec(`sudo -n pkill -9 -f "port ${port}"; sudo -n systemctl restart ${name}`, (err) => {
        if (!err) log(`[Monitor] ${name} restarted successfully.`);
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
            // or if it has been stopped for more than 2 minutes (startup safety).
            const lastReady = lastReadyTime.get(port) || 0;
            const timeSinceReady = Date.now() - lastReady;
            if (isMonitorEnabled() && (wasReady || timeSinceReady > 120000)) {
                restartLlamaService(name, port, err.message);
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
    // Check Redirect Server
    const rHost = getBusyRedirectHost();
    const rPort = getBusyRedirectPort();
    if (rHost && rPort) {
        const checkReq = http.get({ hostname: rHost, port: rPort, path: '/v1/models', timeout: 5000 }, (res) => {
            redirectServerAvailable = (res.statusCode === 200);
            updateStatusFile();
            res.resume(); // consume the response
        });
        checkReq.on('error', (err) => {
            redirectServerAvailable = false;
            updateStatusFile();
        });
        checkReq.on('timeout', () => {
            checkReq.destroy();
            redirectServerAvailable = false;
            updateStatusFile();
        });
    }

    BACKEND_PORTS.forEach(port => checkBackend(port));
};

setInterval(checkBackends, 60000);
setTimeout(checkBackends, 1000); // Initial check shortly after startup
