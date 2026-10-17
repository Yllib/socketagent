#!/usr/bin/env bash
# Signs Windows files in place with the SSL.com eSigner certificate through CodeSignTool.
# Usage: ./sign-windows.sh <file>...   sign the files as one signing run
#        ./sign-windows.sh --check     exit nonzero if a signing run is not allowed now
#
# eSigner bills per signing, so a machine gets one signing run per calendar day.
# Runs are recorded in $SOCKETAGENT_SIGNING_LOG (default
# ~/.local/state/socketagent/windows-signing.log). Another run the same day fails
# unless SOCKETAGENT_ALLOW_EXTRA_SIGNING=1, which build-app.sh sets for
# --allow-extra-signing. Only the user approves that override.
#
# Signing is set up per machine in signing.local.env (gitignored) next to this script:
#   SSLCOM_USERNAME=...            SSL.com login, not the Google sign-in
#   SSLCOM_CREDENTIAL_ID=...       from CodeSignTool get_credential_ids
#   SSLCOM_PASSWORD_FILE=...       file holding the account password
#   SSLCOM_TOTP_SECRET_FILE=...    file holding the eSigner TOTP secret, base64
#   CODE_SIGN_TOOL_PATH=...        optional, defaults to ~/.local/share/codesigntool
# Without that file it signs nothing, so builds on other machines still work.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$ROOT/signing.local.env"
LOG="${SOCKETAGENT_SIGNING_LOG:-$HOME/.local/state/socketagent/windows-signing.log}"

if [[ ! -f "$CONFIG" ]]; then
  [[ "${1:-}" == "--check" ]] || echo "Not signing $*: no signing.local.env on this machine."
  exit 0
fi

# Fails when today already has a signing run and no override was given.
check_daily_limit() {
  local earlier
  earlier="$(grep "^$(date +%F)T" "$LOG" 2>/dev/null | tail -1 | cut -d' ' -f1 || true)"
  [[ -z "$earlier" ]] && return 0
  if [[ "${SOCKETAGENT_ALLOW_EXTRA_SIGNING:-0}" == "1" ]]; then
    echo "Signing again today (last run $earlier) because the override is set."
    return 0
  fi
  echo "Already signed a release today ($earlier). eSigner charges per signing, so" >&2
  echo "a second run needs the user's approval: re-run with --allow-extra-signing." >&2
  return 1
}

if [[ "${1:-}" == "--check" ]]; then
  check_daily_limit
  exit
fi
check_daily_limit

# shellcheck source=/dev/null
source "$CONFIG"
TOOL="${CODE_SIGN_TOOL_PATH:-$HOME/.local/share/codesigntool}"
JAR="$(ls "$TOOL"/jar/code_sign_tool-*.jar | sort -V | tail -1)"
mkdir -p "$(dirname "$LOG")"

for file in "$@"; do
  file="$(realpath "$file")"
  out="$(mktemp -d)"
  # CodeSignTool reads conf/ from the working directory.
  (cd "$TOOL" && java -jar "$JAR" sign \
    -username="$SSLCOM_USERNAME" \
    -password="$(cat "$SSLCOM_PASSWORD_FILE")" \
    -credential_id="$SSLCOM_CREDENTIAL_ID" \
    -totp_secret="$(cat "$SSLCOM_TOTP_SECRET_FILE")" \
    -input_file_path="$file" \
    -output_dir_path="$out") 2>&1 | grep -v 'getCallerClass is not supported' || true
  signed="$out/$(basename "$file")"
  # CodeSignTool can print an error and still exit 0, so the output file is the real check.
  if [[ ! -f "$signed" ]]; then
    rm -rf "$out"
    echo "Signing failed: $file" >&2
    exit 1
  fi
  mv -f "$signed" "$file"
  rm -rf "$out"
  # Each file is one billed signing; the first line of a day starts the day's run.
  echo "$(date +%FT%T%z) $file" >> "$LOG"
done
