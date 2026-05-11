# llama-cpp-codex-proxy

A high-performance, transparent compatibility bridge between **Codex** (and other OpenAI-compatible agents) and **llama-server**.

## Features

- **Transparent Mirroring**: Directly pipes all traffic by default, supporting **Streaming (SSE)** perfectly.
- **Agentic Tool Flattening**: Automatically converts nested OpenAI function definitions into the flat format required by `llama-server`'s `/v1/responses` endpoint.
- **Exhaustive Metadata Patching**: Injects mandatory contract fields (`slug`, `display_name`, `supported_reasoning_levels`, etc.) to satisfy strict client-side model managers.
- **Reasoning Level Support**: Advertises and maps reasoning levels (Minimal, Low, Medium, High, Extra High) for local models.
- **Network Ready**: Binds to `0.0.0.0` for full LAN accessibility.

## Quick Start

1. Ensure `node` (v20+) is installed.
2. Run your `llama-server` on port `11435`.
3. Start the proxy:
   ```bash
   node index.mjs
   ```
4. Point your client to `http://<your-ip>:11437/v1`.

## Why is this needed?

While `llama-server` is extremely fast, its implementation of the newer `/v1/responses` endpoint is stricter than standard OpenAI. This proxy handles the "surgically required" patches to make agentic workflows seamless without sacrificing the raw performance of `llama.cpp`.
