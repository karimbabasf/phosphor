#!/bin/sh
# A stand-in for an agent binary that stops to ask a question before it answers, the way Hermes's
# first-run wizard does. With its stdin closed the read returns at once and the answer follows;
# with an open pipe it would sit there until the probe's cap killed it.
read -r answer
case "$1" in
  --version) echo "asks 1.0" ;;
  login) [ "$2" = "status" ] && echo "Logged in" ;;
  *) echo "fake-asks: unexpected $*" >&2; exit 2 ;;
esac
