import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);
const BACKEND_PORTS = (process.env.BACKEND_PORTS || `${TARGET_PORT}`).split(',').map(p => parseInt(p.trim(), 10));
const BACKEND_SERVICES = (process.env.BACKEND_SERVICES || 'llama-server').split(',').map(s => s.trim());
const PROXY_PORT = parseInt(process.env.PORT || '11437', 10);
const DEFAULT_LOG_DIR = `~/.llama-cpp-agent-proxy/logs/${PROXY_PORT}`.replace('~', process.env.HOME || '');
const LOG_DIR = (process.env.LOG_DIR || DEFAULT_LOG_DIR).replace('~', process.env.HOME || '');
const LOG_FILE = (process.env.LOG_FILE || `${LOG_DIR}/proxy.log`).replace('~', process.env.HOME || '');
const FULL_LOG_FILE = (process.env.FULL_LOG_FILE || `${LOG_DIR}/proxy-full.log`).replace('~', process.env.HOME || '');
const NON_STOP_MODE = process.env.NON_STOP_MODE === 'true';
const MONITOR_ENABLED = process.env.MONITOR_ENABLED !== 'false';
let activeRequests = 0;

// Ensure log directory exists
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
            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
            }
        }
        fs.renameSync(filePath, `${filePath}.1`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Log rotation failed for ${filePath}: ${e.message}`);
    }
}

function writeLog(filePath, line) {
    try {
        rotateLog(filePath);
        fs.appendFileSync(filePath, line + "\n");
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Failed to write to log ${filePath}: ${e.message}`);
    }
}

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    writeLog(LOG_FILE, line);
    console.log(line);
}

function error(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ERROR: ${msg}`;
    writeLog(LOG_FILE, line);
    console.error(line);
}

// Sanitize values for logging: replace base64 blobs and truncate long strings.
function sanitizeForLog(val, depth = 0) {
    if (depth > 10) return '[...]';
    if (typeof val === 'string') {
        if (val.startsWith('data:') && val.includes(';base64,')) {
            const prefix = val.slice(0, val.indexOf(';base64,') + 8);
            return `${prefix}[base64 ~${Math.round((val.length - prefix.length) * 3 / 4)} bytes]`;
        }
        if (val.length > 200 && /^[A-Za-z0-9+/]{100,}={0,2}$/.test(val)) {
            return `[base64 ~${Math.round(val.length * 3 / 4)} bytes]`;
        }
        if (val.length > 2000) {
            return val.slice(0, 1000) + ` ...[+${val.length - 1000} chars]`;
        }
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
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    writeLog(FULL_LOG_FILE, line);
}

const MODEL_TEMPLATE = {
    "slug": "local-model",
    "display_name": "Local Model",
    "description": "Local LLM via llama.cpp",
    "default_reasoning_level": "medium",
    "supported_reasoning_levels": [
        { "effort": "none", "description": "Minimal reasoning" },
        { "effort": "low", "description": "Low reasoning" },
        { "effort": "medium", "description": "Medium reasoning" },
        { "effort": "high", "description": "High reasoning" },
        { "effort": "xhigh", "description": "Extra high reasoning" }
    ],
    "supports_reasoning_summaries": true,
    "support_verbosity": true,
    "shell_type": "shell_command",
    "visibility": "list",
    "supported_in_api": true,
    "capabilities": ["completion"],
    "priority": 0,
    "max_context_window": 65536,
    "base_instructions": "",
    "instructions_variables": {},
    "additional_speed_tiers": ["fast"],
    "service_tiers": [{ "id": "priority", "name": "Fast", "description": "Local priority" }],
    "truncation_policy": { "type": "auto" }
};

function normalizeContentPart(part, role = 'user') {
    if (!part || typeof part !== 'object') return part;

    const imageUrl = typeof part.image_url === 'object' ? part.image_url?.url : part.image_url;
    const isAssistant = role === 'assistant';
    const isTextPart = part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || !part.type;

    if (part.type === 'image_url' || part.type === 'input_image' || (part.type === 'image' && part.image_url !== undefined) || part.image_url !== undefined) {
        part.type = 'input_image';
        if (typeof imageUrl === 'string') {
            part.image_url = imageUrl;
        }
    } else if (part.type === 'refusal') {
        return part;
    } else if (isAssistant) {
        if (isTextPart) {
            part.type = 'output_text';
        } else if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'summary_text') {
            return null;
        } else {
            return null;
        }
    } else if (isTextPart) {
        part.type = 'input_text';
    } else if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'summary_text') {
        return null;
    } else {
        return null;
    }

    return part;
}

function normalizeToolOutput(output) {
    if (typeof output === 'string') {
        return [{ type: 'input_text', text: output }];
    }

    if (!Array.isArray(output)) {
        return output;
    }

    return output.map(part => {
        if (typeof part === 'string') {
            return { type: 'input_text', text: part };
        }

        return normalizeContentPart(part);
    }).filter(Boolean);
}

function normalizeResponseContentPart(part, { preserveReasoning = false } = {}) {
    if (typeof part === 'string') {
        return { type: 'output_text', text: part };
    }

    if (!part || typeof part !== 'object') return null;

    if (part.type === 'refusal') {
        return part;
    }

    if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'summary_text') {
        return preserveReasoning ? part : null;
    }

    if (part.type === 'output_text' || part.type === 'text' || !part.type) {
        part.type = 'output_text';
        return part;
    }

    return null;
}

function normalizeResponseItem(item, { preserveReasoning = false } = {}) {
    if (!item || typeof item !== 'object') return item;

    if (item.type === 'reasoning') {
        if (!preserveReasoning && !item.summary) {
            item.summary = [{ type: 'summary_text', text: 'Reasoning trace...' }];
        }
        return preserveReasoning ? item : null;
    }

    if (Array.isArray(item.content)) {
        item.content = item.content
            .map(part => normalizeResponseContentPart(part, { preserveReasoning }))
            .filter(Boolean);
    } else if (typeof item.content === 'string') {
        item.content = [{ type: 'output_text', text: item.content }];
    }

    if (!preserveReasoning && Array.isArray(item.content) && item.content.length === 0) {
        return null;
    }

    return item;
}

function normalizeResponseJson(resJson) {
    if (Array.isArray(resJson.output)) {
        const normalizedOutput = resJson.output
            .map(item => normalizeResponseItem(item))
            .filter(Boolean);

        resJson.output = normalizedOutput.length > 0 ? normalizedOutput : resJson.output
            .map(item => normalizeResponseItem(item, { preserveReasoning: true }))
            .filter(Boolean);
    }

    if (Array.isArray(resJson.content)) {
        const normalizedContent = resJson.content
            .map(part => normalizeResponseContentPart(part))
            .filter(Boolean);

        resJson.content = normalizedContent.length > 0 ? normalizedContent : resJson.content
            .map(part => normalizeResponseContentPart(part, { preserveReasoning: true }))
            .filter(Boolean);
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
        if (item.output === undefined && item.content !== undefined) {
            item.output = item.content;
            delete item.content;
        }
        delete item.role;
        delete item.tool_call_id;
    } else if (item.type !== 'function_call_output' && item.type !== 'function_call') {
        item.type = 'message';
        if (!item.role) item.role = 'assistant';
    }

    if (item.type === 'function_call_output') {
        if (item.output === undefined && item.content !== undefined) {
            item.output = item.content;
            delete item.content;
        }
        item.output = normalizeToolOutput(item.output);
        
        if (Array.isArray(item.output)) {
            const hasImage = item.output.some(p => p.type === 'input_image');
            if (hasImage) {
                const textParts = item.output.filter(p => p.type === 'input_text');
                const imageParts = item.output.filter(p => p.type === 'input_image');
                
                if (textParts.length === 0) {
                    textParts.push({ type: 'input_text', text: '(Image output provided)' });
                }
                
                item.output = textParts;
                return [
                    item,
                    { type: 'message', role: 'user', content: imageParts }
                ];
            }
        }
        return item;
    }

    if (item.type !== 'message') {
        return item;
    }

    if (Array.isArray(item.content)) {
        item.content = item.content
            .map(part => normalizeContentPart(part, item.role))
            .filter(Boolean);
    } else if (typeof item.content === 'string') {
        item.content = [{
            type: item.role === 'assistant' ? 'output_text' : 'input_text',
            text: item.content
        }];
    }

    return item;
}

/**
 * When a streaming agentic response ends with only text (no tool calls) or
 * is completely empty, the model may have narrated an intention without
 * actually calling a tool, or it may have produced no output at all. This
 * function fires a follow-up request to llama-server within the same open
 * HTTP connection, asking the model to either act or confirm it is finished.
 * Returns a promise that resolves with any function_call items extracted from
 * the follow-up response (empty array if the model replied FINISHED or failed).
 */
function doFollowUp(originalJson, textContent, targetPort) {
    return new Promise((resolve) => {
        const followUpInput = [
            ...(originalJson.input ?? []),
            {
                role: 'assistant',
                content: [{ type: 'output_text', text: textContent }]
            },
            {
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: textContent
                        ? (NON_STOP_MODE
                            ? 'You described an action but did not call a tool. If there is remaining work, call the appropriate tool now. If you are still working on the task, perform a next step of work on this task, or plan your actions and call a next tool you need for that. Otherwise continue working on the backlog or live-testing and fixing/polishing the app according to described in documentation flows.'
                            : 'You described an action but did not call a tool. If there is remaining work, call the appropriate tool now. If you are still working on the task, perform a next step of work on this task, or plan your actions and call a next tool you need for that. If all work is genuinely complete, respond with only: FINISHED')
                        : (NON_STOP_MODE
                            ? 'You produced no output. Please reconsider and either call an appropriate tool to continue working on the task, or plan your actions and call a next tool you need for that. Continue working on the backlog or live-testing and fixing/polishing the app according to described in documentation flows.'
                            : 'You produced no output. Please reconsider and either call an appropriate tool to continue working on the task, or respond with FINISHED if the task is genuinely complete.')
                }]
            }
        ];

        const followUpBody = JSON.stringify({
            model: originalJson.model,
            ...(originalJson.tools ? { tools: originalJson.tools } : {}),
            ...(originalJson.instructions ? { instructions: originalJson.instructions } : {}),
            ...(originalJson.temperature !== undefined ? { temperature: originalJson.temperature } : {}),
            ...(originalJson.max_output_tokens ? { max_output_tokens: originalJson.max_output_tokens } : {}),
            input: followUpInput,
            stream: true,
        });

        const req = http.request({
            hostname: TARGET_HOST,
            port: targetPort,
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'text/event-stream',
                'content-length': Buffer.byteLength(followUpBody),
                'connection': 'keep-alive'
            }
        });

        let buf = '';
        let settled = false;
        const done = (items) => { if (!settled) { settled = true; resolve(items); } };

        req.on('response', (followUpRes) => {
            followUpRes.setEncoding('utf8');
            followUpRes.on('data', chunk => {
                buf += chunk;
                let bi;
                while ((bi = buf.indexOf('\n\n')) !== -1) {
                    const rawEvent = buf.slice(0, bi);
                    buf = buf.slice(bi + 2);
                    for (const line of rawEvent.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trimStart();
                        if (!payload || payload === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(payload);
                            logFull({ type: 'sse_followup', event: parsed });
                            if (parsed.type === 'response.completed') {
                                const output = parsed.response?.output ?? [];
                                const fcItems = output.filter(i => i.type === 'function_call');
                                const msgText = output
                                    .find(i => i.type === 'message')
                                    ?.content?.find(c => c.type === 'output_text')?.text ?? '';
                                done(/^\s*FINISHED\s*$/i.test(msgText.trim()) ? [] : fcItems);
                            }
                        } catch {}
                    }
                }
            });
            followUpRes.on('end', () => done([]));
        });

        req.on('error', (err) => {
            error(`[Proxy] Follow-up request failed: ${err.message}`);
            done([]);
        });
        req.setTimeout(120000, () => { req.destroy(); done([]); });

        req.write(followUpBody);
        req.end();
    });
}

function createSseNormalizer(proxyRes, res, { onRawEvent, onNormalizedEvent, onCompleted } = {}) {
    let buffer = '';
    let pendingComplete = null;

    proxyRes.setEncoding('utf8');
    proxyRes.on('data', chunk => {
        buffer += chunk;

        let boundaryIndex;
        while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);

            let skipWrite = false;
            const normalizedEvent = rawEvent.split('\n').map(line => {
                if (!line.startsWith('data:')) return line;

                const payload = line.slice(5).trimStart();
                if (!payload || payload === '[DONE]') return line;

                try {
                    const parsed = JSON.parse(payload);
                    if (onRawEvent) onRawEvent(parsed);
                    if (onCompleted && parsed.type === 'response.completed') {
                        pendingComplete = parsed;
                        skipWrite = true;
                        return line;
                    }
                    const normalized = normalizeResponseJson(parsed);
                    if (onNormalizedEvent) onNormalizedEvent(normalized);
                    return `data: ${JSON.stringify(normalized)}`;
                } catch {
                    return line;
                }
            }).join('\n');

            if (!skipWrite) {
                res.write(normalizedEvent + '\n\n');
            }
        }
    });

    proxyRes.on('end', () => {
        if (buffer) {
            res.write(buffer);
        }
        if (pendingComplete) {
            onCompleted(pendingComplete).catch(err => {
                error(`[Proxy] onCompleted error: ${err.message}`);
                const normalized = normalizeResponseJson(pendingComplete);
                res.write(`data: ${JSON.stringify(normalized)}\n\n`);
                res.end();
            });
        } else {
            res.end();
        }
    });
}

const server = http.createServer((req, res) => {
    activeRequests++;
    let decremented = false;
    const decrement = () => {
        if (!decremented) {
            activeRequests--;
            decremented = true;
        }
    };
    res.on('finish', decrement);
    res.on('close', decrement);

    const isModels = req.method === 'GET' && req.url.startsWith('/v1/models');
    const isResponses = req.method === 'POST' && req.url.startsWith('/v1/responses');

    const getTargetPortForModel = async (modelName) => {
        if (!modelName) return TARGET_PORT;
        
        // Support explicit port in model name for testing/direct access: "some-model:11438"
        if (modelName.includes(':')) {
            const parts = modelName.split(':');
            const port = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(port)) return port;
        }

        // Qwen special case (still useful as a default mapping)
        if (modelName === 'qwen2.5-0.5b' && BACKEND_PORTS.includes(11438)) return 11438;

        // Try to find which backend has this model
        for (const port of BACKEND_PORTS) {
            const result = await new Promise((resolve) => {
                const req = http.request({
                    hostname: TARGET_HOST,
                    port: port,
                    path: '/v1/models',
                    method: 'GET',
                    headers: { 'host': `${TARGET_HOST}:${port}` }
                });
                req.on('response', (res) => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(body);
                            const models = json.models || json.data || [];
                            if (models.some(m => (m.name || m.id) === modelName || m.slug === modelName)) {
                                resolve(port);
                            } else {
                                resolve(null);
                            }
                        } catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(200, () => { req.destroy(); resolve(null); });
                req.end();
            });
            if (result) return result;
        }

        return TARGET_PORT;
    };

    const createProxyReq = (options = {}, targetPort = TARGET_PORT) => {
        const cleanHeaders = { ...req.headers };
        delete cleanHeaders['host'];
        delete cleanHeaders['content-length'];
        delete cleanHeaders['transfer-encoding'];
        delete cleanHeaders['connection'];

        const { headers: extraHeaders = {}, ...restOptions } = options;

        const proxyReq = http.request({
            hostname: TARGET_HOST,
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: { 
                ...cleanHeaders, 
                'host': `${TARGET_HOST}:${targetPort}`,
                'connection': 'keep-alive',
                ...extraHeaders
            },
            ...restOptions
        });
        
        proxyReq.on('error', (err) => {
            error(`Upstream Error (${req.method} ${req.url} -> ${targetPort}): ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Upstream server unavailable", details: err.message }));
            }
        });

        proxyReq.setTimeout(0);
        return proxyReq;
    };

    // Helper to fetch server properties dynamically
    const getUpstreamProps = (port = TARGET_PORT) => {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value = {}) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const propsReq = http.get(`http://${TARGET_HOST}:${port}/props`, (propsRes) => {
                let data = '';
                propsRes.on('data', c => data += c);
                propsRes.on('end', () => {
                    try {
                        finish(JSON.parse(data));
                    } catch {
                        finish({});
                    }
                });
                propsRes.on('error', () => finish({}));
            });

            propsReq.on('error', () => finish({}));
            propsReq.setTimeout(500, () => {
                propsReq.destroy(new Error('Upstream props request timed out'));
                finish({});
            });
        });
    };

    if (isModels) {
        Promise.all(BACKEND_PORTS.map(port => {
            return new Promise((resolve) => {
                const proxyReq = http.request({
                    hostname: TARGET_HOST,
                    port: port,
                    path: req.url,
                    method: req.method,
                    headers: { 'host': `${TARGET_HOST}:${port}` }
                });
                proxyReq.on('response', (proxyRes) => {
                    let bodyChunks = [];
                    proxyRes.on('data', chunk => bodyChunks.push(chunk));
                    proxyRes.on('end', async () => {
                        const data = Buffer.concat(bodyChunks).toString();
                        const props = await getUpstreamProps(port);
                        try {
                            const json = JSON.parse(data);
                            resolve({ json, props, statusCode: proxyRes.statusCode });
                        } catch (e) {
                            resolve(null);
                        }
                    });
                });
                proxyReq.on('error', () => resolve(null));
                proxyReq.end();
            });
        })).then(results => {
            let allModels = [];
            let statusCode = 502;
            for (const result of results) {
                if (result && result.json) {
                    const models = result.json.models || result.json.data || [];
                    if (Array.isArray(models)) {
                        statusCode = 200;
                        const enhancedModels = models.map(m => {
                            const capabilities = ["completion"];
                            if (result.props.modalities?.vision) capabilities.push("multimodal", "vision");
                            
                            const name = m.name || m.id || m.model || MODEL_TEMPLATE.slug;
                            return { 
                                ...MODEL_TEMPLATE, 
                                ...m,
                                name: name,
                                slug: m.slug || name,
                                display_name: m.display_name || name,
                                capabilities: capabilities
                            };
                        });
                        allModels = allModels.concat(enhancedModels);
                    }
                }
            }

            if (statusCode === 200) {
                const body = JSON.stringify({ object: "list", models: allModels });
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
                res.end(body);
            } else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "No upstream servers available" }));
            }
        });
        return;
    }

    if (isResponses) {
        let bodyChunks = [];
        req.on('data', chunk => bodyChunks.push(chunk));
        req.on('end', async () => {
            const body = Buffer.concat(bodyChunks).toString();
            try {
                const json = JSON.parse(body);
                const targetPort = await getTargetPortForModel(json.model);
                log(`[Proxy] Request: ${json.model} (stream=${!!json.stream}) -> port ${targetPort} non_stop=${NON_STOP_MODE}`);
                logFull({
                    type: 'request',
                    model: json.model,
                    stream: !!json.stream,
                    target_port: targetPort,
                    max_output_tokens: json.max_output_tokens,
                    temperature: json.temperature,
                    tools: json.tools?.map(t => t.name || t.function?.name),
                    input_count: Array.isArray(json.input) ? json.input.length : undefined,
                    req_headers: req.headers,
                    body: sanitizeForLog(json)
                });

                if (Array.isArray(json.input)) {
                    json.input = json.input.flatMap(item => {
                        return normalizeInputItem(item);
                    }).filter(Boolean).filter(item => !item.content || item.content.length > 0);
                }

                if (Array.isArray(json.tools)) {
                    json.tools = json.tools.filter(t => {
                        if (t.type === 'function' || t.function) {
                            if (t.function && typeof t.function === 'object') {
                                const func = t.function;
                                t.name = func.name;
                                t.description = func.description;
                                t.parameters = func.parameters;
                                t.strict = func.strict ?? true;
                                delete t.function;
                                t.type = 'function';
                            }
                            return true;
                        }
                        return false;
                    });
                }
                
                const patchedBody = JSON.stringify(json);
                const proxyReq = createProxyReq({
                    headers: { 'content-length': Buffer.byteLength(patchedBody) }
                }, targetPort);
                
                proxyReq.on('response', (proxyRes) => {
                    if (!json.stream) {
                        let resChunks = [];
                        proxyRes.on('data', chunk => resChunks.push(chunk));
                        proxyRes.on('end', () => {
                            const resData = Buffer.concat(resChunks).toString();
                            try {
                                const resJson = normalizeResponseJson(JSON.parse(resData));
                                const finalBody = JSON.stringify(resJson);
                                const headers = { ...proxyRes.headers };
                                delete headers['content-length'];
                                delete headers['transfer-encoding'];
                                headers['content-length'] = Buffer.byteLength(finalBody);
                                res.writeHead(proxyRes.statusCode, headers);
                                res.end(finalBody);
                                logFull({
                                    type: 'response',
                                    model: json.model,
                                    status: proxyRes.statusCode,
                                    res_headers: proxyRes.headers,
                                    body: sanitizeForLog(resJson)
                                });
                            } catch (e) {
                                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                                res.end(resData);
                                logFull({
                                    type: 'response_raw',
                                    model: json.model,
                                    status: proxyRes.statusCode,
                                    res_headers: proxyRes.headers,
                                    body: sanitizeForLog(resData)
                                });
                            }
                        });
                    } else {
                        log(`[Proxy] Streaming started for ${json.model}`);
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);

                        let finishReason = null;
                        let usage = null;
                        let textOutput = '';

                        createSseNormalizer(proxyRes, res, {
                            onRawEvent(parsed) {
                                logFull({ type: 'sse_upstream', model: json.model, event: parsed });

                                if (parsed.choices?.[0]?.finish_reason) {
                                    finishReason = parsed.choices[0].finish_reason;
                                }
                                if (parsed.usage) usage = parsed.usage;
                                if (parsed.type === 'response.completed' && parsed.response) {
                                    finishReason = parsed.response.status;
                                    usage = parsed.response.usage;
                                }
                            },
                            onNormalizedEvent(normalized) {
                                logFull({ type: 'sse_proxy', model: json.model, event: normalized });

                                if (normalized.type === 'response.output_text.delta' && typeof normalized.delta === 'string') {
                                    textOutput += normalized.delta;
                                }

                                if (normalized.type === 'response.output_text.done' && typeof normalized.text === 'string') {
                                    textOutput = normalized.text;
                                }

                                if (normalized.type === 'response.output_item.done') {
                                    const item = normalized.item;
                                    const itemText = item?.content?.find?.(c => c.type === 'output_text')?.text;
                                    if (typeof itemText === 'string' && itemText) {
                                        textOutput = itemText;
                                    }
                                }
                            },
                            async onCompleted(completedEvent) {
                                const output = completedEvent.response?.output ?? [];
                                const hasFunctionCall = output.some(i => i.type === 'function_call');
                                const completedText = output
                                    .find(i => i.type === 'message')
                                    ?.content?.find(c => c.type === 'output_text')?.text;
                                const textContent = textOutput || completedText || '';
                                const hasTools = Array.isArray(json.tools) && json.tools.length > 0;

                                log(`[Proxy] Completed gate for ${json.model}: tools=${hasTools} function_call=${hasFunctionCall} text=${Boolean(textContent)}`);

                                let mergedOutput = output;
                                let injectedItems = [];

                                if (!hasFunctionCall && hasTools) {
                                    // Follow-up for both empty responses and text-only responses
                                    if (!textContent) {
                                        log(`[Proxy] Empty agentic response for ${json.model}; sending empty-response follow-up`);
                                    } else {
                                        log(`[Proxy] Text-only agentic response for ${json.model}; sending follow-up`);
                                    }
                                    const fcItems = await doFollowUp(json, textContent, targetPort);
                                    injectedItems = fcItems;

                                    // Proactive Injection for NON_STOP_MODE: 
                                    // If follow-up failed to produce a tool call, and we MUST NOT STOP, synthesize one.
                                    if (injectedItems.length === 0 && NON_STOP_MODE) {
                                        log(`[Proxy] NON_STOP_MODE: No tool call after follow-up. Proactively injecting 'read_thread_terminal' to keep loop alive.`);
                                        const dummyFc = {
                                            type: 'function_call',
                                            id: `fc_proxy_${Math.random().toString(36).slice(2, 11)}`,
                                            name: 'read_thread_terminal',
                                            arguments: '{}'
                                        };
                                        injectedItems = [dummyFc];
                                    }

                                    if (injectedItems.length > 0) {
                                        log(`[Proxy] Injecting ${injectedItems.length} item(s) for ${json.model}`);
                                        let outputIndex = output.length;
                                        for (const fc of injectedItems) {
                                            const addedEvt = { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id: fc.id, call_id: fc.call_id, name: fc.name, arguments: '' } };
                                            const deltaEvt = { type: 'response.function_call_arguments.delta', item_id: fc.id, output_index: outputIndex, delta: fc.arguments ?? '' };
                                            const doneArgEvt = { type: 'response.function_call_arguments.done', item_id: fc.id, output_index: outputIndex, arguments: fc.arguments ?? '' };
                                            const itemDoneEvt = { type: 'response.output_item.done', output_index: outputIndex, item: fc };
                                            for (const evt of [addedEvt, deltaEvt, doneArgEvt, itemDoneEvt]) {
                                                logFull({ type: 'sse_proxy', model: json.model, event: evt });
                                                res.write(`data: ${JSON.stringify(evt)}\n\n`);
                                            }
                                            outputIndex++;
                                        }
                                        mergedOutput = [...output, ...injectedItems];
                                    }
                                }

                                const mergedCompleted = mergedOutput === output ? completedEvent : {
                                    ...completedEvent,
                                    response: { ...completedEvent.response, output: mergedOutput }
                                };
                                const normalized = normalizeResponseJson(mergedCompleted);
                                logFull({ type: 'sse_proxy', model: json.model, event: normalized });
                                res.write(`data: ${JSON.stringify(normalized)}\n\n`);
                                res.end();
                            }
                        });

                        proxyRes.on('end', () => {
                            log(`[Proxy] Streaming finished for ${json.model}`);
                            logFull({
                                type: 'stream_end',
                                model: json.model,
                                status: proxyRes.statusCode,
                                res_headers: proxyRes.headers,
                                finish_reason: finishReason,
                                usage
                            });
                        });
                    }
                });
                proxyReq.write(patchedBody);
                proxyReq.end();
            } catch (e) {
                log(`[Proxy] Failed to patch request, falling back: ${e.message}`);
                // fallback route uses default port
                const proxyReq = createProxyReq();
                proxyReq.on('response', (proxyRes) => {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    proxyRes.pipe(res);
                });
                proxyReq.write(body);
                proxyReq.end();
            }
        });
        return;
    }

    const proxyReq = createProxyReq();
    proxyReq.on('response', (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
    log(`[llama-cpp-agent-proxy] Listening on 0.0.0.0:${PROXY_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});

function restartLlamaService(serviceName, reason) {
    log(`[Monitor] Restarting ${serviceName} service. Reason: ${reason}`);
    exec(`sudo -n systemctl restart ${serviceName}`, (err, stdout, stderr) => {
        if (err) {
            error(`[Monitor] Failed to restart ${serviceName}: ${err.message}`);
        } else {
            log(`[Monitor] ${serviceName} restarted successfully.`);
        }
    });
}

function getGpuMetrics() {
    try {
        const busyPath = '/sys/class/drm/card0/device/gpu_busy_percent';
        if (!fs.existsSync(busyPath)) return null;
        const busy = parseInt(fs.readFileSync(busyPath, 'utf8').trim(), 10);
        
        // Find power path dynamically
        const hwmonDir = '/sys/class/drm/card0/device/hwmon';
        if (!fs.existsSync(hwmonDir)) return { busy, power: 0 };
        
        const hwmons = fs.readdirSync(hwmonDir);
        let power = 0;
        for (const h of hwmons) {
            const pPath = `${hwmonDir}/${h}/power1_average`;
            if (fs.existsSync(pPath)) {
                power = parseInt(fs.readFileSync(pPath, 'utf8').trim(), 10) / 1000000; // Watts
                break;
            }
        }
        return { busy, power };
    } catch (e) {
        error(`[Monitor] Failed to get GPU metrics: ${e.message}`);
        return null;
    }
}

function checkStuckServer(serviceName) {
    // Disabled: too aggressive, kills all llama-server instances when one is busy.
    return;
}

// 1. Regular liveness ping (once a minute)
if (MONITOR_ENABLED) {
    setInterval(() => {
        for (let i = 0; i < BACKEND_PORTS.length; i++) {
            const port = BACKEND_PORTS[i];
            const serviceName = BACKEND_SERVICES[i] || BACKEND_SERVICES[0];

            if (i === 0) checkStuckServer(serviceName);

            const options = {
                hostname: TARGET_HOST,
                port: port,
                path: '/health',
                method: 'GET',
                timeout: 10000
            };

            const req = http.request(options, (res) => {
                if (res.statusCode !== 200) {
                    restartLlamaService(serviceName, `Upstream ${port} /health returned status ${res.statusCode}`);
                }
            });

            req.on('error', (err) => {
                restartLlamaService(serviceName, `Upstream ${port} /health connection error: ${err.message}`);
            });

            req.on('timeout', () => {
                req.destroy();
                restartLlamaService(serviceName, `Upstream ${port} /health timed out`);
            });

            req.end();
        }
    }, 60000);

    // 2. Scheduled restart (every 30 minutes)
    setInterval(() => {
        for (const serviceName of BACKEND_SERVICES) {
            restartLlamaService(serviceName, 'Scheduled 30-minute restart');
        }
    }, 30 * 60 * 1000);
}
