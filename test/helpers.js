import http from 'node:http';

/**
 * Find an available TCP port by binding to port 0 and reading the assigned port.
 * Returns a single port; callers should close the socket when done.
 */
export async function getAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

/**
 * Start a mock upstream HTTP server and return { server, port }.
 * The port is auto-selected so it never conflicts with other tests.
 * If port is specified, it will listen on that port instead.
 * If the port is already in use, the server will still resolve (but may not be ready).
 */
export function startMockUpstream(onReq, port = null) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(onReq);
        const listenPort = port !== null ? port : 0;
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Port already in use - resolve anyway
                resolve({ server, port: listenPort });
            } else {
                reject(err);
            }
        });
        server.listen(listenPort, '127.0.0.1', () => {
            server.unref();
            resolve({ server, port: server.address().port });
        });
    });
}

/**
 * Start a mock upstream HTTP server on multiple ports.
 * Returns { servers, ports } where each server responds to the same onReq handler.
 */
export function startMockUpstreamMulti(onReq, ports) {
    return new Promise((resolve) => {
        const servers = [];
        let allResolved = false;
        let resolvedCount = 0;
        const resolveAll = () => {
            if (allResolved) return;
            allResolved = true;
            resolve({ servers, ports: servers.map(s => s.address().port) });
        };
        for (const port of ports) {
            const server = http.createServer(onReq);
            server.listen(port, '127.0.0.1', () => {
                server.unref();
                servers.push(server);
                resolvedCount++;
                if (resolvedCount === ports.length) {
                    resolveAll();
                }
            });
            server.on('error', (err) => {
                // port already in use, skip
            });
        }
    });
}
