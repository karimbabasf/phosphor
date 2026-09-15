#!/bin/sh
# A stand-in for the claude binary that leaves at once with a non-zero code.
#
# tests/unit/driver-reason.test.ts drives the real src/driver.ts over it to check that a child
# dying on its own reaches the window as one plain sentence with a reason, not as a bare code.
exit 3
