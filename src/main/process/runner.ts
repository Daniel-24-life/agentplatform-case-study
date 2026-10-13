import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProcessSpec={program:string;args:string[];cwd:string;timeoutSeconds:number;logDir?:string;hashOnlyLogs?:boolean;env?:Record<string,string>;maxSummaryBytes?:number;signal?:AbortSignal;runId?:string;onSpawn?:(_pid:number|null)=>void;onOutput?:(_stream:"stdout"|"stderr",_atMs:number,_bytes:number)=>void};
export type ProcessTerminationDiagnostic={requested:"TIMEOUT"|"CANCELLED";forceIssued:boolean;directKillAttempts:number;directKillSucceeded:number;taskkill:Array<{force:boolean;outcome:"PENDING"|"EXITED"|"ERROR"|"TIMEOUT"|"SPAWN_FAILED";exitCode?:number|null;detail?:string;requestedAtMs?:number;completedAtMs?:number}>;settledWithoutClose:boolean};
export type ProcessResult={exitCode:number|null;status:"SUCCEEDED"|"FAILED"|"TIMED_OUT"|"CANCELLED"|"START_FAILED";stdout:string;stderr:string;stdoutSha256:string;stderrSha256:string;durationMs:number;pid?:number|null;termination?:ProcessTerminationDiagnostic;startedAtMs?:number;endedAtMs?:number;closeObserved?:boolean;stdoutClosed?:boolean;stderrClosed?:boolean;stdoutDestroyed?:boolean;stderrDestroyed?:boolean};

export const minimalEnvironment=(extra:Record<string,string>={}):Record<string,string|undefined>=>{
  const keep=["PATH","Path","PATHEXT","SystemRoot","WINDIR","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE","COMSPEC","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"];
  const env:Record<string,string|undefined>={}; for(const key of keep) if(process.env[key]) env[key]=process.env[key];
  return {...env,...extra};
};

const activeProcesses=new Map<string,AbortController>();
export const cancelActiveProcess=(runId:string):boolean=>{const controller=activeProcesses.get(runId);if(!controller)return false;controller.abort();return true;};
export const cancelAllActiveProcesses=():number=>{const count=activeProcesses.size;for(const controller of activeProcesses.values())controller.abort();return count;};

const TERMINATION_GRACE_MS=1500;
const FORCE_SETTLE_GRACE_MS=500;
const TASKKILL_RESULT_TIMEOUT_MS=250;

type TaskkillOutcome={outcome:"EXITED"|"ERROR"|"TIMEOUT"|"SPAWN_FAILED";exitCode?:number|null;detail?:string};
type TerminationAttempt={taskkill?:Promise<TaskkillOutcome>;directKill?:()=>boolean};

const runTaskkill=(pid:number,force:boolean):Promise<TaskkillOutcome>=>new Promise((resolve)=>{
  let command:ChildProcess|undefined;
  let done=false;
  const settle=(outcome:TaskkillOutcome):void=>{if(done)return;done=true;clearTimeout(timer);resolve(outcome);};
  const timer=setTimeout(()=>{try{command?.kill();}catch{/* best effort */}settle({outcome:"TIMEOUT",detail:`taskkill exceeded ${TASKKILL_RESULT_TIMEOUT_MS}ms`});},TASKKILL_RESULT_TIMEOUT_MS);
  try{
    command=spawn("taskkill",["/PID",String(pid),"/T",...(force?["/F"]:[])],{shell:false,windowsHide:true,stdio:"ignore"});
    command.once("error",(error)=>settle({outcome:"ERROR",detail:error instanceof Error?error.message:String(error)}));
    command.once("close",(code,signal)=>settle({outcome:"EXITED",exitCode:code,detail:signal?`signal ${signal}`:undefined}));
  }catch(error){settle({outcome:"SPAWN_FAILED",detail:error instanceof Error?error.message:String(error)});}
});

const terminateProcessTree=(child:ChildProcess,force=false):TerminationAttempt=>{
  if(!child.pid)return {};
  if(process.platform==="win32"){
    const taskkill=runTaskkill(child.pid,force);
    return {taskkill,directKill:()=>{try{return child.kill();}catch{return false;}}};
  }
  return {directKill:()=>{try{return child.kill(force?"SIGKILL":"SIGTERM");}catch{return false;}}};
};

export const runProcess=(spec:ProcessSpec):Promise<ProcessResult>=>new Promise((resolve)=>{
  const controller=new AbortController();const activeKey=spec.runId??randomUUID();if(activeProcesses.has(activeKey)){resolve({exitCode:null,status:"START_FAILED",stdout:"",stderr:"run id already active",stdoutSha256:createHash("sha256").digest("hex"),stderrSha256:createHash("sha256").update("run id already active").digest("hex"),durationMs:0,pid:null});return;}activeProcesses.set(activeKey,controller);if(spec.signal?.aborted)controller.abort();else spec.signal?.addEventListener("abort",()=>controller.abort(),{once:true});
  const started=Date.now(); const limit=spec.maxSummaryBytes??65536; let stdout="";let stderr="";let settled=false;let finishing=false;let timedOut=false;let cancelled=false;let closeObserved=false;let stdoutClosed=false;let stderrClosed=false;let stdoutDestroyed=false;let stderrDestroyed=false;let timer:ReturnType<typeof setTimeout>|undefined;let forceTimer:ReturnType<typeof setTimeout>|undefined;let settleTimer:ReturnType<typeof setTimeout>|undefined;
  const outHash=createHash("sha256");const errHash=createHash("sha256");
  let terminationInfo:ProcessTerminationDiagnostic|undefined;
  const pendingTerminations:Promise<TaskkillOutcome>[]=[];
  if(spec.logDir){mkdirSync(spec.logDir,{recursive:true});if(!spec.hashOnlyLogs)for(const stream of ["stdout","stderr"]){const file=path.join(spec.logDir,`${stream}.log`);if(!existsSync(file))writeFileSync(file,"");}}
  let onAbort=():void=>{};
const finish=(exitCode:number|null,status:ProcessResult["status"],pid:number|null,settledWithoutClose=false):void=>{if(settled||finishing)return;finishing=true;if(timer)clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);if(settleTimer)clearTimeout(settleTimer);const waitForTermination=pendingTerminations.length===0?Promise.resolve():Promise.race([Promise.allSettled(pendingTerminations),new Promise<void>((resolveWait)=>setTimeout(resolveWait,TASKKILL_RESULT_TIMEOUT_MS))]);void waitForTermination.then(()=>{if(settled)return;settled=true;controller.signal.removeEventListener("abort",onAbort);activeProcesses.delete(activeKey);if(terminationInfo)terminationInfo.settledWithoutClose=settledWithoutClose;resolve({exitCode,status,stdout,stderr,stdoutSha256:outHash.digest("hex"),stderrSha256:errHash.digest("hex"),durationMs:Date.now()-started,pid,termination:terminationInfo,startedAtMs:started,endedAtMs:Date.now(),closeObserved,stdoutClosed,stderrClosed,stdoutDestroyed,stderrDestroyed});});};
  let child:ChildProcessWithoutNullStreams;
  try{child=spawn(spec.program,spec.args,{cwd:spec.cwd,shell:false,windowsHide:true,env:minimalEnvironment(spec.env),stdio:["pipe","pipe","pipe"]});child.stdin.end();}catch(error){stderr=error instanceof Error?error.message:String(error);errHash.update(stderr);try{spec.onSpawn?.(null);}catch{/* persistence callback must not mask spawn failure */}finish(null,"START_FAILED",null);return;}
  try{spec.onSpawn?.(child.pid??null);}catch(error){stderr=error instanceof Error?error.message:String(error);errHash.update(stderr);terminateProcessTree(child,true);finish(null,"START_FAILED",child.pid??null);return;}
  const capture=(kind:"stdout"|"stderr",chunk:Buffer)=>{const text=chunk.toString("utf8");(kind==="stdout"?outHash:errHash).update(chunk);if(kind==="stdout")stdout=(stdout+text).slice(-limit);else stderr=(stderr+text).slice(-limit);if(spec.logDir&&!spec.hashOnlyLogs)appendFileSync(path.join(spec.logDir,`${kind}.log`),chunk);try{spec.onOutput?.(kind,Date.now(),chunk.byteLength);}catch{/* diagnostics callback must not alter process outcome */}};
  child.stdout.on("data",(c:Buffer)=>capture("stdout",c));child.stderr.on("data",(c:Buffer)=>capture("stderr",c));
  child.stdout.once("close",()=>{stdoutClosed=true;});child.stderr.once("close",()=>{stderrClosed=true;});
  child.on("error",(e)=>{stderr+=e.message;errHash.update(e.message);finish(null,"START_FAILED",child.pid??null);});
  child.on("close",(code)=>{closeObserved=true;finish(code,cancelled?"CANCELLED":timedOut?"TIMED_OUT":code===0?"SUCCEEDED":"FAILED",child.pid??null);});
  const stop=(request:"TIMEOUT"|"CANCELLED"):void=>{if(terminationInfo)return;terminationInfo={requested:request,forceIssued:false,directKillAttempts:0,directKillSucceeded:0,taskkill:[],settledWithoutClose:false};const recordAttempt=(attempt:TerminationAttempt,force:boolean):void=>{const fallback=():void=>{if(!attempt.directKill)return;terminationInfo!.directKillAttempts++;if(attempt.directKill())terminationInfo!.directKillSucceeded++;};if(!attempt.taskkill){fallback();return;}const record:ProcessTerminationDiagnostic["taskkill"][number]={force,outcome:"PENDING",requestedAtMs:Date.now()};terminationInfo!.taskkill.push(record);const pending=attempt.taskkill.then((result)=>{record.outcome=result.outcome;record.exitCode=result.exitCode;record.detail=result.detail;record.completedAtMs=Date.now();if(result.outcome!=="EXITED"||result.exitCode!==0)fallback();return result;});pendingTerminations.push(pending);};recordAttempt(terminateProcessTree(child),false);forceTimer=setTimeout(()=>{if(settled||finishing)return;terminationInfo!.forceIssued=true;recordAttempt(terminateProcessTree(child,true),true);settleTimer=setTimeout(()=>{if(!settled&&!finishing){try{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();stdoutDestroyed=true;stderrDestroyed=true;}catch{/* best effort */}finish(null,cancelled?"CANCELLED":"TIMED_OUT",child.pid??null,true);}},FORCE_SETTLE_GRACE_MS);},TERMINATION_GRACE_MS);}; onAbort=()=>{cancelled=true;stop("CANCELLED");}; controller.signal.addEventListener("abort",onAbort,{once:true});if(controller.signal.aborted)onAbort();
  timer=setTimeout(()=>{timedOut=true;stop("TIMEOUT");},Math.max(1,spec.timeoutSeconds)*1000);
});
