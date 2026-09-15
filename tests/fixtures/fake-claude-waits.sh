#!/bin/sh
# A stand-in for the claude binary that starts and then waits, saying nothing.
#
# tests/unit/driver-reason.test.ts stops it on purpose to check that a stop the person asked for
# reaches the window as the state word alone, with no reason attached.
sleep 30
