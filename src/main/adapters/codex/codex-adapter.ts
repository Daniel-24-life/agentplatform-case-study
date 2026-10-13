import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess, type ProcessResult } from "../../process/runner.js";
import { validateTaskSpec, type TaskSpec, type ReasoningLevel } from "../../../shared/core/task-spec.js";
import { validateWorkerResult, type WorkerResult } from "../../../shared/core/worker-result.js";
import { validateFinalGateResult, type FinalGateResult } from "../../../shared/core/final-gate.js";
import { AgentOutputError, AgentRunError, type AgentAdapter, type AgentExecution, type PlannerAgentAdapter, type ReviewerAgentAdapter, type WorkerAgentAdapter, type PlannerInput, type ReviewerInput, type WorkerInput } from "../agent-adapter.js";
import type { AgentUsage } from "../agent-adapter.js";
import { classifyFailureCode, classifyProcessResult } from "../../../shared/core/failure-taxonomy.js";
import { ERROR_CODES, type ErrorCode } from "../../../shared/core/errors.js";
import { resolveWindowsUserProxy } from "../../runtime/windows-user-proxy.js";

export type CodexRole="architect"|"builder"|"reviewer";
export type CodexCommandInput={role:CodexRole;cwd:string;model:string;reasoning?:ReasoningLevel;timeoutSeconds?:number;schemaPath:string;outputPath:string;prompt:string;hashOnlyLogs?:boolean;runId?:string;onSpawn?:(_pid:number|null)=>void;onOutput?:(_stream:"stdout"|"stderr",_atMs:number,_bytes:number)=>void};
const SUPPORTED_SCHEMA_KEYS=new Set(["type","properties","required","additionalProperties","items","enum","const","anyOf","$defs","$ref","description","pattern","format","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","minItems","maxItems"]);
const MAP_SCHEMA_KEYS=new Set(["properties","$defs"]);
const projectSchemaValue=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(projectSchemaValue);
  if(!value||typeof value!=="object")return value;
  const source=value as Record<string,unknown>;
  const output:Record<string,unknown>={};
  for(const [key,entry] of Object.entries(source)){
    if(!SUPPORTED_SCHEMA_KEYS.has(key))continue;
    if(MAP_SCHEMA_KEYS.has(key)&&entry&&typeof entry==="object"&&!Array.isArray(entry)){
      const map:Record<string,unknown>={};
      for(const [name,schema] of Object.entries(entry as Record<string,unknown>))map[name]=projectSchemaValue(schema);
      output[key]=map;
    }else output[key]=projectSchemaValue(entry);
  }
  return output;
};
/** Project the authoritative schema into the strict subset accepted by Codex Structured Outputs. */
export const writeCodexOutputSchema=(schemaPath:string,outputPath:string):string=>{
  const schema=JSON.parse(readFileSync(schemaPath,"utf8")) as unknown;
  const projected=projectSchemaValue(schema);
  const derivedPath=path.join(path.dirname(outputPath),"codex-output-schema.json");
  mkdirSync(path.dirname(derivedPath),{recursive:true});
  writeFileSync(derivedPath,`${JSON.stringify(projected,null,2)}\n`,`utf8`);
  return derivedPath;
};
export const buildCodexArgs=(input:CodexCommandInput):string[]=>[
  "--ask-for-approval","never","--disable","multi_agent","exec","--ephemeral","--ignore-rules","-c","agents.enabled=false","-C",input.cwd,"-m",input.model,
  ...(input.reasoning?["-c",`model_reasoning_effort="${input.reasoning}"`]:[]),
  "--sandbox",input.role==="builder"?"workspace-write":"read-only",
  "--json","--output-schema",writeCodexOutputSchema(input.schemaPath,input.outputPath),
  "--output-last-message",input.outputPath,input.prompt
];

/**
 * Reads only explicit Codex JSONL usage events. Codex emits cumulative usage on
 * turn completion, so the last valid explicit usage event is the single-run
 * total; arbitrary nested numbers are intentionally never inspected.
 */
export const parseCodexUsage=(stdout:string):AgentUsage|null=>{
  let latest:AgentUsage|null=null;
  for(const line of stdout.split(/\r?\n/)){
    if(!line.trim())continue;
    let event:unknown;
    try{event=JSON.parse(line) as unknown;}catch{continue;}
    if(!event||typeof event!=="object"||Array.isArray(event))continue;
    const record=event as Record<string,unknown>;
    const type=record.type;
    if(type!=="turn.completed"&&type!=="response.completed"&&type!=="usage")continue;
    const raw=record.usage;
    if(!raw||typeof raw!=="object"||Array.isArray(raw))continue;
    const values=raw as Record<string,unknown>;
    const read=(key:string):number|null=>{
      const value=values[key];
      return value===undefined||value===null?null:typeof value==="number"&&Number.isFinite(value)&&Number.isInteger(value)&&value>=0?value:null;
    };
    const usage={inputTokens:read("input_tokens"),outputTokens:read("output_tokens"),totalTokens:read("total_tokens"),cachedInputTokens:read("cached_input_tokens")};
    if(Object.values(usage).some(value=>value!==null))latest=usage;
  }
  return latest;
};

export class CodexRunError extends AgentRunError {
  constructor(result:ProcessResult){
    const tail=(value:string):string=>value.length<=4096?value:value.slice(-4096);
    const details=[result.stderr?`stderr: ${tail(result.stderr)}`:"",result.stdout?`stdout: ${tail(result.stdout)}`:""].filter(Boolean).join("\n");
    const classification=classifyProcessResult(result) ?? {code:"MODEL_RUNTIME_FAILED",domain:"runtime",retryable:true,failFast:false,diagnosticSummary:"The model process failed"};
    super(details?`${result.status}\n${details}`:result.status,result,classification);
    this.name="CodexRunError";
  }
}

/** A successful process whose structured output could not be read or validated. */
export class CodexOutputError extends AgentOutputError {
  readonly code: ErrorCode = ERROR_CODES.OUTPUT_SCHEMA_INVALID;
  constructor(result:ProcessResult,cause:unknown){
    const detail=cause instanceof Error?cause.message:String(cause);
    super(`OUTPUT_SCHEMA_INVALID${detail?`: ${detail}`:""}`,result,classifyFailureCode(ERROR_CODES.OUTPUT_SCHEMA_INVALID),{cause});
    this.name="CodexOutputError";
  }
}

export class CodexAdapter implements AgentAdapter, PlannerAgentAdapter, WorkerAgentAdapter, ReviewerAgentAdapter {
  readonly id = "codex";
  private readonly program:string;private readonly prefixArgs:string[]; private readonly proxyResolver:()=>Record<string,string>;
  constructor(program="codex",prefixArgs:string[]=[], proxyResolver:()=>Record<string,string> = ()=>resolveWindowsUserProxy().env){this.program=program;this.prefixArgs=prefixArgs;this.proxyResolver=proxyResolver;}
  private async run(input:CodexCommandInput):Promise<ProcessResult>{return runProcess({program:this.program,args:[...this.prefixArgs,...buildCodexArgs(input)],cwd:input.cwd,timeoutSeconds:input.timeoutSeconds??3600,logDir:path.dirname(input.outputPath),hashOnlyLogs:input.hashOnlyLogs,runId:input.runId,onSpawn:input.onSpawn,env:this.proxyResolver()});}
  private async successfulRun(input:CodexCommandInput):Promise<ProcessResult>{const run=await this.run(input);if(run.status!=="SUCCEEDED")throw new CodexRunError(run);return run;}
  async architect(input:CodexCommandInput):Promise<TaskSpec>{const process=await this.successfulRun({...input,role:"architect"});try{return this.readTaskSpec(input.outputPath);}catch(cause){throw new CodexOutputError(process,cause);}}
  async builder(input:CodexCommandInput,taskId:string):Promise<WorkerResult>{const process=await this.successfulRun({...input,role:"builder"});try{return this.readWorkerResult(input.outputPath,taskId);}catch(cause){throw new CodexOutputError(process,cause);}}
  async reviewer(input:CodexCommandInput,context:Parameters<typeof validateFinalGateResult>[1]):Promise<FinalGateResult>{const process=await this.successfulRun({...input,role:"reviewer"});try{return this.readReviewerResult(input.outputPath,context);}catch(cause){throw new CodexOutputError(process,cause);}}
  async runPlanner(input:PlannerInput):Promise<AgentExecution<TaskSpec>>{const process=await this.successfulRun({...input,role:"architect"});try{return {output:this.readTaskSpec(input.outputPath),process,usage:parseCodexUsage(process.stdout)};}catch(cause){throw new CodexOutputError(process,cause);}}
  async runWorker(input:WorkerInput):Promise<AgentExecution<WorkerResult>>{const process=await this.successfulRun({...input,role:"builder"});try{return {output:this.readWorkerResult(input.outputPath,input.taskId),process,usage:parseCodexUsage(process.stdout)};}catch(cause){throw new CodexOutputError(process,cause);}}
  async runReviewer(input:ReviewerInput):Promise<AgentExecution<FinalGateResult>>{const process=await this.successfulRun({...input,role:"reviewer"});try{return {output:this.readReviewerResult(input.outputPath,input.context),process,usage:parseCodexUsage(process.stdout)};}catch(cause){throw new CodexOutputError(process,cause);}}
  private readTaskSpec(outputPath:string):TaskSpec{const checked=validateTaskSpec(JSON.parse(readFileSync(outputPath,"utf8")) as unknown);if(!checked.valid)throw new Error(`OUTPUT_SCHEMA_INVALID: ${checked.issues.map(i=>i.path).join(",")}`);return checked.value;}
  private readWorkerResult(outputPath:string,taskId:string):WorkerResult{const checked=validateWorkerResult(JSON.parse(readFileSync(outputPath,"utf8")),{taskId});if(!checked.valid)throw new Error("OUTPUT_SCHEMA_INVALID");return checked.value;}
  private readReviewerResult(outputPath:string,context:Parameters<typeof validateFinalGateResult>[1]):FinalGateResult{const checked=validateFinalGateResult(JSON.parse(readFileSync(outputPath,"utf8")),context);if(!checked.valid)throw new Error("OUTPUT_SCHEMA_INVALID");return checked.value;}
}
