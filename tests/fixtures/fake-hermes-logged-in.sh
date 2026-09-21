#!/bin/sh
# A stand-in for the hermes launcher with a provider and a default model set, the way
# `hermes config get model` prints them on Hermes Agent 0.21.3.
case "$1" in
  --version) echo "Hermes Agent v0.21.3 (2026.9.14)" ;;
  config) [ "$2 $3" = "get model" ] && printf 'default: z-ai/glm-5.3\nprovider: openrouter\nbase_url: https://openrouter.ai/api/v1\n' ;;
  *) echo "fake-hermes: unexpected $*" >&2; exit 2 ;;
esac
