# For the isolated, dedicated-account Play review service only.
# Bind this to the service with AppArmorProfile=socketagent-review-server.
# Executable paths intentionally match the separate /opt review installation.

profile socketagent-review-server flags=(attach_disconnected,mediate_deleted) {
  /** rwklm,
  network,
  signal,
  capability,
  deny ptrace,
  deny /var/lib/socketagent-review/.codex{,/**} rwklm,
  deny /proc/*/{mem,environ,fd/**,map_files/**} rwklm,

  /opt/socketagent-review/node/bin/node ix,
  /opt/socketagent-review/codex/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex Px -> socketagent-review-codex,
  /{usr,bin,sbin,lib,lib64}/** Px -> socketagent-review-worker,
  /opt/socketagent-review/server/** Px -> socketagent-review-worker,
  /var/lib/socketagent-review/** Px -> socketagent-review-worker,
}

profile socketagent-review-codex flags=(attach_disconnected,mediate_deleted) {
  /** rwklm,
  network,
  signal,
  capability,
  deny ptrace,
  # Codex itself needs the login cache. Every child executable loses access.
  /** Px -> socketagent-review-worker,
}

profile socketagent-review-worker flags=(attach_disconnected,mediate_deleted) {
  /** rwklm,
  /** ix,
  network,
  signal,
  capability,
  deny ptrace,
  # Protect credentials and configuration even from the same Unix uid.
  deny /var/lib/socketagent-review/.codex{,/**} rwklm,
  deny /proc/*/{mem,environ,fd/**,map_files/**} rwklm,
}
