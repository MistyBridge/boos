#!/bin/bash
# Start OpenViking with bot mode + Anthropic API

export ANTHROPIC_BASE_URL="https://www.packyapi.com"
export ANTHROPIC_AUTH_TOKEN="sk-g8WwR2B2erMwoUqN8fRZeuisKApiPTHrGeK9YzGHeDaCp51m"
export ANTHROPIC_MODEL="deepseek-pro"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-pro"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-pro"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-pro"

/home/kehan/miniconda3/envs/ov/bin/openviking-server --with-bot
