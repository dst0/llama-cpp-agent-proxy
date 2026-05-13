#!/usr/bin/env bash
# Run two proxy instances: one with NON_STOP_MODE=true, one with NON_STOP_MODE=false
# Each instance listens on a different port so agents can use different URLs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Kill any existing proxy instances
pkill -f 'node index.js' 2>/dev/null || true
sleep 1

# Start NON_STOP_MODE=true proxy on port 11441
NON_STOP_MODE=true PORT=11441 node index.js &
echo "Started NON_STOP_MODE=true proxy on port 11441"

# Start NON_STOP_MODE=false proxy on port 11440
NON_STOP_MODE=false PORT=11440 node index.js &
echo "Started NON_STOP_MODE=false proxy on port 11440"

echo "Both proxies are running."
echo "  Non-stop mode (FINISHED rejected): http://localhost:11441/v1"
echo "  Stop mode (FINISHED accepted):      http://localhost:11440/v1"
