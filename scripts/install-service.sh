#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-llama-cpp-agent-proxy}"
TARGET_HOST="${TARGET_HOST:-127.0.0.1}"
TARGET_PORT="${TARGET_PORT:-11435}"
PORT="${PORT:-11437}"
NON_STOP_MODE="${NON_STOP_MODE:-false}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --service-name)
            SERVICE_NAME="$2"
            shift 2
            ;;
        --target-host)
            TARGET_HOST="$2"
            shift 2
            ;;
        --target-port)
            TARGET_PORT="$2"
            shift 2
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --non-stop-mode)
            NON_STOP_MODE="$2"
            shift 2
            ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [--service-name NAME] [--target-host HOST] [--target-port PORT] [--port PORT] [--non-stop-mode MODE]

Installs a user service for the proxy on macOS (LaunchAgent) or Ubuntu/Linux (systemd user service).
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
OS_NAME="$(uname -s)"
SERVICE_UNIT="${SERVICE_NAME}.service"
LABEL="com.github.${SERVICE_NAME}"

if [[ -z "${NODE_BIN}" ]]; then
    echo "node is not installed or not on PATH" >&2
    exit 1
fi

kill_proxy_processes() {
    local pids
    pids="$(ps -eo pid=,command= | awk -v root="${ROOT_DIR}/index.js" '$0 ~ root {print $1}')"

    if [[ -n "${pids}" ]]; then
        for pid in ${pids}; do
            kill "${pid}" 2>/dev/null || true
        done
    fi
}

install_launchd() {
    local plist_dir="${HOME}/Library/LaunchAgents"
    local plist_path="${plist_dir}/${LABEL}.plist"

    mkdir -p "${plist_dir}"

    cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${ROOT_DIR}/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TARGET_HOST</key>
        <string>${TARGET_HOST}</string>
        <key>TARGET_PORT</key>
        <string>${TARGET_PORT}</string>
        <key>PORT</key>
        <string>${PORT}</string>
        <key>NON_STOP_MODE</key>
        <string>${NON_STOP_MODE}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${ROOT_DIR}/proxy.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${ROOT_DIR}/proxy.log</string>
</dict>
    </plist>
EOF

    launchctl bootout "gui/$(id -u)" "${plist_path}" >/dev/null 2>&1 || true
    kill_proxy_processes
    launchctl bootstrap "gui/$(id -u)" "${plist_path}"
    launchctl enable "gui/$(id -u)/${LABEL}"
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"

    echo "Installed LaunchAgent: ${plist_path}"
}

install_systemd_user() {
    local systemd_dir="${HOME}/.config/systemd/user"
    local unit_path="${systemd_dir}/${SERVICE_UNIT}"

    mkdir -p "${systemd_dir}"

    cat > "${unit_path}" <<EOF
[Unit]
Description=llama-cpp-agent-proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
Environment=TARGET_HOST=${TARGET_HOST}
Environment=TARGET_PORT=${TARGET_PORT}
Environment=PORT=${PORT}
Environment=NON_STOP_MODE=${NON_STOP_MODE}
ExecStart=${NODE_BIN} ${ROOT_DIR}/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

    systemctl --user stop "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    kill_proxy_processes
    systemctl --user daemon-reload
    systemctl --user enable "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    systemctl --user start "${SERVICE_UNIT}"
    systemctl --user is-active --quiet "${SERVICE_UNIT}"

    echo "Installed systemd user service: ${unit_path}"
}

case "${OS_NAME}" in
    Darwin)
        install_launchd
        ;;
    Linux)
        install_systemd_user
        ;;
    *)
        echo "Unsupported OS: ${OS_NAME}" >&2
        exit 1
        ;;
esac
