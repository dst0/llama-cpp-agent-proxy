#!/usr/bin/env bash
# Uninstall the specialized llama-server/lms services

set -euo pipefail

# Ensure we have root privileges for systemd
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (sudo)" >&2
   exit 1
fi

echo "Stopping and disabling llama-server-main..."
systemctl stop llama-server-main || true
systemctl disable llama-server-main || true
rm -f /etc/systemd/system/llama-server-main.service

echo "Stopping and disabling lms-micro..."
systemctl stop lms-micro || true
systemctl disable lms-micro || true
rm -f /etc/systemd/system/lms-micro.service

systemctl daemon-reload

echo "Services uninstalled."
