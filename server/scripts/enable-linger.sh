#!/usr/bin/env bash
# Turns on lingering for the current user, so the systemd user service starts
# at boot and keeps running after logout. install-server.sh calls it.
# logind refuses the request from an ordinary user when polkit is missing, as
# on Ubuntu Minimal, or when the session is remote. It then asks through sudo,
# without a password prompt. Exits 0 when lingering is on, 1 when it is not.
set -u

command -v loginctl >/dev/null 2>&1 || exit 0
user=$(id -un)
lingering() {
  [[ "$(loginctl show-user "$user" --property=Linger --value 2>/dev/null)" == "yes" ]]
}

lingering && exit 0
loginctl enable-linger "$user" >/dev/null 2>&1 || true
lingering && exit 0
if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  sudo -n loginctl enable-linger "$user" >/dev/null 2>&1 || true
fi
lingering
