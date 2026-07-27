#!/bin/bash
# OpenViking Linux Server Setup
# Run on 192.168.2.200 as kehan user

set -e

echo "=== Step 1: Create ov.conf ==="
mkdir -p ~/.openviking/workspace

cat > ~/.openviking/ov.conf << 'CONFEOF'
{
  "storage": {
    "workspace": "/home/kehan/.openviking/workspace"
  },
  "embedding": {
    "dense": {
      "provider": "local",
      "model": "BAAI/bge-small-zh-v1.5",
      "dimension": 512
    },
    "max_concurrent": 4
  },
  "vlm": {
    "api_base": "https://www.packyapi.com/v1",
    "api_key": "sk-g8WwR2B2erMwoUqN8fRZeuisKApiPTHrGeK9YzGHeDaCp51m",
    "provider": "openai",
    "model": "gpt-4o",
    "max_concurrent": 64
  },
  "server": {
    "host": "0.0.0.0",
    "port": 1933,
    "auth_mode": "api_key",
    "root_api_key": "ov-root-20e1debce52c365f51a7aa4699b676976a584d6c4d5f90da"
  }
}
CONFEOF

echo "ov.conf created"

echo ""
echo "=== Step 2: Install llama-cpp-python (GGUF runtime) ==="
~/miniconda3/envs/ov/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple llama-cpp-python 2>&1 | tail -5

echo ""
echo "=== Step 3: Download embedding model from HF mirror ==="
mkdir -p ~/.openviking/models
# bge-small-zh-v1.5 Q5_K_M GGUF (~50MB, good quality/speed balance)
MODEL_URL="https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q5_k_m.gguf"
MODEL_PATH=~/.openviking/models/bge-small-zh-v1.5.gguf

if [ -f "$MODEL_PATH" ]; then
    echo "Model already downloaded: $MODEL_PATH"
else
    echo "Downloading from $MODEL_URL ..."
    wget -q --show-progress "$MODEL_URL" -O "$MODEL_PATH" || {
        echo "WARNING: hf-mirror download failed."
        echo "Try manually: wget '$MODEL_URL' -O $MODEL_PATH"
    }
fi

echo ""
echo "=== Step 4: Start OpenViking server ==="
echo "Run this command manually (it runs in foreground):"
echo ""
echo "  ~/miniconda3/envs/ov/bin/openviking-server"
echo ""
echo "Then test: curl http://localhost:1933/health"
echo ""
echo "=== Setup complete ==="
