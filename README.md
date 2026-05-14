# llama-cpp-agent-proxy

A high-performance, transparent compatibility bridge between **Codex** (and other OpenAI-compatible agents) and **llama-server**.

## Features

- **Transparent Mirroring**: Directly pipes all traffic by default, supporting **Streaming (SSE)** perfectly.
- **Agentic Tool Flattening**: Automatically converts nested OpenAI function definitions into the flat format required by `llama-server`'s `/v1/responses` endpoint.
- **Response Content Normalization**: Rewrites assistant message content into OpenAI-friendly `output_text` / `refusal` parts and preserves reasoning-only responses instead of collapsing them to empty output.
- **Exhaustive Metadata Patching**: Injects mandatory contract fields (`slug`, `display_name`, `supported_reasoning_levels`, etc.) to satisfy strict client-side model managers.
- **Reasoning Level Support**: Advertises and maps reasoning levels (Minimal, Low, Medium, High, Extra High) for local models.
- **Network Ready**: Binds to `0.0.0.0` for full LAN accessibility.

## Quick Start

1. Ensure `node` (v20+) is installed.
2. Run your `llama-server` on port `11435`.
3. Start the proxy:
   ```bash
   node index.js
   ```
4. Point your client to `http://<your-ip>:11437/v1`.

### Environment Variables

Copy `.env.example` to `.env` and adjust values as needed. The proxy supports the following variables:

- `TARGET_HOST` — Host of the upstream `llama-server` (default: `127.0.0.1`).
- `TARGET_PORT` — Port of the upstream `llama-server` (default: `11435`).
- `PORT` — Port the proxy listens on (default: `11437`).
- `LOG_FILE` — Path to concise log file (default: `proxy.log`).
- `FULL_LOG_FILE` — Path to full log file (default: `proxy-full.log`).
- `NON_STOP_MODE` — When `true`, the proxy sends follow-up prompts that encourage the model to continue working on the backlog or live-testing/fixing/polishing the app according to documentation flows instead of just calling a tool. `FINISHED` is NOT accepted as a completion signal when `NON_STOP_MODE` is `true`. Default: `false` (disabled, `FINISHED` is accepted).

### Two Proxy Instances

Run two proxy instances on different ports so different agents can use different modes:

#### Quick start (foreground)

```bash
bash scripts/run-two-proxies.sh
```

This starts:
- **Port 11451** — `NON_STOP_MODE=true` (FINISHED rejected, encourages backlog/polishing)
- **Port 11450** — `NON_STOP_MODE=false` (FINISHED accepted, standard mode)

Each agent connects to its designated proxy URL:
- Non-stop agent: `http://localhost:11451/v1`
- Stop agent: `http://localhost:11450/v1`

#### Persistent services (recommended)

Install both as background services:

```bash
bash scripts/install-two-services.sh
```

Uninstall both:

```bash
bash scripts/uninstall-two-services.sh
```

## Run as a service

Use the installer to register the proxy as a user service on macOS (LaunchAgent) or Ubuntu/Linux (systemd user):

```bash
bash scripts/install-service.sh
```

Running the installer again performs a clean reinstall: it stops the existing service, kills any running
proxy process for this repo, and starts the service again with the updated configuration.

You can override the defaults with `TARGET_HOST`, `TARGET_PORT`, `PORT`, or `--service-name`.

To remove the service again:

```bash
bash scripts/uninstall-service.sh
```

Uninstall performs a clean shutdown too: it stops the managed service and kills any running proxy
process for this repo before removing the user service definition.

## Testing

Run the local test suite with:

```bash
npm test
```

The suite includes a live regression test for the text-only agentic failure mode. Enable it with:

```bash
RUN_LIVE_PROXY_TESTS=1 npm test
```

That live check expects the proxy to be running on `11437` and watches `proxy-full.log` for the
follow-up request and injected tool-call events.

## Observability

`proxy.log` contains the concise request/stream summary, while `proxy-full.log` records sanitized
request bodies, upstream SSE events, proxy-normalized SSE events, follow-up retries, and terminal
stream summaries.

## Multimodal image input

For image requests, use a vision-capable `llama-server` model with a matching `--mmproj`.
If you want to load local files, set `--media-path` and keep the path slash-terminated, then send
`input_image` parts with `image_url` values like `file://test.png`.

Remote `http(s)` image URLs also work when the upstream model supports vision.

## Why is this needed?

While `llama-server` is extremely fast, its implementation of the newer `/v1/responses` endpoint is stricter than standard OpenAI. This proxy handles the "surgically required" patches to make agentic workflows seamless without sacrificing the raw performance of `llama.cpp`.

This proxy stays entirely local; it only forwards requests between your client and the `llama-server` endpoint you configure on the same machine.
