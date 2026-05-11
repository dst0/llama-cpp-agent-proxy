import http from "node:http";

/**
 * llama-cpp-agent-proxy
 * A transparent compatibility bridge between OpenAI Responses API clients and llama-server.
 */

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '11435', 10);
const PROXY_PORT = parseInt(process.env.PORT || '11437', 10);

// A robust "Base Template" for model metadata to ensure all required fields are present for clients.
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
    "priority": 0,
    "max_context_window": 131072,
    "base_instructions": "",
    "instructions_variables": {},
    "additional_speed_tiers": ["fast"],
    "service_tiers": [{ "id": "priority", "name": "Fast", "description": "Local priority" }]
};

const server = http.createServer((req, res) => {
    const proxyReq = http.request({
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` }
    });

    proxyReq.on('error', (err) => {
        console.error(`[Proxy] Upstream Error: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Upstream server unavailable" }));
        }
    });

    // --- INTERCEPTOR: GET /v1/models ---
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        proxyReq.on('response', (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (Array.isArray(json.models)) {
                        json.models = json.models.map(m => ({ 
                            ...MODEL_TEMPLATE, 
                            ...m,
                            slug: m.slug || m.name || m.model || MODEL_TEMPLATE.slug,
                            display_name: m.display_name || m.name || m.model || MODEL_TEMPLATE.display_name
                        }));
                    }
                    const body = JSON.stringify(json);
                    const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(body) };
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

    // --- INTERCEPTOR: POST /v1/responses ---
    if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const json = JSON.parse(body);
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
                proxyReq.setHeader('content-length', Buffer.byteLength(patchedBody));
                
                proxyReq.on('response', (proxyRes) => {
                    if (!json.stream) {
                        let resData = '';
                        proxyRes.on('data', chunk => resData += chunk);
                        proxyRes.on('end', () => {
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
                                const finalHeaders = { ...proxyRes.headers, 'content-length': Buffer.byteLength(finalBody) };
                                res.writeHead(proxyRes.statusCode, finalHeaders);
                                res.end(finalBody);
                            } catch (e) {
                                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                                res.end(resData);
                            }
                        });
                    } else {
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(res);
                    }
                });
                proxyReq.write(patchedBody);
                proxyReq.end();
            } catch (e) {
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

    // --- DEFAULT: Transparent Proxy ---
    proxyReq.on('response', (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
    console.log(`[llama-cpp-agent-proxy] Listening on 0.0.0.0:${PROXY_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
