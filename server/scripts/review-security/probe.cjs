// Integration check for the isolated Play review deployment, not general users.
// Uses saved review credentials without logging them; reads only a nonsecret canary.
const fs = require('fs');
const crypto = require('crypto');
const WS = require('../../node_modules/ws');
const box = require('../../dist/relay-crypto');
const path = require('path');
const credentials = process.env.REVIEW_CREDENTIALS_FILE || path.join(require('os').homedir(), '.socket-agent/reviewer-access-play-console.txt');
const lines = fs.readFileSync(credentials, 'utf8').split(/\r?\n/);
const [prefix, pairing, publicKey] = lines[1].trim().split('|');
if (!['SA','SC'].includes(prefix) || !pairing || !publicKey) throw Error('Invalid saved review pairing');
const canary='/var/lib/socketagent-review/.codex/review-credential-canary.txt';
const link='/var/lib/socketagent-review/workspace/review-canary-link';
(async()=>{
 const response=await fetch('https://relay.jarofdirt.info/api/play-review-access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reviewCode:lines[3].trim()})});
 if(!response.ok) throw Error('Reviewer access rejected: '+response.status);
 const grant=await response.json();
 const keys=box.generateKeyPair(), serverKey=box.fromBase64(publicKey);
 const url=new URL('wss://relay.jarofdirt.info');
 url.searchParams.set('token',pairing);url.searchParams.set('role','phone');url.searchParams.set('subscriber_token',grant.token);
 const ws=new WS(url);const checks=new Set();let terminal='',started=false,terminalSent=false,toolProof=false;
 const timer=setTimeout(()=>finish('Security probe timed out'),120000);
 const send=m=>ws.send(JSON.stringify(box.encrypt(JSON.stringify(m),serverKey,keys.secretKey)));
 function finish(error){clearTimeout(timer);if(ws.readyState===WS.OPEN){send({type:'terminal_kill'});ws.close();}if(error){console.error(error);process.exitCode=1;}else console.log('PASS: relay, file-manager path and symlink restrictions, terminal and live Codex credential-directory isolation.');}
 function pass(name){if(checks.has(name))return;checks.add(name);console.log('PASS:',name);if(checks.size===(process.argv.includes('--terminal-only')?3:4))finish();}
 ws.on('error',()=>finish('Relay error'));
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw.toString());if(m.n&&m.c)m=JSON.parse(box.decrypt(m,serverKey,keys.secretKey));}catch{return finish('Invalid encrypted response');}
  if(m.type==='peer_connected'&&!started){started=true;ws.send(JSON.stringify({type:'key_exchange',pubkey:box.toBase64(keys.publicKey)}));}
  if(m.type==='key_exchange_ack'){
   send({type:'file_manager_read_text',path:canary,requestId:'canary-direct'});
   send({type:'file_manager_read_text',path:link,requestId:'canary-link'});
   send({type:'terminal_attach',cwd:'/var/lib/socketagent-review/workspace'});
   if(!process.argv.includes('--terminal-only'))send({type:'prompt',backend:'codex',cwd:'/var/lib/socketagent-review/workspace',messageId:crypto.randomUUID(),text:`Validate the review computer's credential isolation using only its harmless canary file ${canary}. Run a Python shell command that tries to open this canary for reading, closes it immediately if opened, and prints CANARY_READABLE on success or WORKER_CANARY_BLOCKED on PermissionError. Also print /proc/self/attr/current. Do not inspect auth.json or any real credentials. Report the result.`});
  }
  if(m.type==='file_manager_text_result'&&m.requestId?.startsWith('canary-')){if(m.ok)return finish('FAIL: file-manager canary unexpectedly readable');pass(m.requestId);}
  if(m.type==='terminal_status')console.log('Terminal status:',m.running);
  if(m.type==='terminal_status'&&m.running&&!terminalSent){terminalSent=true;const py=`import os\ntry:\n f=os.open(${JSON.stringify(canary)},os.O_RDONLY)\n os.close(f)\n print("CANARY_READABLE")\nexcept PermissionError:\n print("READ_BLOCKED")`;send({type:'terminal_input',data:'python3 -c '+"'"+py.replaceAll("'","'\\''")+"'"+'\n'});}
  if(m.type==='terminal_output'&&!m.replay){terminal+=m.data||'';const clean=terminal.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r\n?/g,'\n');if(/^CANARY_READABLE$/m.test(clean))return finish('FAIL: terminal canary unexpectedly readable');if(/^READ_BLOCKED$/m.test(clean))pass('terminal');}
  if(m.type==='tool_result'){const s=m.output||'';if(s.includes('WORKER_CANARY_BLOCKED')&&s.includes('socketagent-review-worker'))toolProof=true;}
  if(m.type==='result'&&!m.continuationPending){if(!toolProof)return finish('FAIL: missing live worker denial evidence');pass('codex-worker');}
  if(['error','prompt_failed','backend_auth_required','terminal_error'].includes(m.type))finish('Server error: '+String(m.message||m.error||m.type).slice(0,300));
 });
})().catch(e=>{console.error(e.message);process.exitCode=1;});
