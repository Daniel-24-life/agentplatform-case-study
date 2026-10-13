import { createHash } from "node:crypto";
import type { TaskSpec } from "../../shared/core/task-spec.js";
import { isPathAllowedInScope } from "../../shared/core/paths.js";
import type { TestRun } from "../testing/test-runner.js";

export type GateInput={spec:TaskSpec;baseSha:string;changedFiles:string[];invalidPaths?:string[];diff:string;tests:TestRun[];workerValid:boolean;workerDiagnostics?:string[];artifacts:Array<{content:Buffer|string;sha256:string}>};
export type DeterministicGate={passed:boolean;failures:string[]};
export const runDeterministicGate=(input:GateInput):DeterministicGate=>{
  const failures:string[]=[];
  if(input.baseSha!==input.spec.base_sha)failures.push("BASE_SHA_CHANGED");
  for(const file of input.changedFiles)if(!isPathAllowedInScope(file,input.spec.scope).match)failures.push(`SCOPE_VIOLATION:${file}`);
  for(const file of input.invalidPaths??[])failures.push(`UNSAFE_GIT_PATH:${file}`);
  if(input.changedFiles.length>input.spec.limits.max_changed_files)failures.push("MAX_CHANGED_FILES");
  if(Buffer.byteLength(input.diff)>input.spec.limits.max_diff_bytes)failures.push("MAX_DIFF_BYTES");

  const approved=new Map(input.spec.test_commands.map(command=>[command.id,command]));
  const seen=new Set<string>();
  for(const test of input.tests){
    const command=approved.get(test.id);
    if(!command||seen.has(test.id)||test.required!==command.required){failures.push("TEST_FAILED");continue;}
    seen.add(test.id);
    if(command.required&&test.result.status!=="SUCCEEDED")failures.push("TEST_FAILED");
  }
  if(input.spec.test_commands.some(command=>command.required&&!seen.has(command.id)))failures.push("TEST_FAILED");

  if(!input.workerValid)failures.push("OUTPUT_SCHEMA_INVALID");
  for(const diagnostic of input.workerDiagnostics??[])failures.push(diagnostic);
  for(const artifact of input.artifacts)if(createHash("sha256").update(artifact.content).digest("hex")!==artifact.sha256)failures.push("EVIDENCE_CORRUPT");
  return{passed:failures.length===0,failures:[...new Set(failures)]};
};
