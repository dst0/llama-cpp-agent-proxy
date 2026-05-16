import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
import path from 'node:path';

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);
const BACKEND_PORTS = (process.env.BACKEND_PORTS || `${TARGET_PORT}`).split(',').map(p => parseInt(p.trim(), 10));
const BACKEND_SERVICES = (process.env.BACKEND_SERVICES || 'llama-server').split(',').map(s => s.trim());

// Standard ports for Two-Port Proxy Architecture
const LISTEN_PORTS = (process.env.PORTS || process.env.PORT || '11450,11451').split(',').map(p => parseInt(p.trim(), 10));
const NON_STOP_PORTS = (process.env.NON_STOP_PORTS || (process.env.NON_STOP_MODE === 'true' ? process.env.PORT : '11451') || '').split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

const PROXY_PORT_PRIMARY = LISTEN_PORTS[0] || 11450;
const DEFAULT_LOG_DIR = `~/.llama-cpp-agent-proxy/logs/${PROXY_PORT_PRIMARY}`.replace('~', process.env.HOME || '');
const LOG_DIR = (process.env.LOG_DIR || DEFAULT_LOG_DIR).replace('~', process.env.HOME || '');
const LOG_FILE = (process.env.LOG_FILE || `${LOG_DIR}/proxy.log`).replace('~', process.env.HOME || '');
const FULL_LOG_FILE = (process.env.FULL_LOG_FILE || `${LOG_DIR}/proxy-full.log`).replace('~', process.env.HOME || '');
const MONITOR_ENABLED = process.env.MONITOR_ENABLED !== 'false';
const STATUS_FILE = (process.env.STATUS_FILE || `${LOG_DIR}/proxy.status`).replace('~', process.env.HOME || '');
const TITLE_MODEL = process.env.TITLE_MODEL || 'qwen2.5-0.5b';

const BUSY_REDIRECT_HOST = process.env.BUSY_REDIRECT_HOST || '192.168.8.124';
const BUSY_REDIRECT_PORT = parseInt(process.env.BUSY_REDIRECT_PORT || '1234', 10);
const BUSY_REDIRECT_MODEL = process.env.BUSY_REDIRECT_MODEL || 'mtplx-qwen36-27b-optimized-speed';
const BUSY_REDIRECT_API_KEY = process.env.BUSY_REDIRECT_API_KEY || '';

let lastTitle = 'Idle';
let lastTitleText = '';
const activeRequestsPerPort = new Map();
const backendStatuses = BACKEND_PORTS.map(port => ({ port, status: 'IDLE', progress: undefined }));
const modelPortCache = new Map();
const sseClients = new Set();

class BackendQueue {
    constructor(port) {
        this.port = port;
        this.active = false;
        this.queue = [];
    }

    async acquire() {
        if (!this.active) {
            this.active = true;
            updateStatusFile();
            return () => this.release();
        }
        return new Promise(resolve => {
            this.queue.push(resolve);
            updateStatusFile();
        }).then(() => {
            this.active = true;
            updateStatusFile();
            return () => this.release();
        });
    }

    release() {
        this.active = false;
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        } else {
            updateStatusFile();
        }
    }

    get size() {
        return this.queue.length;
    }
}

const backendQueues = new Map();
BACKEND_PORTS.forEach(p => backendQueues.set(p, new BackendQueue(p)));

const PROMPT_PROGRESS_RE = /prompt processing progress,.*?(?:progress\s*=\s*([\d.]+)|([\d.]+)\s*%)/i;

function startLogWatcher() {
    const LOG_FILES = (process.env.BACKEND_LOG_FILES || '/opt/llama/logs/main-stderr.log,/opt/llama/logs/micro-stderr.log').split(',').map(f => f.trim());
    for (let i = 0; i < BACKEND_PORTS.length; i++) {
        const port = BACKEND_PORTS[i];
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
            if (q && q.active) {
                if (b.progress !== undefined && b.progress > 0 && b.progress < 1) {
                    status = 'PREFILL';
                } else {
                    status = 'GEN';
                }
            } else {
                status = 'READY';
            }
        }
        
        if (status !== 'STOPPED' && status !== 'ERROR' && b.progress !== undefined && b.progress > 0) {
            if (prefillProgress === undefined || b.progress > prefillProgress) prefillProgress = b.progress;
        }
        return { ...b, status };
    });

    const portsStatus = {};
    LISTEN_PORTS.forEach(p => {
        const active = activeRequestsPerPort.get(p) || 0;
        portsStatus[p] = { active };
    });

    const queuesStatus = {};
    let totalQueueSize = 0;
    backendQueues.forEach((q, p) => {
        queuesStatus[p] = { size: q.size, active: q.active };
        totalQueueSize += q.size;
    });

    return {
        active_requests: Array.from(activeRequestsPerPort.values()).reduce((a, b) => a + b, 0),
        queue_size: totalQueueSize,
        ports: portsStatus,
        queues: queuesStatus,
        last_title: lastTitle,
        prefill_progress: prefillProgress,
        backends: backends,
        timestamp: new Date().toISOString()
    };
}

function broadcastStatus(status) {
    const data = `data: ${JSON.stringify(status)}\n\n`;
    for (const client of sseClients) {
        try { client.write(data); } catch (e) { sseClients.delete(client); }
    }
}

function updateStatusFile() {
    const status = getStatus();
    broadcastStatus(status);
    try {
        const tmp = STATUS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
        fs.renameSync(tmp, STATUS_FILE);
    } catch (e) {}
}

async function generateTitle(inputText) {
    if (!inputText || TITLE_MODEL === 'none') return;
    
    try {
        const targetPort = await getTargetPortForModel(TITLE_MODEL);
        if (!targetPort) return;

        const prompt = `Summarize the following user request into a very short (max 5 words) title. Return ONLY the title text, no preamble.\n\nRequest: ${inputText.slice(0, 1000)}`;
        
        const body = JSON.stringify({
            model: TITLE_MODEL,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            stream: false,
            max_output_tokens: 30,
            temperature: 0
        });

        const req = http.request({
            hostname: TARGET_HOST,
            port: targetPort,
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        });

        req.on('response', (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const title = json.content?.[0]?.text || json.output?.[0]?.content?.[0]?.text;
                    if (title) {
                        lastTitle = title.trim().replace(/^"|"$/g, '').slice(0, 50);
                        updateStatusFile();
                    }
                } catch {}
            });
        });
        req.on('error', () => {});
        req.setTimeout(5000, () => req.destroy());
        req.write(body);
        req.end();
    } catch {}
}

const getTargetPortForModel = async (modelName) => {
    if (!modelName) return TARGET_PORT;
    if (modelName.includes(':')) {
        const parts = modelName.split(':');
        const port = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(port)) return port;
    }
    if (modelPortCache.has(modelName)) return modelPortCache.get(modelName);
    if (modelName === 'qwen2.5-0.5b' && BACKEND_PORTS.includes(11438)) return 11438;

    for (const port of BACKEND_PORTS) {
        const result = await new Promise((resolve) => {
            const req = http.request({
                hostname: TARGET_HOST, port: port, path: '/v1/models', method: 'GET',
                headers: { 'host': `${TARGET_HOST}:${port}` }
            });
            req.on('response', (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        if (!body.trim()) return resolve(null);
                        const json = JSON.parse(body);
                        const models = json.models || json.data || [];
                        if (models.some(m => (m.name || m.id) === modelName || m.slug === modelName)) resolve(port);
                        else resolve(null);
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(500, () => { req.destroy(); resolve(null); });
            req.end();
        });
        if (result) {
            modelPortCache.set(modelName, result);
            return result;
        }
    }
    return TARGET_PORT;
};

const getUpstreamProps = (port = TARGET_PORT) => {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value = {}) => { if (!settled) { settled = true; resolve(value); } };
        const propsReq = http.get(`http://${TARGET_HOST}:${port}/props`, (propsRes) => {
            let data = '';
            propsRes.on('data', c => data += c);
            propsRes.on('end', () => { try { finish(JSON.parse(data)); } catch { finish({}); } });
            propsRes.on('error', () => finish({}));
        });
        propsReq.on('error', () => finish({}));
        propsReq.setTimeout(500, () => { propsReq.destroy(); finish({}); });
    });
};

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const MAX_LOG_SIZE = 32 * 1024 * 1024;
const MAX_LOG_FILES = 5;

function rotateLog(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        const stats = fs.statSync(filePath);
        if (stats.size < MAX_LOG_SIZE) return;
        for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
            const oldPath = `${filePath}.${i}`;
            const newPath = `${filePath}.${i + 1}`;
            if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
        }
        fs.renameSync(filePath, `${filePath}.1`);
    } catch (e) {}
}

function writeLog(filePath, line) {
    try { rotateLog(filePath); fs.appendFileSync(filePath, line + "\n"); } catch (e) {}
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    writeLog(LOG_FILE, line);
    console.log(line);
}

function error(msg) {
    const line = `[${new Date().toISOString()}] ERROR: ${msg}`;
    writeLog(LOG_FILE, line);
    console.error(line);
}

function sanitizeForLog(val, depth = 0) {
    if (depth > 10) return '[...]';
    if (typeof val === 'string') {
        if (val.startsWith('data:') && val.includes(';base64,')) {
            const prefix = val.slice(0, val.indexOf(';base64,') + 8);
            return `${prefix}[base64 ~${Math.round((val.length - prefix.length) * 3 / 4)} bytes]`;
        }
        if (val.length > 200 && /^[A-Za-z0-9+/]{100,}={0,2}$/.test(val)) return `[base64 ~${Math.round(val.length * 3 / 4)} bytes]`;
        if (val.length > 2000) return val.slice(0, 1000) + ` ...[+${val.length - 1000} chars]`;
        return val;
    }
    if (Array.isArray(val)) return val.map(v => sanitizeForLog(v, depth + 1));
    if (val && typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = sanitizeForLog(v, depth + 1);
        return out;
    }
    return val;
}

function logFull(entry) {
    writeLog(FULL_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

const MODEL_TEMPLATE = {
    "slug": "local-model", "display_name": "Local Model", "description": "Local LLM via llama.cpp",
    "default_reasoning_level": "medium",
    "supported_reasoning_levels": [
        { "effort": "none", "description": "Minimal reasoning" },
        { "effort": "low", "description": "Low reasoning" },
        { "effort": "medium", "description": "Medium reasoning" },
        { "effort": "high", "description": "High reasoning" },
        { "effort": "xhigh", "description": "Extra high reasoning" }
    ],
    "supports_reasoning_summaries": true, "support_verbosity": true, "shell_type": "shell_command",
    "visibility": "list", "supported_in_api": true, "capabilities": ["completion"],
    "priority": 0, "max_context_window": 65536, "base_instructions": "", "instructions_variables": {},
    "additional_speed_tiers": ["fast"], "service_tiers": [{ "id": "priority", "name": "Fast", "description": "Local priority" }],
    "truncation_policy": { "type": "auto" }
};

function normalizeContentPart(part, role = 'user') {
    if (!part || typeof part !== 'object') return part;
    const imageUrl = typeof part.image_url === 'object' ? part.image_url?.url : part.image_url;
    const isAssistant = role === 'assistant';
    const isTextPart = part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || !part.type;
    if (part.type === 'image_url' || part.type === 'input_image' || (part.type === 'image' && part.image_url !== undefined) || part.image_url !== undefined) {
        part.type = 'input_image';
        if (typeof imageUrl === 'string') part.image_url = imageUrl;
    } else if (part.type === 'refusal') return part;
    else if (isAssistant) {
        if (isTextPart) part.type = 'output_text';
        else return null;
    } else if (isTextPart) part.type = 'input_text';
    else return null;
    return part;
}

function normalizeToolOutput(output) {
    if (typeof output === 'string') return [{ type: 'input_text', text: output }];
    if (!Array.isArray(output)) return output;
    return output.map(part => {
        if (typeof part === 'string') return { type: 'input_text', text: part };
        return normalizeContentPart(part);
    }).filter(Boolean);
}

function normalizeResponseContentPart(part, { preserveReasoning = false } = {}) {
    if (typeof part === 'string') return { type: 'output_text', text: part };
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'refusal') return part;
    if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'summary_text') return preserveReasoning ? part : null;
    if (part.type === 'output_text' || part.type === 'text' || !part.type) { part.type = 'output_text'; return part; }
    return null;
}

function normalizeResponseItem(item, { preserveReasoning = false } = {}) {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'reasoning') {
        if (!preserveReasoning && !item.summary) item.summary = [{ type: 'summary_text', text: 'Reasoning trace...' }];
        return preserveReasoning ? item : null;
    }
    if (Array.isArray(item.content)) {
        item.content = item.content.map(part => normalizeResponseContentPart(part, { preserveReasoning })).filter(Boolean);
    } else if (typeof item.content === 'string') {
        item.content = [{ type: 'output_text', text: item.content }];
    }
    if (!preserveReasoning && Array.isArray(item.content) && item.content.length === 0) return null;
    return item;
}

function normalizeResponseJson(resJson) {
    if (Array.isArray(resJson.output)) {
        const norm = resJson.output.map(item => normalizeResponseItem(item)).filter(Boolean);
        resJson.output = norm.length > 0 ? norm : resJson.output.map(item => normalizeResponseItem(item, { preserveReasoning: true })).filter(Boolean);
    }
    if (Array.isArray(resJson.content)) {
        const norm = resJson.content.map(part => normalizeResponseContentPart(part)).filter(Boolean);
        resJson.content = norm.length > 0 ? norm : resJson.content.map(part => normalizeResponseContentPart(part, { preserveReasoning: true })).filter(Boolean);
    } else if (typeof resJson.content === 'string') {
        resJson.content = [{ type: 'output_text', text: resJson.content }];
    }
    return resJson;
}

function normalizeInputItem(item) {
    if (!item || typeof item !== 'object') return item;
    if (item.role === 'tool' && item.type !== 'function_call_output') {
        item.type = 'function_call_output';
        if (!item.call_id && item.tool_call_id) item.call_id = item.tool_call_id;
        if (item.output === undefined && item.content !== undefined) { item.output = item.content; delete item.content; }
        delete item.role; delete item.tool_call_id;
    } else if (item.type !== 'function_call_output' && item.type !== 'function_call') {
        item.type = 'message';
        if (!item.role) item.role = 'assistant';
    }
    if (item.type === 'function_call_output') {
        if (item.output === undefined && item.content !== undefined) { item.output = item.content; delete item.content; }
        item.output = normalizeToolOutput(item.output);
        if (Array.isArray(item.output)) {
            const hasImg = item.output.some(p => p.type === 'input_image');
            if (hasImg) {
                const txt = item.output.filter(p => p.type === 'input_text');
                const img = item.output.filter(p => p.type === 'input_image');
                if (txt.length === 0) txt.push({ type: 'input_text', text: '(Image output provided)' });
                item.output = txt;
                return [item, { type: 'message', role: 'user', content: img }];
            }
        }
        return item;
    }
    if (item.type !== 'message') return item;
    if (Array.isArray(item.content)) {
        item.content = item.content.map(part => normalizeContentPart(part, item.role)).filter(Boolean);
    } else if (typeof item.content === 'string') {
        item.content = [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }];
    }
    return item;
}

function doRetry(originalJson, targetPort) {
    return new Promise((resolve) => {
        log(`[Proxy] Retrying original prompt for ${originalJson.model}...`);
        const retryBody = JSON.stringify({ ...originalJson, stream: true });
        const req = http.request({
            hostname: TARGET_HOST, port: targetPort, path: '/v1/responses', method: 'POST',
            headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', 'content-length': Buffer.byteLength(retryBody), 'connection': 'keep-alive' }
        });
        let buf = ''; let settled = false;
        const done = (result) => { if (!settled) { settled = true; resolve(result); } };
        req.on('response', (retryRes) => {
            retryRes.setEncoding('utf8');
            retryRes.on('data', chunk => {
                buf += chunk; let bi;
                while ((bi = buf.indexOf('\n\n')) !== -1) {
                    const raw = buf.slice(0, bi); buf = buf.slice(bi + 2);
                    for (const line of raw.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trimStart();
                        if (!payload || payload === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(payload);
                            if (parsed.type === 'response.completed') {
                                const output = parsed.response?.output ?? [];
                                const fcItems = output.filter(i => i.type === 'function_call');
                                const msgText = output.find(i => i.type === 'message')?.content?.find(c => c.type === 'output_text')?.text ?? '';
                                done({ items: fcItems, finished: /^\s*FINISHED\s*$/i.test(msgText.trim()) });
                            }
                        } catch {}
                    }
                }
            });
            retryRes.on('end', () => done({ items: [], finished: false }));
        });
        req.on('error', () => done({ items: [], finished: false }));
        req.end(retryBody);
    });
}

function doReview(originalJson, textContent, targetPort) {
    return new Promise((resolve) => {
        log(`[Proxy] Asking for review for ${originalJson.model}...`);
        const reviewInput = [
            ...(originalJson.input ?? []),
            { role: 'assistant', content: [{ type: 'output_text', text: textContent || '(No output produced)' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'Your previous response did not include a tool call, but you have not signaled that the task is FINISHED. Please review your last response and correctly call the next appropriate tool according to your plan. This is a critical check for loop integrity.' }] }
        ];
        const reviewBody = JSON.stringify({ model: originalJson.model, ...(originalJson.tools ? { tools: originalJson.tools } : {}), ...(originalJson.instructions ? { instructions: originalJson.instructions } : {}), input: reviewInput, stream: true });
        const req = http.request({
            hostname: TARGET_HOST, port: targetPort, path: '/v1/responses', method: 'POST',
            headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', 'content-length': Buffer.byteLength(reviewBody), 'connection': 'keep-alive' }
        });
        let buf = ''; let settled = false;
        const done = (result) => { if (!settled) { settled = true; resolve(result); } };
        req.on('response', (reviewRes) => {
            reviewRes.setEncoding('utf8');
            reviewRes.on('data', chunk => {
                buf += chunk; let bi;
                while ((bi = buf.indexOf('\n\n')) !== -1) {
                    const raw = buf.slice(0, bi); buf = buf.slice(bi + 2);
                    for (const line of raw.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trimStart();
                        if (!payload || payload === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(payload);
                            if (parsed.type === 'response.completed') {
                                const output = parsed.response?.output ?? [];
                                const fcItems = output.filter(i => i.type === 'function_call');
                                const msgText = output.find(i => i.type === 'message')?.content?.find(c => c.type === 'output_text')?.text ?? '';
                                done({ items: fcItems, finished: /^\s*FINISHED\s*$/i.test(msgText.trim()) });
                            }
                        } catch {}
                    }
                }
            });
            reviewRes.on('end', () => done({ items: [], finished: false }));
        });
        req.on('error', () => done({ items: [], finished: false }));
        req.end(reviewBody);
    });
}

function createSseNormalizer(proxyRes, res, { onRawEvent, onNormalizedEvent, onCompleted } = {}) {
    let buffer = ''; let pendingComplete = null;
    proxyRes.setEncoding('utf8');
    proxyRes.on('data', chunk => {
        buffer += chunk; let bi;
        while ((bi = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, bi); buffer = buffer.slice(bi + 2);
            let skipWrite = false;
            const norm = raw.split('\n').map(line => {
                if (!line.startsWith('data:')) return line;
                const payload = line.slice(5).trimStart();
                if (!payload || payload === '[DONE]') return line;
                try {
                    const parsed = JSON.parse(payload);
                    if (onRawEvent) onRawEvent(parsed);
                    if (onCompleted && parsed.type === 'response.completed') { pendingComplete = parsed; skipWrite = true; return line; }
                    const normalized = normalizeResponseJson(parsed);
                    if (onNormalizedEvent) onNormalizedEvent(normalized);
                    return `data: ${JSON.stringify(normalized)}`;
                } catch { return line; }
            }).join('\n');
            if (!skipWrite) res.write(norm + '\n\n');
        }
    });
    proxyRes.on('end', () => {
        if (buffer) res.write(buffer);
        if (pendingComplete) onCompleted(pendingComplete).catch(err => {
            error(`[Proxy] onCompleted error: ${err.message}`);
            res.write(`data: ${JSON.stringify(normalizeResponseJson(pendingComplete))}\n\n`); res.end();
        }); else res.end();
    });
}

function createRequestHandler(port, isNonStop) {
    return (req, res) => {
        const isStatus = req.method === 'GET' && req.url === '/v1/status';
        const isStatusEvents = req.method === 'GET' && req.url === '/v1/status/events';
        const isMetadata = req.method === 'GET' && (req.url.startsWith('/v1/models') || req.url.startsWith('/v1/props'));

        if (!isStatus && !isStatusEvents && !isMetadata) {
            const current = (activeRequestsPerPort.get(port) || 0) + 1;
            activeRequestsPerPort.set(port, current);
            updateStatusFile();
        }

        let decremented = false;
        let releaseBackend = null;
        const cleanup = () => {
            if (!decremented) {
                if (!isStatus && !isStatusEvents && !isMetadata) {
                    const current = Math.max(0, (activeRequestsPerPort.get(port) || 0) - 1);
                    activeRequestsPerPort.set(port, current);
                    updateStatusFile();
                }
                decremented = true;
                if (releaseBackend) { releaseBackend(); releaseBackend = null; }
            }
        };
        res.on('finish', cleanup); res.on('close', cleanup);

        const isModels = req.method === 'GET' && req.url.startsWith('/v1/models');
        const isResponses = req.method === 'POST' && req.url.startsWith('/v1/responses');

        if (isStatusEvents) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
            sseClients.add(res); req.on('close', () => sseClients.delete(res));
            return;
        }

        if (isStatus) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getStatus(), null, 2));
            return;
        }


        const createProxyReq = (options = {}, tPort = TARGET_PORT, tHost = TARGET_HOST) => {
            const cleanHeaders = { ...req.headers };
            delete cleanHeaders['host']; delete cleanHeaders['content-length'];
            delete cleanHeaders['transfer-encoding']; delete cleanHeaders['connection'];
            const { headers: extra = {}, ...rest } = options;
            const pReq = http.request({
                hostname: tHost, port: tPort, path: req.url, method: req.method,
                headers: { ...cleanHeaders, 'host': `${tHost}:${tPort}`, 'connection': 'keep-alive', ...extra },
                ...rest
            });
            pReq.on('error', (err) => {
                error(`Upstream Error (${req.method} ${req.url} -> ${tPort}): ${err.message}`);
                const b = backendStatuses.find(b => b.port === tPort);
                if (b) { b.status = 'STOPPED'; b.progress = undefined; updateStatusFile(); }
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Upstream server unavailable", details: err.message }));
                }
            });
            pReq.setTimeout(0); return pReq;
        };

        if (isModels) {
            Promise.all(BACKEND_PORTS.map(p => {
                return new Promise((resolve) => {
                    const pReq = http.request({ hostname: TARGET_HOST, port: p, path: req.url, method: req.method, headers: { 'host': `${TARGET_HOST}:${p}` } });
                    pReq.on('response', (pRes) => {
                        let chunks = []; pRes.on('data', c => chunks.push(c));
                        pRes.on('end', async () => {
                            const data = Buffer.concat(chunks).toString(); const props = await getUpstreamProps(p);
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
                if (statusCode === 200) {
                    const b = JSON.stringify({ object: "list", models: allModels });
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b);
                } else {
                    res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: "No upstream servers available" }));
                }
            });
            return;
        }

        if (isResponses) {
            let chunks = []; req.on('data', c => chunks.push(c));
            req.on('end', async () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString());
                    let tPort = await getTargetPortForModel(json.model);
                    let tHost = TARGET_HOST;
                    let isRedirect = false;
                    if (tPort === TARGET_PORT && (activeRequestsPerPort.get(tPort) || 0) > 1) {
                        log(`[Proxy] Main server busy, redirecting to MLX: ${BUSY_REDIRECT_HOST}`);
                        tPort = BUSY_REDIRECT_PORT; tHost = BUSY_REDIRECT_HOST; json.model = BUSY_REDIRECT_MODEL; isRedirect = true;
                    }

                    // Backend Queuing logic
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

                    log(`[Proxy] Port ${port} Request: ${json.model} -> ${tHost}:${tPort} non_stop=${isNonStop}`);
                    logFull({ type: 'request', port, model: json.model, stream: !!json.stream, target_host: tHost, target_port: tPort, body: sanitizeForLog(json) });

                    if (Array.isArray(json.input)) {
                        const lastUser = json.input.filter(m => m.role === 'user').pop();
                        const text = (Array.isArray(lastUser?.content) ? lastUser.content.find(c => c.type === 'input_text' || c.type === 'text')?.text : lastUser?.content) || '';
                        if (text && text !== lastTitleText) { lastTitleText = text; generateTitle(text); }
                        json.input = json.input.flatMap(item => normalizeInputItem(item)).filter(Boolean).filter(item => !item.content || item.content.length > 0);
                    }
                    if (Array.isArray(json.tools)) {
                        json.tools = json.tools.filter(t => {
                            if (t.function) { Object.assign(t, t.function); delete t.function; t.type = 'function'; }
                            return t.type === 'function';
                        });
                    }

                    const patched = JSON.stringify(json);
                    const extraHeaders = { 'content-length': Buffer.byteLength(patched) };
                    if (isRedirect && BUSY_REDIRECT_API_KEY) extraHeaders['Authorization'] = `Bearer ${BUSY_REDIRECT_API_KEY}`;
                    
                    const pReq = createProxyReq({ headers: extraHeaders }, tPort, tHost);
                    pReq.on('response', (pRes) => {
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
                                if (releaseBackend) { releaseBackend(); releaseBackend = null; }
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
                                    const hasFC = out.some(i => i.type === 'function_call');
                                    const compText = out.find(i => i.type === 'message')?.content?.find(c => c.type === 'output_text')?.text;
                                    const text = textOut || compText || '';
                                    const hasTools = Array.isArray(json.tools) && json.tools.length > 0;
                                    let merged = out;
                                    if (!hasFC && hasTools) {
                                        const retry = await doRetry(json, tPort); let items = retry.items;
                                        if (items.length === 0 && (!retry.finished || isNonStop)) {
                                            const review = await doReview(json, text, tPort); items = review.items;
                                            if (items.length === 0 && (!review.finished || isNonStop)) {
                                                const fcId = `fc_proxy_${Math.random().toString(36).slice(2, 11)}`;
                                                items = [{ type: 'function_call', id: fcId, call_id: fcId, name: 'exec_command', arguments: JSON.stringify({ cmd: "ls -F", justification: "Loop integrity fallback" }) }];
                                                const evt = { type: 'response.output_item.added', output_index: out.length, item: { type: 'function_call', id: fcId, call_id: fcId, name: 'exec_command', arguments: '' } };
                                                res.write(`data: ${JSON.stringify(evt)}\n\n`);
                                                const doneEvt = { type: 'response.output_item.done', output_index: out.length, item: items[0] };
                                                res.write(`data: ${JSON.stringify(doneEvt)}\n\n`);
                                            }
                                        }
                                        if (items.length > 0) merged = [...out, ...items];
                                    }
                                    const finalEvt = normalizeResponseJson(merged === out ? comp : { ...comp, response: { ...comp.response, output: merged } });
                                    res.write(`data: ${JSON.stringify(finalEvt)}\n\n`); res.end();
                                    if (releaseBackend) { releaseBackend(); releaseBackend = null; }
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

function restartLlamaService(name, reason) {
    log(`[Monitor] Restarting ${name}: ${reason}`);
    exec(`sudo -n pkill -9 -f ${name} && sudo -n systemctl restart ${name}`, (err) => {
        if (!err) log(`[Monitor] ${name} restarted successfully.`);
    });
}

if (MONITOR_ENABLED) {
    const checkBackends = () => {
        BACKEND_PORTS.forEach((port, i) => {
            const name = BACKEND_SERVICES[i] || BACKEND_SERVICES[0];
            http.get({ hostname: TARGET_HOST, port, path: '/health', timeout: 10000 }, (res) => {
                const b = backendStatuses.find(b => b.port === port);
                if (b) {
                    if (res.statusCode === 200) {
                        b.status = 'READY';
                    } else if (res.statusCode === 503) {
                        b.status = 'LOADING';
                    } else {
                        b.status = 'ERROR';
                        b.progress = undefined;
                        restartLlamaService(name, `Health status ${res.statusCode}`);
                    }
                }
                updateStatusFile();
            }).on('error', (err) => {
                const b = backendStatuses.find(b => b.port === port);
                if (b) { b.status = 'STOPPED'; b.progress = undefined; updateStatusFile(); }
                restartLlamaService(name, err.message);
            }).on('timeout', () => {
                const b = backendStatuses.find(b => b.port === port);
                if (b) { b.status = 'STOPPED'; b.progress = undefined; updateStatusFile(); }
                restartLlamaService(name, 'Health timeout');
            });
        });
    };
    setInterval(checkBackends, 60000);
    setTimeout(checkBackends, 1000); // Initial check shortly after startup
}
