#!/usr/bin/env bash
set -euo pipefail
cd /home/dst/dev/llama-cpp-agent-proxy
git add -A
git status
git diff --stat HEAD
git commit -m "Add two-proxy setup: install-two-services.sh, uninstall-two-services.sh, run-two-proxies.sh, NON_STOP_MODE support in install-service.sh, README docs"
git push origin main
