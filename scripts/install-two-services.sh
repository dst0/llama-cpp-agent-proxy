#!/usr/bin/env bash
# Install a single merged proxy service that manages both ports (Standard and Non-Stop)
# Provides a unified status SSE and serialized backend queuing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Kill any existing proxy instances
pkill -f 'node index.js' 2>/dev/null || true
systemctl --user stop llama-cpp-agent-proxy-stop.service llama-cpp-agent-proxy-nonstop.service 2>/dev/null || true
systemctl --user disable llama-cpp-agent-proxy-stop.service llama-cpp-agent-proxy-nonstop.service 2>/dev/null || true
sleep 1

echo "Installing merged two-port proxy service..."
# Use PORTS and NON_STOP_PORTS for the new unified process
export PORTS="11450,11451"
export NON_STOP_PORTS="11451"

bash "$SCRIPT_DIR/install-service.sh" \
    --service-name llama-cpp-agent-proxy \
    --port "$PORTS" \
    --monitor-enabled true \
    --backend-ports "11435,1234" \
    --backend-services "llama-server-main,lms-micro"

echo ""
echo "Unified proxy service installed and running on both ports."
echo "  Standard mode (Port 11450): http://localhost:11450/v1"
echo "  Non-stop mode (Port 11451): http://localhost:11451/v1"
echo "  Unified Status SSE:         http://localhost:11450/v1/status/events"
