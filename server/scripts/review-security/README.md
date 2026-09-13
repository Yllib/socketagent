# Isolated Play review deployment

This configuration applies only to `/opt/socketagent-review` and
`socketagent-review.service`. It is not the default SocketAgent installer.

The provider login is the dedicated free `contact@rubanoenterprises.com` account.
The personal account was logged out before this account was authorized. The
runtime account API reports plan `free`. Its default available model was
`gpt-5.6-terra`; that model is selected in `/etc/socketagent-review.env`.
Connected apps remain disabled. No new payment method or paid plan was added.

## Enforced boundary

`apparmor.profile` is installed as `/etc/apparmor.d/socketagent-review`.
The service drop-in selects `AppArmorProfile=socketagent-review-server`.
The Node server cannot read or write the review user's `.codex` directory.
Only the pinned native Codex executable transitions to the profile allowed to
use the login cache. Every executable it launches transitions to
`socketagent-review-worker`, which cannot access that directory. Terminal
shells and other server subprocesses also use the worker profile. Worker
execution of Codex inherits the worker restriction, not the credential profile.
Ptrace and sensitive procfs descriptor/memory paths are denied.

The existing systemd `ProtectHome=true`, `ProtectSystem=strict`, empty capability
bounding set, and `/var/lib/socketagent-review` write root remain. The drop-in
sets `RestrictSUIDSGID=true`. `NoNewPrivileges=false` is necessary for the trusted
server-to-Codex AppArmor transition; the kernel rejected that transition with
EPERM while NoNewPrivileges was enabled. AppArmor is enforced, not complain mode.

`CODEX_BIN` points directly at the native binary named in the profile, avoiding
the JavaScript npm launcher. `SHELL=/bin/bash` supplies the app terminal without
changing the Linux account's nologin shell. File manager roots are explicitly
limited to `/var/lib/socketagent-review/workspace`, with absolute-path bypass
disabled. This also rejects symlinks pointing outside the workspace.

This protects the tested command and file-transfer paths. Codex itself remains
a trusted credential-bearing process. Keep its version pinned at 0.153.2 and
repeat the tests before changing the executable, native tools, or security
configuration. Do not replace these profiles with Unix file permissions alone.

## Validation

September 6, 2026, Eastern time:

- Verified the stored login's email matches the dedicated account, without
  printing tokens. The account API reports `free`.
- In the server profile, opening the login cache fails with EACCES; spawning
  the trusted Codex executable still reports successful login.
- The public relay accepted the existing review code and pairing credentials.
  Real Codex wrote/read a random marker, resumed the session, and read it again.
- `node server/scripts/review-security/probe.cjs` passes the file manager's
  direct-path and symlink denials, app-terminal denial, and real Codex shell
  denial. It tests a harmless `review-credential-canary.txt` beside the login
  cache and never requests real token contents. `--terminal-only` skips AI use.
- Normal prompt history and resume passed. Native archive-status SQLite helper
  scans are blocked by the directory restriction and log a warning; this check
  does not establish native archive indexing support.

The service is active under the enforced profile. No main-server restart, public
repository push, app rebuild, or production Play submission was performed for
this change. Free-account quota availability still needs monitoring during review.
