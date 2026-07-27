#!/bin/bash
# Fix OpenViking VLM adapter — update Dashscope API key
# Run on the OpenViking server (192.168.2.200) or from an SSH client

set -e

# Step 1: Find OpenViking config
echo "=== Step 1: Locate OpenViking installation ==="
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qi 'openviking\|ov-'; then
  CONTAINER=$(docker ps --format '{{.Names}}' | grep -i 'openviking\|ov-')
  echo "Found Docker container: $CONTAINER"

  # Update VLM env vars in Docker container
  echo "=== Step 2: Update VLM env vars in container ==="
  docker exec -i "$CONTAINER" bash -c '
    # Check current env
    echo "Current ANTHROPIC_MODEL: ${ANTHROPIC_MODEL:-not set}"

    # The VLM adapter uses litellm — check if dashscope keys are stored in env
    env | grep -i dashscope || echo "No dashscope env vars found"
    env | grep -i qwen || echo "No qwen env vars found"
  '

  # Update container env vars (restart needed)
  echo ""
  echo "=== Update method ==="
  echo "The VLM config is in the Docker container or docker-compose env:"
  echo "  ANTHROPIC_API_KEY=sk-sp-179e335766fb45d293f5efd83535a9b4"
  echo "  ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic"
  echo "  ANTHROPIC_MODEL=qwen3.7-plus"
  echo ""
  echo "Add these to docker-compose.yml environment section, then:"
  echo "  docker compose down && docker compose up -d"

elif systemctl list-units --type=service 2>/dev/null | grep -qi 'openviking\|ov-'; then
  SERVICE=$(systemctl list-units --type=service | grep -i 'openviking\|ov-' | awk '{print $1}')
  echo "Found systemd service: $SERVICE"

  # Find service env file
  ENV_FILE=$(systemctl show "$SERVICE" -p EnvironmentFiles 2>/dev/null | cut -d= -f2-)
  if [ -z "$ENV_FILE" ]; then
    ENV_FILE="/etc/openviking/env.conf"
  fi
  echo "Env file: $ENV_FILE"

  # Update env file
  echo "=== Step 2: Update VLM env vars ==="
  cat > /tmp/ov-vlm.env << 'VLMENV'
# VLM Adapter — Dashscope Anthropic-compatible API
ANTHROPIC_API_KEY=sk-sp-179e335766fb45d293f5efd83535a9b4
ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic
ANTHROPIC_MODEL=qwen3.7-plus
VLMENV
  echo "New VLM env vars written to /tmp/ov-vlm.env"
  echo "Merge with: cat /tmp/ov-vlm.env >> $ENV_FILE"
  echo "Then: sudo systemctl restart $SERVICE"

elif [ -d "/opt/openviking" ]; then
  echo "Found /opt/openviking"
  find /opt/openviking -name ".env*" -o -name "config.*" -o -name "*.env" 2>/dev/null | head -10

elif [ -d "$HOME/openviking" ]; then
  echo "Found ~/openviking"
  find ~/openviking -name ".env*" -o -name "config.*" 2>/dev/null | head -10

else
  echo "=== Searching for OpenViking config files ==="
  find /opt /etc /home/kehan -maxdepth 4 -name "*.env" -o -name ".env*" 2>/dev/null | grep -i 'openviking\|ov-' | head -10
  echo ""
  echo "=== Checking running processes ==="
  ps aux | grep -i 'openviking\|viking' | grep -v grep
fi

echo ""
echo "=== Done ==="
echo ""
echo "New VLM config to apply:"
echo "  ANTHROPIC_API_KEY=sk-sp-179e335766fb45d293f5efd83535a9b4"
echo "  ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic"
echo "  ANTHROPIC_MODEL=qwen3.7-plus"
