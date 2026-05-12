import http from "node:http";
import fs from "node:fs";

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);
const PROXY_PORT = parseInt(process.env.PORT || '11437', 10);
const LOG_FILE = "proxy.log";

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    fs.appendFileSync(LOG_FILE, line + "\n");
    console.log(line);
}

function error(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ERROR: ${msg}`;
    fs.appendFileSync(LOG_FILE, line + "\n");
    console.error(line);
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

function normalizeContentPart(part) {
    if (!part || typeof part !== 'object') return part;

    if (part.type === 'text' || part.type === 'output_text' || !part.type) {
        part.type = 'input_text';
    }

    if (part.type === 'image_url' || (part.type === 'image' && part.image_url)) {
        part.type = 'input_image';
        const url = typeof part.image_url === 'object' ? part.image_url.url : part.image_url;
        part.image_url = url;
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
    });
}

const server = http.createServer((req, res) => {
    const isModels = req.method === 'GET' && req.url.startsWith('/v1/models');
    const isResponses = req.method === 'POST' && req.url.startsWith('/v1/responses');

    const createProxyReq = (options = {}) => {
        const cleanHeaders = { ...req.headers };
        delete cleanHeaders['host'];
        delete cleanHeaders['content-length'];
        delete cleanHeaders['transfer-encoding'];
        delete cleanHeaders['connection'];

        const proxyReq = http.request({
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: req.url,
            method: req.method,
            headers: { 
                ...cleanHeaders, 
                'host': `${TARGET_HOST}:${TARGET_PORT}`,
                'connection': 'keep-alive'
            },
            ...options
        });
        
        proxyReq.on('error', (err) => {
            error(`Upstream Error (${req.method} ${req.url}): ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Upstream server unavailable", details: err.message }));
            }
        });

        proxyReq.setTimeout(0);
        return proxyReq;
    };

    // Helper to fetch server properties dynamically
    const getUpstreamProps = () => {
        return new Promise((resolve) => {
            http.get(`http://${TARGET_HOST}:${TARGET_PORT}/props`, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({}); }
                });
            }).on('error', () => resolve({})).setTimeout(500);
        });
    };

    if (isModels) {
        const proxyReq = createProxyReq();
        proxyReq.on('response', (proxyRes) => {
            let bodyChunks = [];
            proxyRes.on('data', chunk => bodyChunks.push(chunk));
            proxyRes.on('end', async () => {
                const data = Buffer.concat(bodyChunks).toString();
                const props = await getUpstreamProps();
                
                try {
                    const json = JSON.parse(data);
                    if (Array.isArray(json.models)) {
                        json.models = json.models.map(m => {
                            const capabilities = ["completion"];
                            if (props.modalities?.vision) capabilities.push("multimodal", "vision");
                            
                            return { 
                                ...MODEL_TEMPLATE, 
                                ...m,
                                slug: m.slug || m.name || m.model || MODEL_TEMPLATE.slug,
                                display_name: m.display_name || m.name || m.model || MODEL_TEMPLATE.display_name,
                                capabilities: capabilities
                            };
                        });
                    }
                    const body = JSON.stringify(json);
                    const headers = { ...proxyRes.headers };
                    delete headers['content-length'];
                    delete headers['transfer-encoding'];
                    headers['content-length'] = Buffer.byteLength(body);
                    res.writeHead(proxyRes.statusCode, headers);
                    res.end(body);
                } catch (e) {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(data);
                }
            });
        });
        proxyReq.end();
        return;
    }

    if (isResponses) {
        let bodyChunks = [];
        req.on('data', chunk => bodyChunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(bodyChunks).toString();
            try {
                const json = JSON.parse(body);
                log(`[Proxy] Request: ${json.model} (stream=${!!json.stream})`);

                if (Array.isArray(json.input)) {
                    json.input = json.input.map(item => {
                        if (item.role === 'tool' && item.type !== 'function_call_output') {
                            item.type = 'function_call_output';
                            if (!item.call_id && item.tool_call_id) item.call_id = item.tool_call_id;
                            if (item.output === undefined && item.content !== undefined) {
                                item.output = item.content;
                                delete item.content;
                            }
                            delete item.role;
                            delete item.tool_call_id;
                        } else if (item.type !== 'function_call_output') {
                            item.type = 'message';
                            if (!item.role) item.role = 'assistant';
                        }

                        log(`[Proxy] Debug: Processing item: ${JSON.stringify(item)}`);

                        if (item.type === 'function_call_output') {
                            if (item.output === undefined && item.content !== undefined) {
                                item.output = item.content;
                                delete item.content;
                            }
                            item.output = normalizeToolOutput(item.output);
                        } else if (Array.isArray(item.content)) {
                            item.content = item.content.map(normalizeContentPart);
                        } else if (typeof item.content === 'string') {
                            item.content = [{ type: 'input_text', text: item.content }];
                        }

                        return item;
                    });
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
                const proxyReq = createProxyReq();
                proxyReq.setHeader('content-length', Buffer.byteLength(patchedBody));
                
                proxyReq.on('response', (proxyRes) => {
                    if (!json.stream) {
                        let resChunks = [];
                        proxyRes.on('data', chunk => resChunks.push(chunk));
                        proxyRes.on('end', () => {
                            const resData = Buffer.concat(resChunks).toString();
                            try {
                                const resJson = JSON.parse(resData);
                                if (Array.isArray(resJson.output)) {
                                    resJson.output.forEach(item => {
                                        if (item.type === 'reasoning' && !item.summary) {
                                            item.summary = [{ type: "summary_text", text: "Reasoning trace..." }];
                                        }
                                    });
                                }
                                const finalBody = JSON.stringify(resJson);
                                const headers = { ...proxyRes.headers };
                                delete headers['content-length'];
                                delete headers['transfer-encoding'];
                                headers['content-length'] = Buffer.byteLength(finalBody);
                                res.writeHead(proxyRes.statusCode, headers);
                                res.end(finalBody);
                            } catch (e) {
                                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                                res.end(resData);
                            }
                        });
                    } else {
                        log(`[Proxy] Streaming started for ${json.model}`);
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(res);
                        proxyRes.on('end', () => log(`[Proxy] Streaming finished for ${json.model}`));
                    }
                });
                proxyReq.write(patchedBody);
                proxyReq.end();
            } catch (e) {
                log(`[Proxy] Failed to patch request, falling back: ${e.message}`);
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
