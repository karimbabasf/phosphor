#!/bin/sh
# A stand-in for the codex binary with no login: `codex login status` prints "Not logged in" and exits 1.
case "$1" in
  --version) echo "codex-cli 0.154.0" ;;
  login) [ "$2" = "status" ] && { echo "Not logged in"; exit 1; } ;;
  *) echo "fake-codex: unexpected $*" >&2; exit 2 ;;
esac
