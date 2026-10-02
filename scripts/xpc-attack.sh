#!/bin/sh
# Plays the 2026-09-14 pen test's local process against a built bundle: can anything but the
# Phosphor shell get the Secure Enclave helper to answer?
#
#   sh scripts/xpc-attack.sh [path/to/Phosphor.app]
#
# Every request is {"op":"probe"}: it reads no key and raises no dialog, and an answer to it is
# exactly as much proof of reach as an answer to an unwrap. Nothing here reads ~/.phosphor.
#
# Nothing here changes the bundle it is given or runs code from a changed copy of it. macOS checks
# a notarized bundle's seal when code inside it first runs, and a broken seal is a "damaged" alert
# that waits for a person. So every stranger lives in a bundle built here from scratch, ad-hoc
# signed, beside a byte-identical copy of the shipped service, and is started by exec, never
# through LaunchServices. Each caller runs under a 20 second limit, so nothing on screen can hold
# the probe. A refusal names who refused: the service (it ran and dropped the caller), launchd (no
# service started for that caller), or macOS (it killed the caller first, and codesign rejects
# the caller's code; a kill with valid code is no verdict).
#
#   1. The old door: Contents/MacOS/se-helper must be gone, and running the service's binary by
#      hand must answer nothing (xpc_main refuses a process launchd did not start).
#   2. A plain process asking for the service by name, and a stranger beside the shell: a second
#      program in a bundle that carries Phosphor's identifier, signed the way the bundled node
#      runtime is. Both must be refused. The shipped runtime itself (same bundle, and under
#      Developer ID the same team) is checked against the requirement the service sets: it must
#      fail it, and the shell must pass it.
#   3. A foreign app: its own bundle, identifier com.example.foreign, a byte-identical copy of
#      the signed service inside. The service must refuse it.
#   4. The same foreign app under the identifier com.karimbabasf.phosphor. Under Developer ID the
#      requirement also pins Apple's anchor and the Team ID, which this bundle cannot carry, so it
#      must be refused. An ad-hoc requirement can only name an identifier, so on an ad-hoc build
#      it gets an answer; the script says so ("known") rather than hide it.
#   5. The shell itself: `phosphor-desktop --enclave-probe` must get an answer, through the same
#      Rust and C path the relay uses.
set -eu
cd "$(dirname "$0")/.."
app="${1:-src-tauri/target/release/bundle/macos/Phosphor.app}"
service_name="com.karimbabasf.phosphor.vault"
host_id="com.karimbabasf.phosphor"
service="$app/Contents/XPCServices/$service_name.xpc"
test -d "$service" || { echo "no service at $service; build the app first" >&2; exit 2; }
work="$(mktemp -d)"
trap 'pkill -9 -f "$work/" 2>/dev/null || true; rm -rf "$work"' EXIT
failed=0
say() { printf '%s\n' "$*"; }
printf '{"op":"probe"}\n' > "$work/probe.json"

# The Team ID the service is signed with, empty on an ad-hoc build. It decides attacker 4's verdict
# and the requirement in step 2, which is the one src-tauri/se-helper/main.swift peerRequirement()
# builds for it.
team="$(codesign -dv "$service" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[ "$team" = "not set" ] && team=""
if [ -n "$team" ]; then
  say "the service is signed by team $team (Developer ID)"
  requirement="anchor apple generic and identifier \"$host_id\" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"$team\""
else
  say "the service is signed ad-hoc"
  requirement="identifier \"$host_id\""
fi

# Runs "$@" by exec, stdin the probe request, output in $work/out, for at most 20 seconds. Sets
# `ran` to how it ended: its exit status, "late" (still running at the limit, then killed), or
# "macos: <why>" when macOS killed it for its code signature. Its stderr is closed so the shell's
# own notice of a caller dying on a signal stays out of the report.
limited() {
  "$@" < "$work/probe.json" > "$work/out" &
  pid=$!
  n=0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.2; n=$((n + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    # Not waited for: a caller held by a dialog may not die until someone answers it.
    kill -9 "$pid" 2>/dev/null || true
    disown "$pid" 2>/dev/null || true
    ran=late
    return 0
  fi
  ran=0
  wait "$pid" || ran=$?
  # macOS kills code it will not run with SIGKILL. That counts as its refusal only when its own
  # check agrees: strict codesign verification fails on the program, or on the bundle it sits in.
  if [ "$ran" = 137 ]; then
    code="$1"
    case "$1" in *.app/Contents/*) code="${1%%.app/Contents/*}.app" ;; esac
    if [ -e "$code" ] && ! why="$(codesign --verify --deep --strict "$code" 2>&1)"; then
      why="$(printf '%s\n' "$why" | head -n 1)"
      ran="macos: ${why##*: } (codesign --verify)"
    fi
  fi
  return 0
} 2>/dev/null

# A caller's own line, or what stopped it from printing one.
said() {
  case "$ran" in
    0 | 1) cat "$work/out" ;;
    late) say "NO VERDICT: still running after 20 s, so it was killed (a system dialog may be up)" ;;
    macos:*) say "REFUSED by macOS before it reached the service: ${ran#macos: }" ;;
    *) say "NO VERDICT: exit $ran and no line" ;;
  esac
}

say "1. the old door"
if [ -e "$app/Contents/MacOS/se-helper" ]; then
  say "   FAIL  Contents/MacOS/se-helper still ships"; failed=1
else
  say "   ok    Contents/MacOS/se-helper is not in the bundle"
fi
limited "$service/Contents/MacOS/se-helper"
if [ "$ran" = late ]; then
  say "   FAIL  running the service binary by hand: $(said)"; failed=1
elif [ -s "$work/out" ]; then
  say "   FAIL  running the service binary by hand answered: $(cat "$work/out")"; failed=1
else
  say "   ok    running the service binary by hand answers nothing"
fi

# A host built around the shell's own bridge, so the client side is identical to the shell's. When
# it is refused it says whether the service it asked for ran: a service runs from its caller's
# bundle until that caller exits, so the host looks before it does.
cat > "$work/host.c" <<'EOF'
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
char *phosphor_xpc_call(const char *service, const char *request, double timeout_secs, const char **error);
static pid_t own_service(void) {
    char exe[PATH_MAX], real[PATH_MAX], prefix[PATH_MAX], other[PROC_PIDPATHINFO_MAXSIZE];
    uint32_t size = sizeof exe;
    if (_NSGetExecutablePath(exe, &size) != 0 || !realpath(exe, real)) return 0;
    char *at = strstr(real, ".app/Contents/MacOS/");
    if (!at) return 0;
    snprintf(prefix, sizeof prefix, "%.*s.app/Contents/XPCServices/", (int)(at - real), real);
    static pid_t pids[16384];
    int n = proc_listallpids(pids, (int)sizeof pids);
    for (int i = 0; i < n; i++)
        if (pids[i] > 0 && proc_pidpath(pids[i], other, sizeof other) > 0 && strncmp(other, prefix, strlen(prefix)) == 0) return pids[i];
    return 0;
}
int main(void) {
    const char *error = NULL;
    char *answer = phosphor_xpc_call("com.karimbabasf.phosphor.vault", "{\"op\":\"probe\"}", 10, &error);
    if (answer) { printf("ANSWERED %s\n", answer); free(answer); return 0; }
    pid_t service = own_service();
    if (service) printf("REFUSED %s by the service: it ran (pid %d) and dropped this caller\n", error, service);
    else printf("REFUSED %s: no service started for this caller\n", error);
    return 1;
}
EOF
clang -fblocks -O2 -o "$work/host" "$work/host.c" src-tauri/src/xpc_bridge.c src-tauri/src/codesign.c -framework Security -framework CoreFoundation

host_app() { # bundle identifier, [identifier of a second program beside the host] -> bundle path
  dir="$work/$1${2:+-beside-$2}.app"
  mkdir -p "$dir/Contents/MacOS" "$dir/Contents/XPCServices"
  cp "$work/host" "$dir/Contents/MacOS/host"
  cp -RX "$service" "$dir/Contents/XPCServices/"
  cat > "$dir/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$1</string>
<key>CFBundleExecutable</key><string>host</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
  if [ -n "${2:-}" ]; then
    cp "$work/host" "$dir/Contents/MacOS/intruder"
    codesign -s - -f --options runtime -i "$2" "$dir/Contents/MacOS/intruder" >/dev/null 2>&1
  fi
  codesign -s - -f --options runtime "$dir" >/dev/null 2>&1
  printf '%s' "$dir"
}

say "2. a plain process, and a stranger beside the shell"
limited "$work/host"
out="$(said)"
case "$out" in
  REFUSED*) say "   ok    plain process: $out" ;;
  *) say "   FAIL  plain process: $out"; failed=1 ;;
esac
runtime_id="$(codesign -dv "$app/Contents/MacOS/node" 2>&1 | sed -n 's/^Identifier=//p')"
inside="$(host_app "$host_id" "$runtime_id")"
limited "$inside/Contents/MacOS/intruder"
out="$(said)"
case "$out" in
  REFUSED*) say "   ok    in a bundle named $host_id, signed as the runtime ($runtime_id): $out" ;;
  *) say "   FAIL  in a bundle named $host_id, signed as the runtime ($runtime_id): $out"; failed=1 ;;
esac
# codesign exits 3 when valid code does not satisfy the requirement, and 0 when it does.
node_req=0
codesign --verify --test-requirement="=$requirement" "$app/Contents/MacOS/node" >/dev/null 2>&1 || node_req=$?
shell_req=0
codesign --verify --test-requirement="=$requirement" "$app" >/dev/null 2>&1 || shell_req=$?
if [ "$node_req" = 3 ]; then
  say "   ok    the shipped runtime ($runtime_id${team:+, team $team}) fails the service's requirement: codesign exit 3"
else
  say "   FAIL  the shipped runtime against the service's requirement: codesign exit $node_req, wanted 3"; failed=1
fi
if [ "$shell_req" = 0 ]; then
  say "   ok    and the shell passes it: codesign exit 0"
else
  say "   FAIL  the shell against the service's requirement: codesign exit $shell_req, wanted 0"; failed=1
fi

say "3. a foreign app hosting a copy of the service"
foreign="$(host_app com.example.foreign)"
cmp -s "$foreign/Contents/XPCServices/$service_name.xpc/Contents/MacOS/se-helper" "$service/Contents/MacOS/se-helper" \
  && say "   ok    its service is byte-identical to the shipped one"
limited "$foreign/Contents/MacOS/host"
out="$(said)"
case "$out" in
  REFUSED*) say "   ok    $out" ;;
  *) say "   FAIL  $out"; failed=1 ;;
esac

say "4. the same foreign app claiming $host_id"
impostor="$(host_app "$host_id")"
limited "$impostor/Contents/MacOS/host"
out="$(said)"
case "$out" in
  REFUSED*) say "   ok    $out" ;;
  ANSWERED*)
    if [ -n "$team" ]; then
      say "   FAIL  $out   <- a Developer ID service answered an ad-hoc caller"; failed=1
    else
      say "   known $out   <- an ad-hoc signature can only pin the identifier; Developer ID closes this"
    fi ;;
  *) say "   FAIL  $out"; failed=1 ;;
esac

say "5. the shell itself"
limited "$app/Contents/MacOS/phosphor-desktop" --enclave-probe
out="$(said)"
case "$out" in
  *'"ok":true'*) say "   ok    $out" ;;
  *) say "   FAIL  $out"; failed=1 ;;
esac

exit "$failed"
