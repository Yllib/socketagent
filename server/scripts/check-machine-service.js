// run-service.bat calls this before each start. Exit 0 means a healthy
// SocketAgent already answers on this install's port while running as the
// machine service, so a copy started by a logon task must not start a second
// server. Any other answer, or none, exits 1 and the wrapper carries on.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const dotenv = require('dotenv');

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @type {Record<string, string>} */
let env;
try {
  env = dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env')));
} catch {
  process.exit(1);
}
const request = http.get({ hostname: '127.0.0.1', port: Number(env.PORT || 8085), path: '/internal/restart/health',
  headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` }, timeout: 1500 }, response => {
  let data = '';
  response.on('data', (/** @type {Buffer} */ chunk) => { data += chunk; if (data.length > 65536) request.destroy(); });
  response.on('end', () => {
    try {
      /** @type {unknown} */
      const body = JSON.parse(data);
      const serving = response.statusCode === 200 && isRecord(body) && body.service === 'socketagent' && body.ready === true
        && isRecord(body.identity) && body.identity.service === true;
      process.exit(serving ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
});
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
