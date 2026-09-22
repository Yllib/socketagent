const assert=require('node:assert/strict');
const test=require('node:test');
require('./test-data-dir');
const {codexRewindTarget,rewindCodexConversation,isCodexRewinding}=require('../dist/codex-conversation-rewind');
const {appendHistory,getHistory,rememberSearchAllHistory}=require('../dist/session-store');
const {codexRolloutJsonlToHistory}=require('../dist/codex-native-history');
const turn=(id,uuid,text)=>({id,items:[{type:'userMessage',id:'item-'+id,clientId:uuid,content:[{type:'text',text}]}]});

test('rewind maps client ID to native turns, including repeated prompts and automatic turns',()=>{
 const thread={turns:[turn('1','u1','same'),turn('2','u2','same'),{id:'auto',items:[]},turn('3','u3','later')]};
 assert.deepEqual(codexRewindTarget(thread,{uuid:'u2',content:'same'}),{turnIndex:1,numTurns:3});
 assert.throws(()=>codexRewindTarget(thread,{uuid:'missing',content:'same'}),/uniquely/);
 thread.turns[1].items.push(turn('steer','u4','steer').items[0]);
 assert.throws(()=>codexRewindTarget(thread,{uuid:'u4',content:'steer'}),/first prompt/);
 assert.throws(()=>codexRewindTarget({...thread,status:{type:'active'}},{uuid:'u2',content:'same'}),/Stop/);
});

test('old imported prompts require an unambiguous native match',()=>{
 assert.deepEqual(codexRewindTarget({turns:[turn('1',null,'old')]},{uuid:'generated',content:'old'}),{turnIndex:0,numTurns:1});
 assert.throws(()=>codexRewindTarget({turns:[turn('1',null,'old'),turn('2',null,'old')]},{uuid:'generated',content:'old'}),/uniquely/);
});

test('rewind archives old history, commits local truncation after native success, and releases lock',async()=>{
 const sid='rewind-success';
 const native=[turn('1','u1','keep'),turn('2','u2','drop')];
 for(const [i,text] of ['keep','drop'].entries()) {
   appendHistory(sid,{role:'user',uuid:'u'+(i+1),content:text,timestamp:'2026-09-22T10:00:00Z'});
   appendHistory(sid,{role:'assistant',content:'response '+text,timestamp:'2026-09-22T10:00:01Z'});
 }
 let calls=0;
 const client={resumeThread:async()=>{},readThread:async()=>({thread:{turns:native}}),rollbackThread:async(id,n)=>{
   assert.equal(isCodexRewinding(sid),true); assert.equal(id,sid);assert.equal(n,1);calls++;
   return {thread:{turns:[native[0]]}};
 }};
 await rewindCodexConversation(client,sid,'/tmp','u2',true);
 assert.equal(calls,0);assert.equal(getHistory(sid).length,4);
 const result=await rewindCodexConversation(client,sid,'/tmp','u2');
 assert.equal(result.rewindIncludesTarget,true);assert.equal(result.messagesRemoved,2);
 assert.equal(getHistory(sid).length,2);assert.equal(isCodexRewinding(sid),false);
 const archived=await rememberSearchAllHistory({query:'drop',roles:['user']});
 assert.ok(archived.some(h=>h.archived&&h.sessionId===sid));
});

test('failed native rollback preserves local history and rejects simultaneous requests',async()=>{
 const sid='rewind-failure';appendHistory(sid,{role:'user',uuid:'u1',content:'keep me',timestamp:'2026-09-22T10:00:00Z'});
 let reject;
 const client={resumeThread:async()=>{},readThread:async()=>({thread:{turns:[turn('1','u1','keep me')]}}),rollbackThread:()=>new Promise((_,r)=>reject=r)};
 const pending=rewindCodexConversation(client,sid,'/tmp','u1');
 await new Promise(r=>setImmediate(r));
 await assert.rejects(rewindCodexConversation(client,sid,'/tmp','u1'),/already/);
 reject(new Error('RPC unavailable'));
 await assert.rejects(pending,/RPC unavailable/);
 assert.equal(getHistory(sid).length,1);assert.equal(isCodexRewinding(sid),false);
});

test('native rollout rollback markers do not reimport discarded turns on reconnect',()=>{
 const events=[];const add=(type,payload)=>events.push(JSON.stringify({type,payload,timestamp:'2026-09-22T10:00:00Z'}));
 for(const id of ['1','2','3']){
   add('event_msg',{type:'task_started',turn_id:id});
   add('event_msg',{type:'user_message',message:'prompt '+id});
   if(id==='2')add('event_msg',{type:'user_message',message:'steer in second turn'});
   add('response_item',{type:'message',role:'assistant',content:[{text:'answer '+id}]});
 }
 add('event_msg',{type:'thread_rolled_back',num_turns:2});
 add('event_msg',{type:'task_started',turn_id:'new'});
 add('event_msg',{type:'user_message',message:'new branch'});
 assert.deepEqual(codexRolloutJsonlToHistory(events.join('\n')).map(e=>e.content),['prompt 1','answer 1','new branch']);
});
