#!/usr/bin/env bash
# Install two specialized llama-server services:
# 1. llama-server-main (GPU, Port 11435)
# 2. llama-server-micro (CPU/AVX2, Port 11438)

set -euo pipefail

# Ensure we have root privileges for systemd and /etc/llama
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (sudo)" >&2
   exit 1
fi

mkdir -p /etc/llama

# 1. Main Model (GPU)
echo "Setting up llama-server-main (GPU)..."
cat > /etc/llama/llama-server-main.env <<EOF
MODEL=/home/dst/models/unsloth/Qwen3.6-27B-Q3KM/Qwen3.6-27B-Q3_K_M.gguf
ALIAS=qwen36-27b-q3km
HOST=0.0.0.0
PORT=11435
THREADS=6
THREADS_BATCH=6
CTX_SIZE=65536
PARALLEL=1
FLASH_ATTN=on
CACHE_TYPE_K=q8_0
CACHE_TYPE_V=q8_0
SLOT_SAVE_PATH=/opt/llama/slots
BATCH_SIZE=256
UBATCH_SIZE=256
N_PREDICT=-1
EOF

cat > /etc/systemd/system/llama-server-main.service <<EOF
[Unit]
Description=llama.cpp Main Model (GPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=llama
Group=llama
EnvironmentFile=/etc/llama/llama-server-main.env
WorkingDirectory=/opt/llama
ExecStart=/opt/llama/bin/llama-server \\
  -m \${MODEL} \\
  --host \${HOST} \\
  --port \${PORT} \\
  --threads \${THREADS} \\
  --threads-batch \${THREADS_BATCH} \\
  -c \${CTX_SIZE} \\
  --parallel \${PARALLEL} \\
  --flash-attn \${FLASH_ATTN} \\
  -ctk \${CACHE_TYPE_K} \\
  -ctv \${CACHE_TYPE_V} \\
  --slot-save-path \${SLOT_SAVE_PATH} \\
  --alias \${ALIAS} \\
  --metrics \\
  --split-mode none \\
  --main-gpu 0 \\
  --batch-size \${BATCH_SIZE} \\
  --ubatch-size \${UBATCH_SIZE} \\
  --kv-unified --context-shift --n-gpu-layers 999 \\
  -n \${N_PREDICT} --temp 0.2

Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
StandardOutput=append:/opt/llama/logs/main-stdout.log
StandardError=append:/opt/llama/logs/main-stderr.log

[Install]
WantedBy=multi-user.target
EOF

# 2. Micro Model (LM Studio)
echo "Setting up lms-micro (LM Studio)..."
# Create a small script to start lms and load the model
cat > /opt/llama/bin/start-lms-micro.sh <<EOF
#!/usr/bin/env bash
/home/dst/.lmstudio/bin/lms runtime select llama.cpp-linux-x86_64-avx2@2.13.0
/home/dst/.lmstudio/bin/lms server stop || true
/home/dst/.lmstudio/bin/lms server start --port 1234 --bind 0.0.0.0
sleep 2
/home/dst/.lmstudio/bin/lms load qwen2.5-0.5b --gpu off --context-length 32768 --yes
# Keep script alive for systemd
while true; do sleep 60; done
EOF
chmod +x /opt/llama/bin/start-lms-micro.sh

cat > /etc/systemd/system/lms-micro.service <<EOF
[Unit]
Description=LM Studio Micro Model (CPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dst
Group=dst
WorkingDirectory=/home/dst
ExecStart=/opt/llama/bin/start-lms-micro.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable llama-server-main lms-micro
systemctl restart llama-server-main lms-micro

echo "Services installed and started."
echo "Main (GPU) on port 11435 (llama-server-main)"
echo "Micro (CPU) on port 1234 (lms-micro)"
