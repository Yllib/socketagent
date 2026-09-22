const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {TranscriptDatabase} = require('../dist/transcript-database');
const entry = (seq, content, role = 'user') => ({entryId:`e${seq}`, sessionSeq:seq, revision:2,
 role, uuid:`u${seq}`, content, timestamp:`2026-09-22T10:00:0${seq}Z`});
for (const disableFts of [false, true]) {
 test(`rewind deletes only the suffix and its search entries, FTS disabled=${disableFts}`, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rewind-db-'));
  const db=new TranscriptDatabase(path.join(dir,'history.sqlite'),{disableFts});
  const inspect=new DatabaseSync(db.filePath);
  try {
   const retained=entry(1,'retained');
   db.replace('session',[retained,entry(3,'discard'),entry(8,'discard response','assistant')].map(entry=>({entry,positionKey:entry.uuid})));
   db.replace('other',[entry(3,'discard other session')].map(entry=>({entry,positionKey:entry.uuid})));
   inspect.exec(`CREATE TRIGGER preserve_retained_delete BEFORE DELETE ON transcript_entries
     WHEN OLD.session_id='session' AND OLD.session_seq=1 BEGIN SELECT RAISE(ABORT,'retained row deleted'); END;
     CREATE TRIGGER preserve_retained_update BEFORE UPDATE ON transcript_entries
     WHEN OLD.session_id='session' AND OLD.session_seq=1 BEGIN SELECT RAISE(ABORT,'retained row updated'); END;`);
   assert.deepEqual(db.getUserByUuid('session','u3'),entry(3,'discard'));
   assert.equal(db.countFrom('session',3),2);
   assert.throws(()=>db.truncateFrom('session',3,'wrong-id'),/boundary changed/);
   assert.equal(db.count('session'),3);
   assert.equal(db.search('session',{query:'discard'}).length,2);
   assert.equal(db.truncateFrom('session',3,'e3'),2);
   assert.deepEqual(db.getAll('session'),[retained]);
   assert.equal(db.search('session',{query:'discard'}).length,0);
   assert.equal(db.search('session',{query:'retained'}).length,1);
   assert.equal(db.search('other',{query:'discard'}).length,1);
   const summary=db.summary('session');
   assert.equal(summary.entryCount,1);assert.equal(summary.userPromptCount,1);
   assert.equal(summary.latestConversationSeq,1);assert.equal(summary.messagePreview,'retained');
   inspect.exec('DROP TRIGGER preserve_retained_delete; DROP TRIGGER preserve_retained_update;');
   assert.equal(db.truncateFrom('session',1,'e1'),1);
   assert.equal(db.summary('session').entryCount,0);
   assert.equal(db.summary('session').userPromptCount,0);
   assert.equal(db.summary('session').messagePreview,undefined);
  } finally {inspect.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
}
test('streamed archive is a consistent snapshot while ordinary writes continue',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rewind-archive-'));
 const db=new TranscriptDatabase(path.join(dir,'history.sqlite'));
 try {
  const entries=[entry(1,'before'),entry(2,'x'.repeat(2*1024*1024),'tool_result'),entry(3,'世界')];
  db.replace('session',entries.map(entry=>({entry,positionKey:null})));
  const dest=path.join(dir,'backup.json');
  const backup=db.exportSessionJson('session',dest);
  db.upsert('session',entry(1,'after'),null);
  db.upsert('other',entry(1,'unrelated'),null);
  await backup;
  assert.deepEqual(JSON.parse(fs.readFileSync(dest,'utf8')),entries);
  assert.equal(db.getUserByUuid('session','u1').content,'after');
  assert.equal(fs.statSync(dest).mode & 0o777,0o600);
  const empty=path.join(dir,'empty.json');
  await db.exportSessionJson('absent',empty);
  assert.deepEqual(JSON.parse(fs.readFileSync(empty,'utf8')),[]);
 } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
