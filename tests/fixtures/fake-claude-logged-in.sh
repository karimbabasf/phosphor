#!/bin/sh
# A stand-in for the claude binary on a Mac where Claude Code is installed and signed in.
#
# tests/unit/agents-catalog.test.ts points the catalog's check at it: `--version` answers the way
# 2.1.278 does and `auth status` prints the JSON that release prints for a stored login. Nothing
# else is answered, so a probe this file does not expect fails loudly.
case "$1" in
  --version) echo "2.1.278 (Claude Code)" ;;
  auth) [ "$2" = "status" ] && printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' ;;
  *) echo "fake-claude: unexpected $*" >&2; exit 2 ;;
esac
