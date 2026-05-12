#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-llama-cpp-agent-proxy}"
LABEL="com.github.${SERVICE_NAME}"
SERVICE_UNIT="${SERVICE_NAME}.service"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --service-name)
            SERVICE_NAME="$2"
            LABEL="com.github.${SERVICE_NAME}"
            SERVICE_UNIT="${SERVICE_NAME}.service"
            shift 2
            ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [--service-name NAME]

Removes the proxy user service on macOS (LaunchAgent) or Ubuntu/Linux (systemd user service).
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

OS_NAME="$(uname -s)"

uninstall_launchd() {
    local plist_path="${HOME}/Library/LaunchAgents/${LABEL}.plist"

    launchctl bootout "gui/$(id -u)" "${plist_path}" >/dev/null 2>&1 || true
    rm -f "${plist_path}"

    echo "Removed LaunchAgent: ${plist_path}"
}

kill_proxy_processes() {
    local pids
    pids="$(ps -eo pid=,command= | awk -v root="${ROOT_DIR}/index.js" '$0 ~ root {print $1}')"

    if [[ -n "${pids}" ]]; then
        for pid in ${pids}; do
            kill "${pid}" 2>/dev/null || true
        done
    fi
}

uninstall_systemd_user() {
    local unit_path="${HOME}/.config/systemd/user/${SERVICE_UNIT}"

    systemctl --user disable --now "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    rm -f "${unit_path}"
    systemctl --user daemon-reload
    systemctl --user reset-failed "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    kill_proxy_processes

    echo "Removed systemd user service: ${unit_path}"
}

case "${OS_NAME}" in
    Darwin)
        uninstall_launchd
        ;;
    Linux)
        uninstall_systemd_user
        ;;
    *)
        echo "Unsupported OS: ${OS_NAME}" >&2
        exit 1
        ;;
esac
