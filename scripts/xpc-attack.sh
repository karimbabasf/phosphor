#!/bin/sh
# Plays the 2026-09-14 pen test's local process against a built bundle: can anything but the
# Phosphor shell get the Secure Enclave helper to answer?
#
#   sh scripts/xpc-attack.sh [path/to/Phosphor.app]
#
# Every request is {"op":"probe"}: it reads no key and raises no dialog, and an answer to it is
# exactly as much proof of reach as an answer to an unwrap. Nothing here reads ~/.phosphor.
#
#   1. The old door: Contents/MacOS/se-helper must be gone, and running the service's binary by
#      hand must answer nothing (xpc_main refuses a process launchd did not start).
#   2. A plain process asking for the service by name, and a process that lives inside a copy of
#      the real bundle beside the shell but is not the shell (signed the way the bundled node
#      runtime is). Both must be refused.
#   3. A foreign app: its own bundle, identifier com.example.foreign, a byte-identical copy of
#      the signed service inside. The service must refuse it.
#   4. The ad-hoc limit: the same foreign app under the identifier com.karimbabasf.phosphor. An
#      ad-hoc requirement can only name an identifier, so this one gets an answer; the script
#      says so rather than hide it. Under Developer ID the requirement also pins Apple's anchor
#      and the Team ID, which this bundle cannot carry.
#   5. The shell itself: `phosphor-desktop --enclave-probe` must get an answer, through the same
#      Rust and C path the relay uses.
set -eu
cd "$(dirname "$0")/.."
app="${1:-src-tauri/target/release/bundle/macos/Phosphor.app}"
service_name="com.karimbabasf.phosphor.vault"
service="$app/Contents/XPCServices/$service_name.xpc"
test -d "$service" || { echo "no service at $service; build the app first" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0
say() { printf '%s\n' "$*"; }

say "1. the old door"
if [ -e "$app/Contents/MacOS/se-helper" ]; then
  say "   FAIL  Contents/MacOS/se-helper still ships"; failed=1
else
  say "   ok    Contents/MacOS/se-helper is not in the bundle"
fi
out="$(printf '{"op":"probe"}\n' | "$service/Contents/MacOS/se-helper" 2>/dev/null || true)"
if [ -n "$out" ]; then
  say "   FAIL  running the service binary by hand answered: $out"; failed=1
else
  say "   ok    running the service binary by hand answers nothing"
fi

# A host app built around a copy of the shipped service, calling it through the shell's own
# bridge so the client side is identical to the shell's.
cat > "$work/host.c" <<'EOF'
#include <stdio.h>
#include <stdlib.h>
char *phosphor_xpc_call(const char *service, const char *request, double timeout_secs, const char **error);
int main(void) {
    const char *error = NULL;
    char *answer = phosphor_xpc_call("com.karimbabasf.phosphor.vault", "{\"op\":\"probe\"}", 10, &error);
    if (answer) { printf("ANSWERED %s\n", answer); free(answer); return 0; }
    printf("REFUSED %s\n", error);
    return 1;
}
EOF
clang -fblocks -O2 -o "$work/host" "$work/host.c" src-tauri/src/xpc_bridge.c -framework Security -framework CoreFoundation

host_app() { # identifier -> path of a signed host bundle
  dir="$work/$1.app"
  mkdir -p "$dir/Contents/MacOS" "$dir/Contents/XPCServices"
  cp "$work/host" "$dir/Contents/MacOS/host"
  cp -R "$service" "$dir/Contents/XPCServices/"
  cat > "$dir/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$1</string>
<key>CFBundleExecutable</key><string>host</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
  codesign -s - -f --options runtime "$dir" >/dev/null 2>&1
  printf '%s' "$dir"
}

say "2. a plain process, and a stranger inside the real bundle"
out="$("$work/host" || true)"
case "$out" in
  REFUSED*) say "   ok    plain process: $out" ;;
  *) say "   FAIL  plain process: $out"; failed=1 ;;
esac
cp -R "$app" "$work/Inside.app"
cp "$work/host" "$work/Inside.app/Contents/MacOS/intruder"
codesign -s - -f --options runtime -i "$(codesign -dv "$app/Contents/MacOS/node" 2>&1 | sed -n 's/^Identifier=//p')" \
  "$work/Inside.app/Contents/MacOS/intruder" >/dev/null 2>&1
out="$("$work/Inside.app/Contents/MacOS/intruder" || true)"
case "$out" in
  REFUSED*) say "   ok    inside the bundle, signed as the node runtime: $out" ;;
  *) say "   FAIL  inside the bundle: $out"; failed=1 ;;
esac

say "3. a foreign app hosting a copy of the service"
foreign="$(host_app com.example.foreign)"
cmp -s "$foreign/Contents/XPCServices/$service_name.xpc/Contents/MacOS/se-helper" "$service/Contents/MacOS/se-helper" \
  && say "   ok    its service is byte-identical to the shipped one"
out="$("$foreign/Contents/MacOS/host" || true)"
case "$out" in
  REFUSED*) say "   ok    $out" ;;
  *) say "   FAIL  $out"; failed=1 ;;
esac

say "4. the same foreign app claiming com.karimbabasf.phosphor (ad-hoc limit)"
impostor="$(host_app com.karimbabasf.phosphor)"
out="$("$impostor/Contents/MacOS/host" || true)"
case "$out" in
  ANSWERED*) say "   known $out   <- an ad-hoc signature can only pin the identifier; Developer ID closes this" ;;
  *) say "   ok    $out" ;;
esac

say "5. the shell itself"
out="$("$app/Contents/MacOS/phosphor-desktop" --enclave-probe)"
case "$out" in
  *'"ok":true'*) say "   ok    $out" ;;
  *) say "   FAIL  $out"; failed=1 ;;
esac

exit "$failed"
