#!/usr/bin/env bash
# Install two proxy services: one with NON_STOP_MODE=true, one with NON_STOP_MODE=false
# Each service listens on a different port so agents can use different URLs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Kill any existing proxy instances
pkill -f 'node index.js' 2>/dev/null || true
sleep 1

# Install NON_STOP_MODE=false proxy on port 11450 (with monitoring)
echo "Installing NON_STOP_MODE=false proxy on port 11450..."
bash "$SCRIPT_DIR/install-service.sh" --port 11450 --service-name llama-cpp-agent-proxy-stop --monitor-enabled true --backend-ports "11435,1234" --backend-services "llama-server-main,lms-micro"

# Install NON_STOP_MODE=true proxy on port 11451 (without monitoring)
echo "Installing NON_STOP_MODE=true proxy on port 11451..."
NON_STOP_MODE=true bash "$SCRIPT_DIR/install-service.sh" --port 11451 --service-name llama-cpp-agent-proxy-nonstop --monitor-enabled false --backend-ports "11435,1234" --backend-services "llama-server-main,lms-micro"

echo ""
echo "Both services are installed and running."
echo "  Non-stop mode (FINISHED rejected): http://localhost:11451/v1"
echo "  Stop mode (FINISHED accepted):      http://localhost:11450/v1"
