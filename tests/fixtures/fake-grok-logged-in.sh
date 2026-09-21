#!/bin/sh
# A stand-in for the grok binary (Grok Build 1.0.34). grok has no offline login command, so the
# catalog reads whether <GROK_HOME>/auth.json exists; the test writes one beside this script's
# run. `--version` is the one call this file answers.
case "$1" in
  --version) echo "grok 1.0.34 (3736acbc8658) [stable]" ;;
  *) echo "fake-grok: unexpected $*" >&2; exit 2 ;;
esac
