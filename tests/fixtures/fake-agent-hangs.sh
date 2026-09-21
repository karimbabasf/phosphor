#!/bin/sh
# A stand-in for any agent binary that never answers. The catalog's check has to give up on it
# inside the picker's three seconds and still name a state, rather than wait on it.
sleep 30
