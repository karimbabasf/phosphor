#!/bin/bash
# Turns the ad-hoc build `tauri build --bundles app,dmg` left in <bundle dir> into a Developer ID
# signed, notarized and stapled release: the app, the updater bundle made from it, and the DMG.
# Run by .github/workflows/release.yml on a signed build and by sign-and-notarize-local.sh.
#
#   scripts/notarize-mac.sh <bundle dir> <version>
#
# Environment:
#   SIGN_IDENTITY     "Developer ID Application: Name (TEAMID)", or its SHA-1 hash
#   SIGN_KEYCHAIN     the keychain that holds it (optional; codesign searches the list without it)
#   NOTARY_PROFILE    a notarytool keychain profile (`notarytool store-credentials`). Wins over
#                     the two below, and is the one to use on a shared machine: the others put
#                     a secret on notarytool's command line, where any local process can read it
#   or NOTARY_APPLE_ID, NOTARY_PASSWORD, NOTARY_TEAM_ID
#                     the Apple ID notarytool submits as, an app-specific password, the team
#   or NOTARY_KEY_PATH, NOTARY_KEY_ID, NOTARY_ISSUER
#                     an App Store Connect API key; the Apple ID wins when both are set
#   NOTARY_TIMEOUT    how long to wait on Apple per submission, 45m unless set. A team's first
#                     submissions can sit In Progress for hours.
#   NOTARIZE=0        sign and rebuild everything but skip Apple's service. Only for proving the
#                     chain with a throwaway identity; nothing made this way can ship.
#
# Why this and not Tauri's own signing. Tauri signs the app, its sidecars and the DMG, and
# notarizes the app, but it signs nothing nested in a bundle (an XPC service in
# Contents/XPCServices, a framework's inner binaries), it never notarizes or staples the DMG, and
# its temporary keychain is gone by the time a later step could: Keychain's Drop impl runs
# `security delete-keychain` (tauri-macos-sign, src/keychain.rs, CLI 2.11.4), and each bundle
# type makes and drops its own. So Tauri builds ad-hoc, exactly as on an unsigned release, and
# everything Apple checks is done here, in one place, in the order Apple needs:
#
#   1. sign inside out: every Mach-O, then every nested bundle deepest first, then the app
#   2. notarize the app and staple its ticket
#   3. rebuild the updater bundle from the stapled app
#   4. put the stapled app into the DMG in place of the ad-hoc one (Finder layout kept)
#   5. sign the DMG, notarize it, staple it
#
# The updater bundle's minisign signature is not made here: scripts/updater-sign.ts makes it in a
# later step, once the signing keychain is deleted, so the update key and the Developer ID are
# never usable at the same moment. Checksums, latest.json and provenance come after that, so
# they describe the stapled files.
set -euo pipefail

bundle="${1:?usage: notarize-mac.sh <bundle dir> <version>}"
version="${2:?usage: notarize-mac.sh <bundle dir> <version>}"
: "${SIGN_IDENTITY:?SIGN_IDENTITY is not set}"
notarize="${NOTARIZE:-1}"
notary_auth=()
if [ "$notarize" = 1 ]; then
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    notary_auth=(--keychain-profile "$NOTARY_PROFILE")
  elif [ -n "${NOTARY_APPLE_ID:-}" ] && [ -n "${NOTARY_PASSWORD:-}" ] && [ -n "${NOTARY_TEAM_ID:-}" ]; then
    notary_auth=(--apple-id "$NOTARY_APPLE_ID" --password "$NOTARY_PASSWORD" --team-id "$NOTARY_TEAM_ID")
  elif [ -n "${NOTARY_KEY_PATH:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ]; then
    notary_auth=(--key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  else
    echo "notarize: set NOTARY_PROFILE, or NOTARY_APPLE_ID, NOTARY_PASSWORD and NOTARY_TEAM_ID, or NOTARY_KEY_PATH, NOTARY_KEY_ID and NOTARY_ISSUER" >&2
    exit 1
  fi
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
entitlements="$root/src-tauri/entitlements.plist"
app="$bundle/macos/Phosphor.app"
tarball="$bundle/macos/Phosphor.app.tar.gz"
dmg="$bundle/dmg/Phosphor_${version}_aarch64.dmg"
for path in "$app" "$dmg" "$entitlements"; do
  test -e "$path" || { echo "notarize: $path is missing" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/phosphor-notarize.XXXXXX")"
mounted=""
cleanup() {
  if [ -n "$mounted" ] && mount | grep -qF " on $mounted "; then hdiutil detach "$mounted" -force >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

keychain_args=()
if [ -n "${SIGN_KEYCHAIN:-}" ]; then keychain_args=(--keychain "$SIGN_KEYCHAIN"); fi

# --timestamp is Apple's secure timestamp, which notarization requires; codesign's default for it
# changes between releases, so it is asked for by name. --options runtime is the hardened
# runtime, required for every executable Apple notarizes.
sign() {
  codesign --force --timestamp --options runtime -s "$SIGN_IDENTITY" ${keychain_args[@]+"${keychain_args[@]}"} "$@"
}

is_macho() {
  case "$(file -b "$1")" in *Mach-O*) return 0 ;; *) return 1 ;; esac
}

# Depth of a path in slashes, so nested bundles sign before the bundle that holds them.
by_depth() {
  awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-
}

notarize_file() {
  local file="$1" label="$2" result status="" id="" found attempt
  result="$work/$label.json"
  # A dropped connection fails the upload (abortedUpload, no id comes back) or the wait (an id,
  # no verdict). Up to three tries: a failed upload is submitted again, a broken wait waits
  # again on the same id rather than paying for a second submission.
  for attempt in 1 2 3; do
    if [ -z "$id" ]; then
      xcrun notarytool submit "$file" "${notary_auth[@]}" \
        --wait --timeout "${NOTARY_TIMEOUT:-45m}" --output-format json > "$result" || true
    else
      xcrun notarytool wait "$id" "${notary_auth[@]}" \
        --timeout "${NOTARY_TIMEOUT:-45m}" --output-format json > "$result" || true
    fi
    found="$(plutil -extract id raw -o - "$result" 2>/dev/null || true)"
    if [ -n "$found" ]; then id="$found"; fi
    status="$(plutil -extract status raw -o - "$result" 2>/dev/null || true)"
    # A verdict, or In Progress past NOTARY_TIMEOUT: either way, trying again would not help.
    if [ -n "$status" ]; then break; fi
    if [ "$attempt" -lt 3 ]; then
      echo "notarize: $label attempt $attempt got no answer from Apple, trying again in $((attempt * 60))s" >&2
      sleep $((attempt * 60))
    fi
  done
  echo "notarize: $label submission $id: $status"
  if [ "$status" != "Accepted" ]; then
    # The log names every file Apple refused and why; without it a rejection is a guess.
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" "${notary_auth[@]}" >&2 || true
    fi
    exit 1
  fi
}

# 1. Inside out. Extended attributes first: a resource fork or Finder info on any file inside
# the bundle makes codesign refuse it (Apple QA1940).
xattr -cr "$app"
main="$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")"

# Every Mach-O that is not the app's own executable, wherever it sits: the sidecars in
# Contents/MacOS today, anything an XPC service or a framework carries tomorrow. A file inside a
# nested bundle keeps whatever entitlements its own build gave it; a sidecar of the app itself
# gets the app's entitlements, which is what Tauri's ad-hoc pass gave it too.
find "$app/Contents" -type f | by_depth | while IFS= read -r file; do
  [ "$file" = "$app/Contents/MacOS/$main" ] && continue
  is_macho "$file" || continue
  if [ "$(dirname "$file")" = "$app/Contents/MacOS" ]; then
    sign --entitlements "$entitlements" "$file"
  else
    sign --preserve-metadata=entitlements "$file"
  fi
done

# Nested bundles, deepest first, each keeping its own entitlements. Contents/XPCServices is
# where the Secure Enclave helper moves to; the loop is empty while it does not exist.
find "$app/Contents" -type d \( -name '*.xpc' -o -name '*.framework' -o -name '*.app' -o -name '*.appex' -o -name '*.bundle' \) \
  | by_depth | while IFS= read -r nested; do
  sign --preserve-metadata=entitlements "$nested"
done

sign --entitlements "$entitlements" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# 2. Apple takes an app as a zip; ditto makes the one Finder would.
if [ "$notarize" = 1 ]; then
  ditto -c -k --keepParent "$app" "$work/Phosphor.zip"
  notarize_file "$work/Phosphor.zip" app
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
else
  echo "notarize: NOTARIZE=0, the app is signed but not notarized"
fi

# 3. The updater bundle Tauri wrote holds the ad-hoc app. Same shape as Tauri's own
# (tauri-bundler, src/bundle/updater_bundle.rs: a gzipped tar whose one top entry is
# Phosphor.app), without the AppleDouble files and extended attributes macOS tar would add.
rm -f "$tarball" "$tarball.sig"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$tarball" -C "$(dirname "$app")" Phosphor.app

# 4. Swap the app inside the DMG. Converting to read-write and back keeps Tauri's Finder layout
# (.DS_Store, background, icon positions), which is keyed on the name, and the name is the same.
# The image is grown first: Tauri sizes it to what it held, and a stapled app is a little bigger.
rw="$work/rw.dmg"
hdiutil convert "$dmg" -format UDRW -ov -o "$rw" >/dev/null
hdiutil resize -size "$(( $(du -sm "$app" | cut -f1) * 2 + 64 ))m" "$rw" >/dev/null
# Mounted at a path this script names, and marked mounted before the attach, so the exit trap
# detaches it whatever fails after.
mounted="$work/mnt"
mkdir -p "$mounted"
hdiutil attach "$rw" -readwrite -noverify -noautoopen -nobrowse -mountpoint "$mounted" >/dev/null
test -d "$mounted/Phosphor.app" || { echo "notarize: the DMG holds no Phosphor.app" >&2; exit 1; }
rm -rf "$mounted/Phosphor.app"
ditto "$app" "$mounted/Phosphor.app"
rm -rf "$mounted/.fseventsd"
sync
hdiutil detach "$mounted" >/dev/null
mounted=""
hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -ov -o "$work/out.dmg" >/dev/null
mv -f "$work/out.dmg" "$dmg"

# 5. A DMG is signed without the hardened runtime (it is not code), then notarized on its own:
# a stapled DMG opens offline without a dialog, which a stapled app inside an unstapled DMG
# does not promise.
codesign --force --timestamp -s "$SIGN_IDENTITY" ${keychain_args[@]+"${keychain_args[@]}"} "$dmg"
codesign --verify --strict --verbose=2 "$dmg"
if [ "$notarize" = 1 ]; then
  notarize_file "$dmg" dmg
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
fi
echo "notarize: $app, $tarball and $dmg are done"
