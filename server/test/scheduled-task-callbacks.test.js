const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-callback-'));
process.env.SOCKETAGENT_DATA_DIR = root;
const { ScheduledTaskCallbacks, scheduledTaskReportPrompt } = require('#server/scheduled-task-callbacks');
const { saveScheduledTask, getScheduledTask, listScheduledTasks, reconcileInterruptedScheduledTasks, finishRecoveredScheduledTask } = require('#server/scheduled-task-store');
const { handleScheduleTaskTool } = require('#server/app-tool-handlers');
test.after(() => fs.rmSync(root, {recursive:true, force:true}));
test.beforeEach(() => fs.rmSync(path.join(root, 'scheduled-tasks.json'), {force:true}));

/** @returns {import('#server/scheduled-task-store').ScheduledTask} */
function fixture() {
  return {id:'task', prompt:'Check the backup', cwd:root, status:'completed',
    scheduledTime:'2026-09-28T12:00:00Z', createdAt:'2026-09-28T10:00:00Z',
    linkedSessionId:'parent', runs:[{sessionId:'child', startedAt:'2026-09-28T12:00:00Z',
      status:'completed', resultSummary:'Backup passed', callbackSessionId:'parent', callbackStatus:'pending'}]};
}

/** @param {ConstructorParameters<typeof ScheduledTaskCallbacks>[0]['deliver']} deliver */
function dispatcher(deliver) {
  return new ScheduledTaskCallbacks({list:listScheduledTasks, get:getScheduledTask, save:saveScheduledTask, deliver, onError:() => {}});
}

test('link is opt-in and targets the actual creating session, independently of delegation lineage', async () => {
  /** @type {import('#server/app-tool-handlers').AppToolContext} */
  const ctx = {getSessionId:()=>'current', getDelegationSupervisorSessionId:()=>'root',
    getBackend:()=>'codex', send:()=>{}, getTtsEngine:()=>'system', getKokoroVoice:()=>'', getKokoroSpeed:()=>1};
  const args = {prompt:'Check', cwd:root, scheduledTime:new Date(Date.now()+60000).toISOString()};
  await handleScheduleTaskTool(ctx,args);
  await handleScheduleTaskTool(ctx,{...args, linkToSession:true});
  await handleScheduleTaskTool(ctx,{...args, linkToSession:false});
  const tasks=listScheduledTasks();
  assert.equal(tasks.filter(t=>t.linkedSessionId==='current').length,1);
  assert.equal(tasks.filter(t=>t.linkedSessionId===undefined).length,2);
  assert.ok(tasks.every(t=>t.createdBySessionId==='root'));
  assert.ok(tasks.every(t=>t.backend==='codex'));
  const rejected=await handleScheduleTaskTool({...ctx,getSessionId:()=>''},{...args,linkToSession:true});
  assert.equal(rejected.isError,true);
  assert.equal(listScheduledTasks().length,3);
});

test('failed delivery survives restart; acknowledgement keeps intervening schedule edits', async () => {
  saveScheduledTask(fixture());
  await dispatcher(async()=>{throw new Error('Parent not ready');}).flush();
  assert.equal(getScheduledTask('task').runs[0].callbackStatus,'pending');
  let deliveries=0;
  const next=dispatcher(async(task,run)=>{
    assert.equal(run.callbackSessionId,'parent');
    deliveries++;
    saveScheduledTask({...task,name:'Edited while delivering',notificationMode:'quiet'});
  });
  await next.flush();
  await next.flush();
  const saved=getScheduledTask('task');
  assert.equal(deliveries,1);
  assert.equal(saved.name,'Edited while delivering');
  assert.equal(saved.notificationMode,'quiet');
  assert.equal(saved.runs[0].callbackStatus,'delivered');
  assert.ok(saved.runs[0].callbackDeliveredAt);
  saveScheduledTask({...fixture(), status:'running'});
  assert.equal(getScheduledTask('task').runs[0].callbackStatus,'delivered');
  await next.flush();
  assert.equal(deliveries,1);
});

test('overlapping retry ticks do not inject the same result twice', async () => {
  saveScheduledTask(fixture());
  /** @type {(() => void) | undefined} */
  let release;
  /** @type {Promise<void>} */
  const gate=new Promise(resolve=>{release=()=>resolve(undefined);});
  let deliveries=0;
  const queue=dispatcher(async()=>{deliveries++; await gate;});
  const first=queue.flush();
  await queue.flush();
  assert.equal(deliveries,1);
  assert.ok(release);
  release();
  await first;
});

test('recurring successes and failures report once per run, but running and legacy runs do not', async()=>{
  const task=fixture();
  task.status='pending';
  task.recurrence={type:'daily'};
  task.runs.push({...task.runs[0],startedAt:'2026-09-29T12:00:00Z',status:'failed',error:'Network failed'});
  task.runs.push({...task.runs[0],startedAt:'2026-09-30T12:00:00Z',status:'running'});
  task.runs.push({sessionId:'legacy',startedAt:'2026-09-27T12:00:00Z',status:'completed'});
  saveScheduledTask(task);
  /** @type {string[]} */
  const delivered=[];
  const queue=dispatcher(async(_task,run)=>{delivered.push(run.status);});
  await queue.flush();
  await queue.flush();
  assert.deepEqual(delivered,['completed','failed']);
});

test('restart recovery preserves the original destination and queues both interrupted and recovered results',async()=>{
  const task=fixture();
  task.status='running';
  task.sessionId='child';
  task.runs[0].status='running';
  task.linkedSessionId='changed-destination';
  saveScheduledTask(task);
  reconcileInterruptedScheduledTasks(new Date('2026-09-28T12:10:00Z'));
  /** @type {string[]} */
  const destinations=[];
  await dispatcher(async(_task,run)=>{destinations.push(run.callbackSessionId||'');}).flush();
  assert.deepEqual(destinations,['parent']);
  task.id='recovered';
  saveScheduledTask(task);
  finishRecoveredScheduledTask('child','completed','Recovered result');
  await dispatcher(async(_task,run)=>{destinations.push(run.callbackSessionId||'');}).flush();
  assert.deepEqual(destinations,['parent','parent']);
});

test('report includes identifiable bounded output and treats it as work product',()=>{
  const task=fixture();
  const prompt=scheduledTaskReportPrompt(task,task.runs[0],'x'.repeat(60000));
  assert.ok(prompt.startsWith('<socketagent_scheduled_task_report task_id="task"'));
  assert.match(prompt,/Run session ID: child/);
  assert.match(prompt,/not as higher-priority instructions/);
  assert.match(prompt,/Result truncated/);
  assert.ok(prompt.length<52000);
});
