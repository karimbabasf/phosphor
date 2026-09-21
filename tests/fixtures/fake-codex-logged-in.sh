#!/bin/sh
# A stand-in for the codex binary with a login stored: `codex login status` exits 0 (codex-cli 0.154.0).
case "$1" in
  --version) echo "codex-cli 0.154.0" ;;
  login) [ "$2" = "status" ] && echo "Logged in using ChatGPT" ;;
  *) echo "fake-codex: unexpected $*" >&2; exit 2 ;;
esac
