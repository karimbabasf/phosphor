#!/bin/sh
# A stand-in for the hermes launcher on a fresh install: no provider and no model chosen yet.
case "$1" in
  --version) echo "Hermes Agent v0.21.3 (2026.9.14)" ;;
  config) [ "$2 $3" = "get model" ] && printf 'default: \nprovider: \n' ;;
  *) echo "fake-hermes: unexpected $*" >&2; exit 2 ;;
esac
