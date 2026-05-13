#!/usr/bin/env bash
# Uninstall both proxy services

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Kill any existing proxy instances
pkill -f 'node index.js' 2>/dev/null || true
sleep 1

# Uninstall both services
echo "Uninstalling NON_STOP_MODE=false proxy..."
bash "$SCRIPT_DIR/uninstall-service.sh" --service-name llama-cpp-agent-proxy-stop

echo "Uninstalling NON_STOP_MODE=true proxy..."
bash "$SCRIPT_DIR/uninstall-service.sh" --service-name llama-cpp-agent-proxy-nonstop

echo ""
echo "Both services are uninstalled."
