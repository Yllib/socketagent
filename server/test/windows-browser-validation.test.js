const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateWindowsLaunch } = require('../scripts/install-browser-runtime');

for (const mode of ['good', 'bad']) {
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
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const server = http.createServer((req,res) => {
  res.end(JSON.stringify([{ type:'page', webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/page' }]));
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', socket => socket.on('message', raw => {
  const msg = JSON.parse(raw);
  if(msg.method === 'Runtime.evaluate') {
    socket.send(JSON.stringify({ id:msg.id, result:{ result:{ value:path.basename(profile)==='good'?'<p>ok</p>':'<p>wrong page</p>' } } }));
    if(path.basename(profile)==='bad') setTimeout(() => process.exit(0), 100);
  }
  if(msg.method === 'Browser.close') process.exit(0);
}));
server.listen(0,'127.0.0.1', () => fs.writeFileSync(path.join(profile,'DevToolsActivePort'),String(server.address().port)+'\\n/page'));
`, { mode: 0o755 });
    const output = fs.openSync(path.join(fixture, 'stdout'), 'w');
    const error = fs.openSync(path.join(fixture, 'stderr'), 'w');
    try {
      const result = await validateWindowsLaunch(executable, profile, output, error);
      assert.equal(result.status, mode === 'good' ? 0 : 1, result.error?.message);
      assert.equal(fs.readFileSync(path.join(fixture, 'stdout'), 'utf8'), '');
      if (mode === 'bad') assert.match(result.error.message, /could not render/);
    } finally {
      fs.closeSync(output); fs.closeSync(error);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
