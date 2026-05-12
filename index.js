import http from "node:http";
import fs from "node:fs";

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);
const PROXY_PORT = parseInt(process.env.PORT || '11437', 10);
const LOG_FILE = process.env.LOG_FILE || 'proxy.log';
const FULL_LOG_FILE = process.env.FULL_LOG_FILE || 'proxy-full.log';
const LOG_STREAM = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const FULL_LOG_STREAM = fs.createWriteStream(FULL_LOG_FILE, { flags: 'a' });

LOG_STREAM.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ERROR: Failed to write log file ${LOG_FILE}: ${err.message}`);
});
FULL_LOG_STREAM.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ERROR: Failed to write full log file ${FULL_LOG_FILE}: ${err.message}`);
});

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    LOG_STREAM.write(line + "\n");
    console.log(line);
}

function error(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ERROR: ${msg}`;
    LOG_STREAM.write(line + "\n");
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
    FULL_LOG_STREAM.write(line + '\n');
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
    "service_tiers": [{ "id": "priority", "name": "Fast", "description": "Local priority" }]
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

    if (item.role === 'assistant' && Array.isArray(item.content) && item.content.length === 0) {
        return null;
    }

    return item;
}

function createSseNormalizer(proxyRes, res, { onEvent } = {}) {
    let buffer = '';

    proxyRes.setEncoding('utf8');
    proxyRes.on('data', chunk => {
        buffer += chunk;

        let boundaryIndex;
        while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);

            const normalizedEvent = rawEvent.split('\n').map(line => {
                if (!line.startsWith('data:')) return line;

                const payload = line.slice(5).trimStart();
                if (!payload || payload === '[DONE]') return line;

                try {
                    const parsed = JSON.parse(payload);
                    if (onEvent) onEvent(parsed);
                    return `data: ${JSON.stringify(normalizeResponseJson(parsed))}`;
                } catch {
                    return line;
                }
            }).join('\n');

            res.write(normalizedEvent + '\n\n');
        }
    });

    proxyRes.on('end', () => {
        if (buffer) {
            res.write(buffer);
        }
        res.end();
    });
}

const server = http.createServer((req, res) => {
    const isModels = req.method === 'GET' && req.url.startsWith('/v1/models');
    const isResponses = req.method === 'POST' && req.url.startsWith('/v1/responses');

    const getTargetPortForModel = (modelName) => {
        if (modelName === 'qwen2.5-0.5b') return 11438;
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
        const ports = [TARGET_PORT, 11438];
        Promise.all(ports.map(port => {
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
                if (result && result.json && Array.isArray(result.json.models)) {
                    statusCode = 200;
                    const enhancedModels = result.json.models.map(m => {
                        const capabilities = ["completion"];
                        if (result.props.modalities?.vision) capabilities.push("multimodal", "vision");
                        
                        return { 
                            ...MODEL_TEMPLATE, 
                            ...m,
                            slug: m.slug || m.name || m.model || MODEL_TEMPLATE.slug,
                            display_name: m.display_name || m.name || m.model || MODEL_TEMPLATE.display_name,
                            capabilities: capabilities
                        };
                    });
                    allModels = allModels.concat(enhancedModels);
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
        req.on('end', () => {
            const body = Buffer.concat(bodyChunks).toString();
            try {
                const json = JSON.parse(body);
                const targetPort = getTargetPortForModel(json.model);
                log(`[Proxy] Request: ${json.model} (stream=${!!json.stream}) -> port ${targetPort}`);
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
                    }).filter(Boolean);
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

                        let textOutput = '';
                        let finishReason = null;
                        let usage = null;

                        createSseNormalizer(proxyRes, res, {
                            onEvent(parsed) {
                                // Accumulate text deltas
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content) textOutput += delta.content;
                                if (delta?.reasoning_content) textOutput += delta.reasoning_content;

                                // Capture finish metadata
                                if (parsed.choices?.[0]?.finish_reason) {
                                    finishReason = parsed.choices[0].finish_reason;
                                }
                                if (parsed.usage) usage = parsed.usage;

                                // Also handle responses API event format
                                if (parsed.type === 'response.completed' && parsed.response) {
                                    finishReason = parsed.response.status;
                                    usage = parsed.response.usage;
                                }
                                if (parsed.type === 'response.output_text.done') {
                                    textOutput = parsed.text ?? textOutput;
                                }
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
                                usage,
                                output_text: textOutput || undefined
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
