// Probe our authenticated loopback endpoint, not merely an open TCP port.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env')));
const deadline = Date.now() + Number(process.argv[2] || 0) * 1000;
function probe(endpoint = 'health') {
  let finished = false;
  const finish = (error, body) => {
    if (finished) return;
    finished = true;
    if (!error) { console.log(JSON.stringify(body)); return; }
    if (Date.now() < deadline) { setTimeout(probe, 1000); return; }
    console.error(`SocketAgent is not ready: ${error.message}. See server/socketagent.log`);
    process.exitCode = 1;
  };
  const request = http.get({ hostname: '127.0.0.1', port: Number(env.PORT || 8085),
    path: `/internal/restart/${endpoint}`, headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` }, timeout: 2000 }, response => {
    if (response.statusCode === 404 && endpoint === 'health') { response.resume(); probe('status'); return; }
    let data = '';
    response.on('data', chunk => { data += chunk; if (data.length > 65536) request.destroy(new Error('Unexpected health response')); });
    response.on('error', finish);
    response.on('end', () => {
      try {
        const body = JSON.parse(data);
        if (response.statusCode !== 200 || (endpoint === 'health' ? body.service !== 'socketagent' : typeof body.preparing !== 'boolean' || !Array.isArray(body.sessions)) || body.ready !== true || !Number.isInteger(body.pid)) throw new Error(`Readiness check returned ${response.statusCode}`);
        finish(null, { ready: true, pid: body.pid });
      } catch (error) { finish(error); }
    });
  });
  request.on('timeout', () => request.destroy(new Error('Readiness check timed out')));
  request.on('error', finish);
}
probe();
