const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { saveOAuthTokens } = require("#server/claude-auth");

test("on macOS a sign-in also replaces the Keychain item the Claude CLI reads first", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-keychain-"));
  const bin = path.join(dir, "bin");
  const received = path.join(dir, "security-stdin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "security"), `#!/bin/sh\n[ "$1" = "-i" ] && cat > "${received}"\n`, { mode: 0o755 });

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER };
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => {
    Object.assign(process.env, saved);
    if (platform) Object.defineProperty(process, "platform", platform);
  });
  Object.assign(process.env, { HOME: dir, PATH: `${bin}:${saved.PATH}`, USER: "williamrubano" });
  Object.defineProperty(process, "platform", { value: "darwin" });

  saveOAuthTokens({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });

  const file = fs.readFileSync(path.join(dir, ".claude", ".credentials.json"), "utf8");
  const command = fs.readFileSync(received, "utf8");
  const match = command.match(/^add-generic-password -U -a "williamrubano" -s "Claude Code-credentials" -X "([0-9a-f]+)"\n$/);
  assert.ok(match, command);
  assert.equal(Buffer.from(match[1], "hex").toString("utf8"), file);
  assert.match(file, /"refreshToken":"refresh"/);
});
