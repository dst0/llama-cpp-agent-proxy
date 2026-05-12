# llama-cpp-agent-proxy

A high-performance, transparent compatibility bridge between **Codex** (and other OpenAI-compatible agents) and **llama-server**.

## Features

- **Transparent Mirroring**: Directly pipes all traffic by default, supporting **Streaming (SSE)** perfectly.
- **Agentic Tool Flattening**: Automatically converts nested OpenAI function definitions into the flat format required by `llama-server`'s `/v1/responses` endpoint.
- **Response Content Normalization**: Rewrites assistant message content into OpenAI-friendly `output_text` / `refusal` parts and strips unsupported reasoning content.
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

## Multimodal image input

For image requests, use a vision-capable `llama-server` model with a matching `--mmproj`.
If you want to load local files, set `--media-path` and keep the path slash-terminated, then send
`input_image` parts with `image_url` values like `file://test.png`.

Remote `http(s)` image URLs also work when the upstream model supports vision.

## Why is this needed?

While `llama-server` is extremely fast, its implementation of the newer `/v1/responses` endpoint is stricter than standard OpenAI. This proxy handles the "surgically required" patches to make agentic workflows seamless without sacrificing the raw performance of `llama.cpp`.

This proxy stays entirely local; it only forwards requests between your client and the `llama-server` endpoint you configure on the same machine.
