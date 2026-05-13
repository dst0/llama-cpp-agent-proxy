#!/usr/bin/env bash
# Install two proxy services: one with NON_STOP_MODE=true, one with NON_STOP_MODE=false
# Each service listens on a different port so agents can use different URLs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Kill any existing proxy instances
pkill -f 'node index.js' 2>/dev/null || true
sleep 1

# Install NON_STOP_MODE=false proxy on port 11440
echo "Installing NON_STOP_MODE=false proxy on port 11440..."
bash "$SCRIPT_DIR/install-service.sh" --port 11440 --service-name llama-cpp-agent-proxy-stop

# Install NON_STOP_MODE=true proxy on port 11441
echo "Installing NON_STOP_MODE=true proxy on port 11441..."
NON_STOP_MODE=true bash "$SCRIPT_DIR/install-service.sh" --port 11441 --service-name llama-cpp-agent-proxy-nonstop

echo ""
echo "Both services are installed and running."
echo "  Non-stop mode (FINISHED rejected): http://localhost:11441/v1"
echo "  Stop mode (FINISHED accepted):      http://localhost:11440/v1"
