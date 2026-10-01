#!/bin/bash
# Builds Phosphor on this Mac the way a signed release is built, Developer ID signed, notarized
# and stapled, and proves every link of that chain with the checks Gatekeeper itself runs. It
# publishes nothing: no release, no upload, no install. The output stays in src-tauri/target.
#
#   npm run notarize:local
#
# Inputs, all from ~/.config/phosphor-signing (PHOSPHOR_SIGNING_DIR overrides it):
#   developer-id.key      the private key the certificate signing request was made from
#   developer*id*.cer     the Developer ID Application certificate Apple issued for it
#
# and, for notarytool, the keychain profile phosphor-notary (NOTARY_PROFILE names another), made
# once with
#
#   xcrun notarytool store-credentials phosphor-notary --apple-id <Apple ID> --team-id <team>
#
# which asks for the app-specific password and keeps it in the keychain. Without the profile,
# notary.env with APPLE_API_KEY= and APPLE_API_ISSUER= and the key file AuthKey_<id>.p8 beside it
# is the other route. An Apple ID and password are never passed on notarytool's command line
# here: `ps` shows a process's arguments to every other process on the Mac.
#
# The key and the certificate become a .p12 in a private temporary directory, the .p12 goes into
# a throwaway keychain, and both are deleted when the script exits, however it exits. The .p8 is
# read where it lies. The login keychain is never written to; the throwaway one joins the search
# list for the length of the run (codesign looks there) and leaves it after.
#
# The updater bundle is signed with TAURI_SIGNING_PRIVATE_KEY when the environment has it, and
# otherwise with a throwaway key made for this run, whose signature no installed app accepts.
#
# NOTARIZE=0 skips Apple's service and SKIP_BUILD=1 reuses the last build; both exist to test
# this script, and a run with either cannot pass the Gatekeeper rows.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${PHOSPHOR_SIGNING_DIR:-$HOME/.config/phosphor-signing}"
target="aarch64-apple-darwin"

refuse() { echo "sign-and-notarize: $1" >&2; exit 1; }

# Refuse before anything is built, created or unlocked, naming the one thing that is missing.
key="$dir/developer-id.key"
test -f "$key" || refuse "missing $key (the private key behind the certificate request)"
cer="$(find "$dir" -maxdepth 1 -iname 'developer*id*.cer' | head -1)"
test -n "$cer" || refuse "missing $dir/developer*id*.cer (download the Developer ID Application certificate from developer.apple.com)"
notary_env=()
if [ "${NOTARIZE:-1}" = 1 ]; then
  env_file="$dir/notary.env"
  profile="${NOTARY_PROFILE:-phosphor-notary}"
  # Read by name rather than sourced: the file is data, not a script.
  field() { test -f "$env_file" && sed -n "s/^$1=//p" "$env_file" | tr -d '"'"'"'\r' | head -1; }
  # The profile sits in the data protection keychain, which `security` cannot list, so asking
  # Apple for the history is the check that it exists and still signs in.
  if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
    notary_env=(NOTARY_PROFILE="$profile")
  elif [ -n "$(field APPLE_API_KEY)" ]; then
    p8="$(find "$dir" -maxdepth 1 -name "AuthKey_$(field APPLE_API_KEY).p8" | head -1)"
    test -n "$p8" || refuse "missing $dir/AuthKey_$(field APPLE_API_KEY).p8 (the App Store Connect API key for notarytool)"
    test -n "$(field APPLE_API_ISSUER)" || refuse "$env_file has APPLE_API_KEY but no APPLE_API_ISSUER line"
    notary_env=(NOTARY_KEY_PATH="$p8" NOTARY_KEY_ID="$(field APPLE_API_KEY)" NOTARY_ISSUER="$(field APPLE_API_ISSUER)")
  else
    refuse "no notarytool keychain profile $profile; make it with: xcrun notarytool store-credentials $profile --apple-id <Apple ID> --team-id <team>"
  fi
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/phosphor-signing.XXXXXX")"
chmod 700 "$tmp"
keychain="$tmp/signing.keychain-db"
saved_list=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && saved_list+=("$line")
done < <(security list-keychains -d user)

cleanup() {
  status=$?
  if [ "${#saved_list[@]}" -gt 0 ]; then security list-keychains -d user -s "${saved_list[@]}" 2>/dev/null || true; fi
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$tmp"
  test ! -e "$tmp" && echo "sign-and-notarize: temporary keychain and files deleted"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The certificate arrives as DER; the key must be the one it was issued for, or the .p12 would
# carry an identity codesign cannot use and the failure would surface much later.
openssl x509 -inform DER -in "$cer" -out "$tmp/cert.pem" 2>/dev/null || cp "$cer" "$tmp/cert.pem"
cert_pub="$(openssl x509 -in "$tmp/cert.pem" -noout -pubkey | openssl sha256)"
key_pub="$(openssl pkey -in "$key" -pubout | openssl sha256)"
test "$cert_pub" = "$key_pub" || refuse "$cer was not issued for $key"
subject="$(openssl x509 -in "$tmp/cert.pem" -noout -subject)"
case "$subject" in
  *"Developer ID Application"*) ;;
  *) refuse "$cer is not a Developer ID Application certificate ($subject)" ;;
esac

# The password only exists to satisfy the .p12 format and `security import`; it never leaves
# this process. 3DES and SHA-1 because `security import` rejects OpenSSL 3's AES default.
p12_pass="$(openssl rand -hex 24)"
keychain_pass="$(openssl rand -hex 24)"
(umask 077; openssl pkcs12 -export -inkey "$key" -in "$tmp/cert.pem" -name "Phosphor Developer ID" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$p12_pass" -out "$tmp/identity.p12")

security create-keychain -p "$keychain_pass" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_pass" "$keychain"
security import "$tmp/identity.p12" -k "$keychain" -P "$p12_pass" -T /usr/bin/codesign >/dev/null
rm -f "$tmp/identity.p12"
# Apple's intermediate, committed beside the entitlements, so the chain to Apple's root resolves
# on a Mac that has never had Xcode sign anything.
security import "$root/src-tauri/signing/DeveloperIDG2CA.cer" -k "$keychain" >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_pass" "$keychain" >/dev/null
security list-keychains -d user -s "${saved_list[@]}" "$keychain"

# -v lists only identities whose chain reaches Apple's root. NOTARIZE=0 drops it so a throwaway
# self-signed identity can prove the rest of the chain; such a run cannot pass Gatekeeper anyway.
valid=(-v)
if [ "${NOTARIZE:-1}" = 0 ]; then valid=(); fi
identity_line="$(security find-identity ${valid[@]+"${valid[@]}"} -p codesigning "$keychain" | grep 'Developer ID Application' | head -1 || true)"
test -n "$identity_line" || refuse "the keychain holds no valid Developer ID Application identity (is the certificate expired or revoked?)"
identity_hash="$(echo "$identity_line" | awk '{ print $2 }')"
identity_name="${identity_line#*\"}"; identity_name="${identity_name%%\"*}"
echo "sign-and-notarize: signing as $identity_name"

cd "$root"
version="$(node -p "require('./package.json').version")"
bundle="$root/src-tauri/target/$target/release/bundle"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  npx --no-install tauri signer generate --ci -p "" -w "$tmp/updater.key" >/dev/null
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$tmp/updater.key")"
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  updater_key="throwaway (not shippable)"
else
  updater_key="TAURI_SIGNING_PRIVATE_KEY"
fi

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  # The bundle step signs the Secure Enclave XPC service with this identity, as on the runner.
  APPLE_SIGNING_IDENTITY="$identity_hash" npm run bundle
  # Nothing Apple reaches Tauri: it builds ad-hoc, as the release workflow's does, and
  # notarize-mac.sh does the rest.
  env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY \
    -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
    npx --no-install tauri build --target "$target" --bundles app,dmg
fi

env SIGN_IDENTITY="$identity_hash" SIGN_KEYCHAIN="$keychain" ${notary_env[@]+"${notary_env[@]}"} \
  bash "$root/scripts/notarize-mac.sh" "$bundle" "$version"

# The same checks the release workflow runs, and a few more, as a table.
app="$bundle/macos/Phosphor.app"
dmg="$bundle/dmg/Phosphor_${version}_aarch64.dmg"
rows=()
failed=0
check() {
  local name="$1"; shift
  if "$@" >"$tmp/check.out" 2>&1; then rows+=("PASS  $name"); else rows+=("FAIL  $name"); failed=1; sed 's/^/        /' "$tmp/check.out" | head -5 >&2; fi
}
# Output is captured before it is matched: under pipefail, grep -q closing the pipe early can
# kill codesign with SIGPIPE and fail a check that should pass.
details() { codesign -dvv "$1" 2>&1 || true; }
signed_by_developer_id() { details "$1" > "$tmp/details"; grep -q '^Authority=Developer ID Application' "$tmp/details"; }
has_runtime() { details "$1" > "$tmp/details"; grep -q 'flags=.*runtime' "$tmp/details"; }
has_timestamp() { details "$1" > "$tmp/details"; grep -q '^Timestamp=' "$tmp/details"; }
nested_ok() { signed_by_developer_id "$1" && has_runtime "$1" && has_timestamp "$1"; }
no_debugger_allowed() { codesign -d --entitlements - --xml "$1" > "$tmp/ent" 2>/dev/null || true; ! grep -q 'get-task-allow' "$tmp/ent"; }
tarball_holds_app() { tar -tzf "$1" > "$tmp/listing"; test -s "$1.sig" && test "$(head -1 "$tmp/listing" | cut -d/ -f1)" = Phosphor.app; }
dmg_app_stapled() {
  local mnt="$tmp/check-dmg"
  mkdir -p "$mnt"
  hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mnt" >/dev/null
  local ok=0
  xcrun stapler validate "$mnt/Phosphor.app" && codesign --verify --deep --strict "$mnt/Phosphor.app" || ok=1
  hdiutil detach "$mnt" >/dev/null
  return "$ok"
}

check "app: codesign --verify --deep --strict" codesign --verify --deep --strict --verbose=2 "$app"
check "app: signed by Developer ID Application" signed_by_developer_id "$app"
check "app: hardened runtime" has_runtime "$app"
check "app: secure timestamp" has_timestamp "$app"
check "app: no get-task-allow entitlement" no_debugger_allowed "$app"
for code in "$app"/Contents/MacOS/* "$app"/Contents/XPCServices/*.xpc; do
  [ -e "$code" ] || continue
  [ "$code" = "$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")" ] && continue
  check "nested: $(basename "$code") Developer ID, runtime, timestamp" \
    nested_ok "$code"
done
check "app: spctl -a -vv -t exec" spctl -a -vv -t exec "$app"
check "app: stapler validate" xcrun stapler validate "$app"
check "updater: tar.gz holds Phosphor.app, .sig present ($updater_key)" tarball_holds_app "$bundle/macos/Phosphor.app.tar.gz"
check "dmg: codesign --verify --strict" codesign --verify --strict --verbose=2 "$dmg"
check "dmg: signed by Developer ID Application" signed_by_developer_id "$dmg"
check "dmg: spctl -a -vv -t open --context context:primary-signature" spctl -a -vv -t open --context context:primary-signature "$dmg"
check "dmg: stapler validate" xcrun stapler validate "$dmg"
check "dmg: app inside is the stapled one" dmg_app_stapled

echo
printf '%s\n' "${rows[@]}"
echo
if [ "$failed" = 0 ]; then
  echo "PASS: $dmg is signed, notarized and stapled"
else
  echo "FAIL: see the rows above"
fi
exit "$failed"
