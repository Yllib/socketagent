const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
test('installer health rejects unrelated listeners, failed auth, and a server that is not ready', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-health-'));
  let mode = 'unrelated';
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer lab-token');
    if (mode.startsWith('legacy')) {
      res.statusCode = req.url.endsWith('/health') ? 404 : 200;
      res.end(JSON.stringify({ ready: true, pid: 123, preparing: false, ...(mode === 'legacy' ? { sessions: [] } : {}) }));
      return;
    }
    assert.equal(req.url, '/internal/restart/health');
    res.statusCode = mode === 'auth' ? 401 : mode === 'starting' ? 503 : 200;
    res.end(JSON.stringify(mode === 'unrelated' ? { ready: true, pid: 123 } : { service: 'socketagent', ready: mode === 'ready', pid: 123 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(fixture, 'node_modules'), 'junction');
    fs.copyFileSync(path.resolve(__dirname, '../scripts/check-health.js'), path.join(fixture, 'scripts/check-health.js'));
    fs.writeFileSync(path.join(fixture, '.env'), `PORT=${server.address().port}\nAUTH_TOKEN=lab-token\n`);
    for (mode of ['unrelated', 'auth', 'starting', 'ready', 'legacy', 'legacy-invalid']) {
      const code = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(fixture, 'scripts/check-health.js')], { stdio: 'ignore' });
        child.on('exit', resolve);
      });
      assert.equal(code, ['ready', 'legacy'].includes(mode) ? 0 : 1, mode);
    }
  } finally { server.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
});
