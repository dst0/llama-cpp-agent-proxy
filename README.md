# llama-cpp-agent-proxy

A high-performance, transparent compatibility bridge between **Codex** (and other OpenAI-compatible agents) and **llama-server**.

## Features

- **Transparent Mirroring**: Directly pipes all traffic by default, supporting **Streaming (SSE)** perfectly.
- **Dynamic Multi-Backend Routing**: Automatically discovers models across multiple `llama-server` instances and routes requests to the correct backend based on the requested model name.
- **Agentic Tool Flattening**: Automatically converts nested OpenAI function definitions into the flat format required by `llama-server`'s `/v1/responses` endpoint.
- **Response Content Normalization**: Rewrites assistant message content into OpenAI-friendly `output_text` / `refusal` parts and preserves reasoning-only responses instead of collapsing them to empty output.
- **Exhaustive Metadata Patching**: Injects mandatory contract fields (`slug`, `display_name`, `supported_reasoning_levels`, etc.) to satisfy strict client-side model managers.
- **Liveness Monitoring**: Background monitoring for all backends with automatic service restarts if an upstream instance becomes unresponsive or fails health checks.
- **Network Ready**: Binds to `0.0.0.0` for full LAN accessibility.

## Unified Two-Port Architecture

The proxy runs as a single unified process that manages both ports (Standard and Non-Stop) and all backends. This provides a unified status view and serialized backend queuing.

- **Port 11450 (Standard Mode)**: Accepts `FINISHED` responses. Use this for standard agentic workflows.
- **Port 11451 (Non-Stop Mode)**: Rejects `FINISHED` responses from models. Even if a model claims to be done, the proxy forces it to continue.

### Observability & Status

The proxy provides a unified status API and SSE stream:
- **Status API**: `http://localhost:11450/v1/status` (Returns JSON)
- **Status SSE**: `http://localhost:11450/v1/status/events` (Live stream of backend and queue states)

### Loop Integrity (Multi-stage Recovery)

In **both modes**, if a model fails to call a tool while work is still pending (and hasn't signaled `FINISHED` in Standard Mode), the proxy initiates a recovery flow:
  1. **Retry**: Resends the original prompt to give the model a second chance.
  2. **Review**: Asks the model to review its response and explicitly call a tool.
  3. **Injection**: If all else fails, proactively injects a fallback tool call (e.g., `ls -F`) with a valid `call_id` and reasoning to prevent the agentic loop from stalling.

### Backend Configuration (GPU & CPU)

The proxy supports routing to specialized backends:

1.  **Main Model (`llama-server-main`)**:
    - **Port**: `11435`
    - **Execution**: Full GPU (Vulkan/ROCm)
    - **Optimized**: 64k Context window with `iq4_nl` KV cache quantization to fit 27B+ models in 16GB VRAM.
2.  **Micro Model (`lms-micro`)**:
    - **Port**: `11438`
    - **Execution**: Strict CPU (AVX2) using `--n-gpu-layers 0`.
    - **Optimized**: Fast, low-latency responses for simple tasks.

## Quick Start

### 1. Install Backend Services

Run the specialized installer to set up both GPU and CPU backend instances:

```bash
sudo bash scripts/install-llama-services.sh
```

To uninstall backends:

```bash
sudo bash scripts/uninstall-llama-services.sh
```

### 2. Install Proxy Services

Install both the Standard and Non-Stop proxy instances as persistent background services:

```bash
bash scripts/install-two-services.sh
```

### 3. Usage

Point your agents to the desired proxy:
- **Non-stop agent**: `http://localhost:11451/v1`
- **Standard agent**: `http://localhost:11450/v1`

## Environment Variables

The proxy supports the following variables (configured automatically by the scripts, or via `.env` file):

- `BACKEND_PORTS` — Comma-separated list of upstream ports (default: `11435,11438`).
- `BACKEND_SERVICES` — Comma-separated list of systemd service names for monitoring (default: `llama-server-main,lms-micro`).
- `PORT` — Port the proxy listens on (e.g., `11450` or `11451`).
- `NON_STOP_MODE` — When `true`, enables the "never finished" agentic behavior.
- `MONITOR_ENABLED` — Enables background liveness monitoring and auto-restarts (default: `true`).
- `LOG_DIR` — Directory for logs (default: `/home/dst/.llama-cpp-agent-proxy/logs`).
- `LOG_FILE` — Path to concise log file (default: `proxy.log` in `LOG_DIR`).

### Busy Redirect (MLX Backend Fallback)

When the main llama-server is busy (already handling a request), the proxy can redirect to an MLX backend on a separate machine:

- `BUSY_REDIRECT_HOST` — Host of the MLX redirect server (default: `192.168.8.124`).
- `BUSY_REDIRECT_PORT` — Port of the MLX redirect server (default: `1234`).
- `BUSY_REDIRECT_MODEL` — Model name to use on the redirect server (default: `mtplx-qwen36-27b-optimized-speed`).
- `BUSY_REDIRECT_API_KEY` — Bearer API key for the redirect server (required if the server enforces auth).

### .env File

Copy `.env.example` to `.env` and fill in your values. The proxy reads `.env` automatically on startup (via `dotenv`). The `.env` file is git-ignored to prevent exposing secrets.

```bash
cp .env.example .env
# Edit .env with your values, especially BUSY_REDIRECT_API_KEY
```

## Observability

`proxy.log` contains concise request summaries. `proxy-full.log` records sanitized request/response bodies, SSE events, follow-up retries, and detailed metrics for debugging agentic flows.

## Multimodal Image Input

For image requests, use a vision-capable backend model with a matching `--mmproj`. Remote `http(s)` image URLs and local `file://` paths are supported.

## Why is this needed?

While `llama-server` is extremely fast, its implementation of the newer `/v1/responses` endpoint is stricter than standard OpenAI. This proxy handles the "surgically required" patches to make agentic workflows seamless without sacrificing the raw performance of `llama.cpp`.
