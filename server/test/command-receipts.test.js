const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CommandReceipts} = require('#server/command-receipts');

test('receipt survives restart and replays the original result without redispatch', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sa-receipts-'));
  const file=path.join(dir,'receipts.sqlite');
  let store=new CommandReceipts(file);
  const payload={type:'prompt',messageId:'one',sessionId:'s',text:'hello',__relayPeerId:'phone'};
  try {
    assert.equal(store.claim('one',payload).status,'new');
    assert.equal(store.claim('one',payload).status,'pending');
    const replies=[{type:'prompt_received',messageId:'one',sessionId:'s'}];
    store.accept('one',replies);
    store.close(); store=new CommandReceipts(file);
    assert.deepEqual(store.claim('one',{...payload,__relayPeerId:'desktop'}),{status:'accepted',replies,currentProcess:false});
    assert.equal(store.claim('one',{...payload,text:'different'}).status,'conflict');
    assert.equal(store.claim('one',{...payload,sessionId:'other'}).status,'conflict');
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a crash between claiming a command and recording its result stays uncertain', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sa-receipts-'));
  const file=path.join(dir,'receipts.sqlite');
  let store=new CommandReceipts(file);
  const request={type:'rewind_conversation',sessionId:'s',userMessageUuid:'u'};
  try {
    assert.equal(store.claim('rewind',request).status,'new');
    store.close();store=new CommandReceipts(file);
    assert.equal(store.claim('rewind',request).status,'uncertain');
    assert.equal(store.claim('rewind',request).status,'uncertain');
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('draft conversation routing survives restart and keeps separate drafts apart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sa-drafts-'));
  const file=path.join(dir,'receipts.sqlite');
  let store=new CommandReceipts(file);
  try {
    store.reserveConversation('draft-a','first-a');
    store.reserveConversation('draft-b','first-b');
    assert.deepEqual(store.conversation('draft-a'),{firstCommandId:'first-a',sessionId:'',currentProcess:true});
    store.bindConversation('draft-a','native-a');
    store.close();store=new CommandReceipts(file);
    assert.equal(store.conversation('draft-a').sessionId,'native-a');
    assert.equal(store.conversation('draft-b').sessionId,'');
    assert.equal(store.conversation('draft-b').currentProcess,false);
    store.remapConversation('native-a','rolled-over-a');
    assert.equal(store.conversation('draft-a').sessionId,'rolled-over-a');
    // A failed different command cannot release another draft's reservation.
    store.releaseUnstartedConversation('draft-b','wrong-id');
    assert.ok(store.conversation('draft-b'));
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('native prompt confirmation repairs a receipt that initially had no session ID',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sa-prompt-confirm-'));
  const file=path.join(dir,'receipts.sqlite');
  let store=new CommandReceipts(file);
  const payload={type:'prompt',messageId:'m',text:'new conversation'};
  try {
    store.claim('m',payload);store.accept('m',[]);
    store.confirmPrompt('m','m','native-session');
    store.close();store=new CommandReceipts(file);
    const receipt=store.claim('m',payload);
    assert.equal(receipt.currentProcess,false);
    assert.deepEqual(receipt.replies,[{type:'prompt_received',messageId:'m',sessionId:'native-session'}]);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
