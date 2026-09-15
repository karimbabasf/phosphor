#!/bin/sh
# Builds the Secure Enclave sidecar for the current architecture and drops it where Tauri's
# externalBin expects it: src-tauri/binaries/se-helper-<rust triple>. Called by
# scripts/bundle-payload.ts and by `npm run se:build`. Needs only the Xcode command line tools.
set -eu
cd "$(dirname "$0")/.."
arch="$(uname -m)"
case "$arch" in
  arm64) triple="aarch64-apple-darwin" ;;
  x86_64) triple="x86_64-apple-darwin" ;;
  *) echo "unsupported arch $arch" >&2; exit 1 ;;
esac
mkdir -p src-tauri/binaries
out="src-tauri/binaries/se-helper-$triple"
swiftc -O -module-name se_helper -o "$out" src-tauri/se-helper/main.swift 2>&1 | grep -v "warning" || true
test -x "$out"
# Ad-hoc signed here so `tauri dev` (which does not sign sidecars) runs the same bits as the
# bundle. `tauri build` re-signs it with the bundle's identity and entitlements.
codesign -s - -f --options runtime "$out" >/dev/null 2>&1
echo "$out"
