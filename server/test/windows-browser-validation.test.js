const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateWindowsLaunch } = require('../scripts/install-browser-runtime');

for (const mode of ['good', 'late', 'bad', 'relaunch']) {
  test(`Windows browser validation checks CDP page contents with no stdout: ${mode}`, { skip: process.platform === 'win32' }, async () => {
    // The portable fixture emulates a GUI browser's control interface. Real
    // Windows executables are covered by the disposable VM smoke checks.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-browser-'));
    const profile = path.join(fixture, mode);
    fs.mkdirSync(profile);
    const executable = path.join(fixture, 'browser');
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const mode = path.basename(profile);
// 'relaunch' restarts itself and exits 0, as Chrome does under an elevated server.
if (mode === 'relaunch' && !process.argv.includes('--relaunched')) {
  spawn(process.execPath, [...process.argv.slice(1), '--relaunched'], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}
fs.writeFileSync(path.join(profile, 'browser.pid'), String(process.pid));
const server = http.createServer((req,res) => {
  const base = 'ws://127.0.0.1:'+server.address().port;
  res.end(JSON.stringify(req.url === '/json/version'
    ? { webSocketDebuggerUrl: base+'/browser' }
    : [{ type:'page', webSocketDebuggerUrl: base+'/page' }]));
});
const sockets = new WebSocketServer({ server });
let reads = 0;
sockets.on('connection', (socket, req) => socket.on('message', raw => {
  const msg = JSON.parse(raw);
  if(msg.method === 'Runtime.evaluate') {
    // 'late' lists the page before it commits, as a cold first launch does.
    const ok = mode === 'good' || mode === 'relaunch' || (mode === 'late' && ++reads > 1);
    socket.send(JSON.stringify({ id:msg.id, result:{ result:{ value:ok?'<p>ok</p>':mode==='late'?'<html><head></head><body></body></html>':'<p>wrong page</p>' } } }));
    if(mode==='bad') setTimeout(() => process.exit(0), 100);
  }
  if(msg.method === 'SystemInfo.getProcessInfo') socket.send(JSON.stringify({ id:msg.id, result:{ processInfo:[{ type:'browser', id:process.pid }] } }));
  // Like Chrome here, only the browser target quits on Browser.close.
  if(msg.method === 'Browser.close' && req.url === '/browser') process.exit(0);
}));
server.listen(0,'127.0.0.1', () => fs.writeFileSync(path.join(profile,'DevToolsActivePort'),String(server.address().port)+'\\n/page'));
`, { mode: 0o755 });
    const output = fs.openSync(path.join(fixture, 'stdout'), 'w');
    const error = fs.openSync(path.join(fixture, 'stderr'), 'w');
    try {
      const result = await validateWindowsLaunch(executable, profile, output, error);
      assert.equal(result.status, mode === 'bad' ? 1 : 0, result.error instanceof Error ? result.error.message : undefined);
      assert.equal(fs.readFileSync(path.join(fixture, 'stdout'), 'utf8'), '');
      if (mode === 'bad') {
        assert.ok(result.error instanceof Error);
        assert.match(result.error.message, /could not render/);
      } else {
        // The browser that answered is gone, including one that restarted.
        const pid = Number(fs.readFileSync(path.join(profile, 'browser.pid'), 'utf8'));
        assert.throws(() => process.kill(pid, 0));
      }
    } finally {
      fs.closeSync(output); fs.closeSync(error);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
