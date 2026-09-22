const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const data = require('./test-data-dir');
const store = require('../dist/session-store');
const {handleRememberTool} = require('../dist/app-tool-handlers');
const {requestTranscriptAccess} = require('../dist/transcript-access-approval');
const {CodexSession} = require('../dist/codex-session');
const parse = r => JSON.parse(r.content[0].text);

test('global access waits for a user card; deny, cancel, and missing authorization reveal nothing', async () => {
  const packets = [], pending = new Map();
  const ctx = {getSessionId: () => 'requester', send: m => packets.push(m)};
  store.appendHistory('other-session', {role:'user',content:'globalneedle secret project',timestamp:'2026-09-01T00:00:00Z'});
  const denied = await handleRememberTool(ctx, {action:'search_all',query:'globalneedle'});
  assert.equal(denied.isError,true);
  assert.ok(!denied.content[0].text.includes('secret project'));
  ctx.requestTranscriptAccess = detail => requestTranscriptAccess({sessionId:'requester',pendingQuestions:pending,send:ctx.send,appendHistory:e=>store.appendHistory('requester',e)}, detail);
  let completed = false;
  const response = handleRememberTool(ctx,{action:'search_all',query:'globalneedle'}).then(r=>{completed=true;return r;});
  await new Promise(r=>setImmediate(r));
  assert.equal(completed,false);
  const card=packets.at(-1);
  assert.match(card.questions[0].question,/all sessions/);
  assert.match(card.questions[0].question,/globalneedle/);
  pending.get(card.questionId).resolve({[card.questions[0].question]:'Deny'});
  assert.equal((await response).isError,true);
  const cancelled=handleRememberTool(ctx,{action:'search_all',query:'globalneedle'});
  pending.values().next().value.cancel();
  assert.equal((await cancelled).isError,true);
  assert.equal(pending.size,0);
});

test('approved search finds other sessions and clear-context archives; every read needs fresh approval', async () => {
  const archiveDir=path.join(data,'archive');
  fs.mkdirSync(archiveDir,{recursive:true});
  // Use the store's clear operation so archive paths and identity are realistic.
  store.saveSession({id:'cleared',title:'Old work',cwd:'/tmp',backend:'codex',createdAt:'2026-09-01T00:00:00Z',lastActive:'2026-09-01T00:00:00Z'});
  store.appendHistory('cleared',{role:'user',content:'globalneedle archived project',timestamp:'2026-09-02T00:00:00Z'});
  store.clearSessionContext('cleared','/tmp');
  let approvals=0;
  const ctx={getSessionId:()=> 'requester',requestTranscriptAccess:async()=>{approvals++;return true;}};
  const result=parse(await handleRememberTool(ctx,{action:'search_all',query:'globalneedle'}));
  assert.equal(result.results.length,2);
  const archived=result.results.find(r=>r.archived);
  assert.ok(archived);
  const entry=await handleRememberTool(ctx,{action:'get',source_id:archived.source_id,entry_id:archived.entry_id});
  assert.match(entry.content[0].text,/archived project/);
  assert.equal(approvals,2);
  assert.equal(store.rememberSearchHistory('cleared',{query:'globalneedle'}).length,0);
  ctx.requestTranscriptAccess=async()=>false;
  assert.equal((await handleRememberTool(ctx,{action:'context',source_id:archived.source_id,session_seq:archived.session_seq})).isError,true);
  assert.equal((await handleRememberTool(ctx,{action:'search',query:'globalneedle',source_id:archived.source_id})).isError,true);
  ctx.requestTranscriptAccess=async()=>true;
  assert.equal((await handleRememberTool(ctx,{action:'get',source_id:'archive:../../outside_history.json',session_seq:1})).isError,true);
  const first=parse(await handleRememberTool(ctx,{action:'search_all',query:'globalneedle',limit:1}));
  const second=parse(await handleRememberTool(ctx,{action:'search_all',query:'globalneedle',limit:1,offset:1}));
  assert.notEqual(first.results[0].source_id,second.results[0].source_id);
});

test('Codex automatic approval mode cannot bypass transcript approval, and abort cancels it', async () => {
  const packets=[];
  const session=new CodexSession({readyState:1,send:v=>packets.push(JSON.parse(v))},'/tmp');
  session.sessionId='approval-session'; session._permissionMode='superYolo';
  const result=handleRememberTool(session.createAppToolContext(),{action:'search_all',query:'globalneedle'});
  assert.equal(session.pendingQuestions.size,1);
  session.cancelPendingAppServerQuestions();
  assert.equal((await result).isError,true);
  assert.ok(packets.some(p=>p.type==='question_answered'));
});
