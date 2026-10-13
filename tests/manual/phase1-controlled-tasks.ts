import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

export type ControlledTask = { id: string; file: string; source: string; verification: string; goal: string; criteria: string[]; files?: Array<{ file: string; source: string }> };
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export const controlledTasks: ControlledTask[] = [
  { id: "STRING_NORMALIZE", file: "src/normalize-lines.mjs", goal: "Implement normalizeLines(input) in src/normalize-lines.mjs.", criteria: ["Exports normalizeLines.", "Accepts only strings and throws TypeError otherwise.", "Trims each line, removes empty lines, preserves order, and joins retained lines with newline."], source: "export function normalizeLines(input) { throw new Error('TODO'); }\n", verification: `import assert from 'node:assert/strict'; import { normalizeLines } from './src/normalize-lines.mjs'; assert.equal(normalizeLines(' a \\n\\n b \\n  c '), 'a\\nb\\nc'); assert.equal(normalizeLines(' \\n '), ''); assert.throws(() => normalizeLines(null), TypeError);\n` },
  { id: "RETRY_POLICY", file: "src/retry-policy.mjs", goal: "Implement planRetries(input) in src/retry-policy.mjs.", criteria: ["Exports planRetries.", "Rejects non-finite, non-integer, negative values and maxAttempts below attempts with RangeError.", "Returns remaining retries and exponentially increasing delays capped at maxDelayMs; equal attempts returns no delays."], source: "export function planRetries(input) { throw new Error('TODO'); }\n", verification: `import assert from 'node:assert/strict'; import { planRetries } from './src/retry-policy.mjs'; assert.deepEqual(planRetries({attempts:1,maxAttempts:4,baseDelayMs:10,maxDelayMs:25}), {remaining:3,delays:[10,20,25]}); assert.deepEqual(planRetries({attempts:2,maxAttempts:2,baseDelayMs:1,maxDelayMs:1}), {remaining:0,delays:[]}); for (const key of ['attempts','maxAttempts','baseDelayMs','maxDelayMs']) { const value={attempts:1,maxAttempts:2,baseDelayMs:1,maxDelayMs:2}; value[key]= key === 'maxAttempts' ? 0 : -1; assert.throws(() => planRetries(value), RangeError); } assert.throws(() => planRetries({attempts:1.5,maxAttempts:2,baseDelayMs:1,maxDelayMs:2}), RangeError); assert.throws(() => planRetries({attempts:1,maxAttempts:2,baseDelayMs:Infinity,maxDelayMs:2}), RangeError);\n` },
  { id: "PATH_REPORT", file: "src/flatten-tree.mjs", goal: "Implement flattenTree(nodes) in src/flatten-tree.mjs.", criteria: ["Exports flattenTree.", "Returns DFS file paths across multiple roots using slash separators; empty directories produce no file path.", "Rejects malformed fields, file children, and duplicate output paths with Error."], source: "export function flattenTree(nodes) { throw new Error('TODO'); }\n", verification: `import assert from 'node:assert/strict'; import { flattenTree } from './src/flatten-tree.mjs'; const tree=[{name:'a',type:'dir',children:[{name:'x',type:'file'},{name:'e',type:'dir',children:[]}]},{name:'b',type:'file'}]; assert.deepEqual(flattenTree(tree), ['a/x','b']); assert.throws(() => flattenTree([{name:'x',type:'file',children:[]}]), Error); assert.throws(() => flattenTree([{name:'x',type:'wat'}]), Error); assert.throws(() => flattenTree([{name:'x',type:'file'},{name:'x',type:'file'}]), Error);\n` }
];

export const hashText = sha256;
export const taskSpecFor = (task: ControlledTask, baseSha: string): TaskSpec => ({
  schema_version: "2.0", task_id: task.id, title: task.id, goal: task.goal, base_sha: baseSha,
  context_paths: [task.file, ...(task.files?.map((entry) => entry.file) ?? []), "verify.mjs"], scope: { allowed_paths: [task.file, ...(task.files?.map((entry) => entry.file) ?? [])], forbidden_paths: ["verify.mjs", "package.json"] },
  acceptance_criteria: task.criteria.map((text, index) => ({ id: `AC-0${index + 1}`, text })),
  test_commands: [{ id: "verification", program: "node", args: ["verify.mjs"], cwd: ".", timeout_seconds: 30, required: true }],
  execution_policy: { planner_recommendation: "strong", planner_confidence: "high", recommendation_reasons: ["Controlled A/B task"], user_lock: null },
  limits: { max_attempts: 2, run_timeout_seconds: 300, max_changed_files: 1, max_diff_bytes: 65536 }
});

export type PairEvidence = { specHash: string; testsHash: string; acceptanceHash: string; base: { canonicalSha: string } };
export const pairConsistent = (baseline: PairEvidence, variant: PairEvidence): boolean => baseline.specHash === variant.specHash && baseline.testsHash === variant.testsHash && baseline.acceptanceHash === variant.acceptanceHash && baseline.base.canonicalSha === variant.base.canonicalSha;

/** Creates a disposable, committed fixture. The verification file is deliberately outside worker scope. */
export const writeControlledFixture = (task: ControlledTask): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), `agentplatform-${task.id.toLowerCase()}-`));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, task.file), task.source); for (const entry of task.files ?? []) { mkdirSync(path.dirname(path.join(root, entry.file)), { recursive: true }); writeFileSync(path.join(root, entry.file), entry.source); } writeFileSync(path.join(root, "verify.mjs"), task.verification);
  return root;
};
