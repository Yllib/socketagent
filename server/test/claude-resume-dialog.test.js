const test=require('node:test');
const assert=require('node:assert/strict');
const {handleClaudeResumeDialog,resumeQuestion}=require('#server/claude-resume-dialog');
const request={dialogKind:'resume_return',payload:{}};
test('resume blocks until an explicit supported choice and returns the native result',async()=>{
  /** @type {(value:Record<string,string> | null)=>void} */
  let answer = () => {throw new Error("Question not ready");};
  const signal=new AbortController().signal;
  let finished=false;
  const waiting=handleClaudeResumeDialog(request,signal,()=>new Promise(resolve=>{answer=resolve})).then(result=>{finished=true;return result});
  await Promise.resolve();assert.equal(finished,false);
  answer({[resumeQuestion.question]:'Compact and continue'});
  assert.deepEqual(await waiting,{behavior:'completed',result:'compact'});
  assert.deepEqual(await handleClaudeResumeDialog(request,signal,async()=>({[resumeQuestion.question]:'Keep full context'})),{behavior:'completed',result:'continue'});
});
test('custom text does not silently compact; abort never becomes a continue choice',async()=>{
  let calls=0;
  const controller=new AbortController();
  const result=await handleClaudeResumeDialog(request,controller.signal,async()=>{
    calls++;
    if(calls===1)return {[resumeQuestion.question]:'something else'};
    controller.abort();return null;
  });
  assert.equal(calls,2);assert.deepEqual(result,{behavior:'cancelled'});
  assert.equal(await handleClaudeResumeDialog({dialogKind:'unknown',payload:{}},controller.signal,async()=>{throw Error('must not ask')}),null);
});

test('resume choice persists even when the native session init has not arrived yet',async()=>{
  require('./test-data-dir');
  const {ClaudeSession}=require('#server/claude-session');
  const {appendHistory,getHistory}=require('#server/session-store');
  const sid='resume-before-native-init';
  const session=new ClaudeSession({readyState:1,send(){}},process.cwd(),[]);
  const message={type:'question',questionId:'resume_context_early',sessionId:sid,questions:[resumeQuestion]};
  appendHistory(sid,{role:'question',content:'',questionId:message.questionId,questions:message.questions,timestamp:new Date().toISOString()});
  const waiting=session._waitForQuestion(message.questionId,message,new AbortController().signal);
  assert.equal(session.resolveQuestion(message.questionId,{[resumeQuestion.question]:'Keep full context'}),true);
  assert.deepEqual(await waiting,{[resumeQuestion.question]:'Keep full context'});
  assert.equal(getHistory(sid)[0].answered,true);
});
