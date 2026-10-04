#!/bin/sh
# Builds the Secure Enclave helper twice from src-tauri/se-helper: main.swift, and the chip key's
# ops with the grammar and token table they sign by (ChipOps.swift, IntentGrammar.swift,
# TokenTable.swift), which PHOSPHOR_CHIP compiles in. Called by scripts/bundle-payload.ts and by
# `npm run se:build`. Needs only the Xcode command line tools.
#
#   src-tauri/binaries/xpc/com.karimbabasf.phosphor.vault.xpc
#       The XPC service the app ships, copied into Contents/XPCServices by tauri.conf.json's
#       bundle.macOS.files. It answers only over XPC, and only to a peer that passes its code
#       signing requirement. Signed here, because Tauri signs neither custom files nor nested
#       bundles and the app's own signature needs its nested code signed first.
#
#   src-tauri/binaries/se-helper-dev-<rust triple>
#       The development build, compiled with PHOSPHOR_STDIO: one JSON line on stdin, one out.
#       `tauri dev` runs the shell outside a bundle, where no XPC service can be looked up, so a
#       debug shell spawns this instead (enclave.rs). The self-test scripts use it too. It is
#       never in a bundle: the stdin door is exactly what the XPC service exists to close.
#
# The signing identity is APPLE_SIGNING_IDENTITY when set (the release runner imports the
# certificate before this runs), otherwise ad-hoc, matching tauri.conf.json.
set -eu
cd "$(dirname "$0")/.."
arch="$(uname -m)"
case "$arch" in
  arm64) triple="aarch64-apple-darwin" ;;
  x86_64) triple="x86_64-apple-darwin" ;;
  *) echo "unsupported arch $arch" >&2; exit 1 ;;
esac
identity="${APPLE_SIGNING_IDENTITY:--}"
src="src-tauri/se-helper"
mkdir -p src-tauri/binaries
# Both builds are for the oldest macOS the app supports, not for the Mac that builds them, which is
# swiftc's default: built that way on the release runner, 0.10.13 shipped a service that asked for
# macOS 15.0 inside an app that says 13.5. scripts/release-check.ts holds every binary to it.
minimum="$(plutil -extract bundle.macOS.minimumSystemVersion raw -o - src-tauri/tauri.conf.json)"
target="$arch-apple-macos$minimum"

# The embedded Info.plist is what the Touch ID dialog reads the app name from: without it the
# system would title the dialog "se-helper", which is what malware would look like.
dev="src-tauri/binaries/se-helper-dev-$triple"
# Gone first, so a build that fails cannot leave the last one behind to pass the test below.
rm -f "$dev"
swiftc -O -D PHOSPHOR_STDIO -D PHOSPHOR_CHIP -target "$target" -module-name se_helper -o "$dev" "$src/main.swift" "$src/ChipOps.swift" \
  "$src/IntentGrammar.swift" "$src/TokenTable.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$src/Info.plist" 2>&1 | grep -v "warning" || true
test -x "$dev"
codesign -s - -f --options runtime "$dev" >/dev/null 2>&1

service="src-tauri/binaries/xpc/com.karimbabasf.phosphor.vault.xpc"
rm -rf "$service"
mkdir -p "$service/Contents/MacOS"
cp "$src/XPCService-Info.plist" "$service/Contents/Info.plist"
swiftc -O -D PHOSPHOR_CHIP -target "$target" -module-name se_helper -o "$service/Contents/MacOS/se-helper" "$src/main.swift" "$src/ChipOps.swift" \
  "$src/IntentGrammar.swift" "$src/TokenTable.swift" 2>&1 | grep -v "warning" || true
test -x "$service/Contents/MacOS/se-helper"
# Hardened runtime and no entitlements: the service needs no JIT and no exception of any kind.
# A timestamp only for a real identity; ad-hoc has no authority to timestamp against.
if [ "$identity" = "-" ]; then
  codesign -s - -f --options runtime "$service" >/dev/null 2>&1
else
  codesign -s "$identity" -f --options runtime --timestamp "$service" >/dev/null
fi
codesign --verify --strict "$service"
echo "$service"
echo "$dev"
