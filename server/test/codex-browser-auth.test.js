const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { runCodexBrowserAuth } = require('../dist/codex-browser-auth');

const mock = String.raw`
let buffer='';
process.stdin.on('data', c => {
  buffer += c;
  for (;;) {
    const i=buffer.indexOf('\n'); if(i<0) break;
    const r=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
    require('fs').appendFileSync(process.env.RECORD, JSON.stringify(r)+'\n');
    const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
    if(r.method==='account/login/start') {
      emit({id:r.id,result:{type:'chatgpt',loginId:'login-1',authUrl:process.env.AUTH_URL}});
      emit({method:'account/login/completed',params:{loginId:'other-login',success:false}});
      if(process.env.COMPLETE==='yes') {
        const timer=setInterval(()=>{
          if(!require('fs').existsSync(process.env.COMPLETE_FILE))return;
          clearInterval(timer);
          emit({method:'account/login/completed',params:{loginId:'login-1',success:true}});
        },10);
      }
    } else if(r.id) emit({id:r.id,result:{}});
  }
});`;

async function fixture(t, complete = false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-browser-login-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const record=path.join(dir,'requests.jsonl');
  const received=[];
  const completeFile=path.join(dir,'login-completed');
  const callbackServer=http.createServer((req,res)=>{received.push(req.url);if(req.url==='/success'){fs.writeFileSync(completeFile,'done');res.writeHead(200);}else res.writeHead(302,{Location:'/success'});res.end();});
  await new Promise(resolve=>callbackServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>callbackServer.close(resolve)));
  const redirect=`http://127.0.0.1:${callbackServer.address().port}/auth/callback`;
  const authUrl=`https://auth.openai.com/oauth/authorize?state=fixture-state&redirect_uri=${encodeURIComponent(redirect)}`;
  return {
    options:{cwd:dir,command:process.execPath,args:['-e',mock],env:{...process.env,RECORD:record,AUTH_URL:authUrl,COMPLETE_FILE:completeFile,COMPLETE:complete?'yes':'no'},timeoutMs:2000,onReady:()=>{}},
    authUrl,redirect,received,
    requests:()=>fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse),
  };
}

test('returns normal browser link, forwards callback and completes the local success route', async t=>{
  const f=await fixture(t,true); let forwarded;
  await runCodexBrowserAuth({...f.options,onReady:(url,accept)=>{
    assert.equal(url,f.authUrl);
    forwarded=accept(`${f.redirect}?state=fixture-state&code=test-code`);
  }});
  await forwarded;
  assert.deepEqual(f.received,['/auth/callback?state=fixture-state&code=test-code','/success']);
  const requests=f.requests();
  assert.deepEqual(requests.find(r=>r.method==='account/login/start').params,{type:'chatgpt'});
  assert.equal(requests.some(r=>/thread|turn/.test(r.method)),false);
  assert.equal(requests.some(r=>r.method==='account/login/cancel'),false);
});

test('rejects callbacks for other hosts, paths, states and duplicate state values', async t=>{
  const f=await fixture(t);const controller=new AbortController();let checks;
  await assert.rejects(runCodexBrowserAuth({...f.options,signal:controller.signal,onReady:(_,accept)=>{
    checks=(async()=>{
      for(const url of [
        'https://example.com/auth/callback?state=fixture-state&code=x',
        `${f.redirect}?state=wrong&code=x`,
        `${f.redirect}?state=fixture-state&state=fixture-state&code=x`,
        `${f.redirect}/other?state=fixture-state&code=x`,
      ]) await assert.rejects(accept(url),/does not match/);
      controller.abort();
    })();
  }}),/cancelled/);
  await checks;
  assert.deepEqual(f.received,[]);
  assert.deepEqual(f.requests().find(r=>r.method==='account/login/cancel').params,{loginId:'login-1'});
});

test('browser sign-in timeout cancels pending login', async t=>{
  const f=await fixture(t);
  await assert.rejects(runCodexBrowserAuth({...f.options,timeoutMs:300}),/timed out/);
  assert.ok(f.requests().some(r=>r.method==='account/login/cancel'));
});

test('refuses a non-loopback callback from the login response', async t=>{
  const f=await fixture(t);
  f.options.env.AUTH_URL='https://auth.openai.com/authorize?state=x&redirect_uri=https://example.com/auth/callback';
  await assert.rejects(runCodexBrowserAuth(f.options),/unsupported sign-in callback/);
});
