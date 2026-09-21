#!/bin/sh
# A stand-in for the claude binary on a Mac where Claude Code is installed and nobody has signed in.
case "$1" in
  --version) echo "2.1.278 (Claude Code)" ;;
  auth) [ "$2" = "status" ] && printf '%s\n' '{"loggedIn":false}' ;;
  *) echo "fake-claude: unexpected $*" >&2; exit 2 ;;
esac
