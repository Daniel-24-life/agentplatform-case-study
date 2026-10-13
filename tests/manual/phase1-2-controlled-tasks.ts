import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { evaluatePhase12Pair, type Phase12Pair } from "../../src/shared/core/ab-evaluation.js";
import { AppDatabase } from "../../src/main/db/database.js";
import type { ControlledTask } from "./phase1-controlled-tasks.js";

/** Frozen Phase 1.2 definitions. Keep IDs, source, tests and criteria stable after preregistration. */
export const phase12DevelopmentTasks = [
  { id: "DEV_COUNTER", file: "src/counter.mjs", source: "export function increment(value) { throw new Error('TODO'); }\n", goal: "Implement increment(value) in src/counter.mjs.", criteria: ["Exports increment.", "Accepts finite integers only and throws TypeError otherwise.", "Returns value plus one."], verification: "import assert from 'node:assert/strict'; import { increment } from './src/counter.mjs'; assert.equal(increment(4),5); assert.throws(() => increment('4'), TypeError);" },
  { id: "DEV_CONFIG", file: "src/config.mjs", source: "import { isPlainObject } from './config-utils.mjs';\nexport function parseConfig(value) { throw new Error('TODO'); }\n", files: [{ file: "src/config-utils.mjs", source: "export function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }\n" }], goal: "Implement parseConfig(value) in src/config.mjs and use the local helper in src/config-utils.mjs.", criteria: ["Exports parseConfig and uses isPlainObject from config-utils.", "Requires a plain object with a non-empty name string.", "Returns a new object containing name and enabled, defaulting enabled to false."], verification: "import assert from 'node:assert/strict'; import { parseConfig } from './src/config.mjs'; assert.deepEqual(parseConfig({name:'x'}),{name:'x',enabled:false}); assert.deepEqual(parseConfig({name:'x',enabled:true}),{name:'x',enabled:true}); assert.throws(() => parseConfig({}), TypeError);" },
  { id: "DEV_FORMAT", file: "src/format-pairs.mjs", source: "export function formatPairs(values) { throw new Error('TODO'); }\n", goal: "Implement formatPairs(values) in src/format-pairs.mjs.", criteria: ["Exports formatPairs.", "Formats each two element pair as key=value.", "Rejects non-arrays, malformed pairs and non-string keys or values."], verification: "import assert from 'node:assert/strict'; import { formatPairs } from './src/format-pairs.mjs'; assert.equal(formatPairs([['a','1'],['b','2']]),'a=1\\nb=2'); assert.throws(() => formatPairs([['a']]), Error);" },
  { id: "PATH_REPORT", file: "src/flatten-tree.mjs", source: "export function flattenTree(nodes) { throw new Error('TODO'); }\n", goal: "Implement flattenTree(nodes) in src/flatten-tree.mjs.", criteria: ["Exports flattenTree.", "Returns DFS file paths across multiple roots using slash separators; empty directories produce no file path.", "Rejects malformed fields, file children, and duplicate output paths with Error."], verification: "import assert from 'node:assert/strict'; import { flattenTree } from './src/flatten-tree.mjs'; assert.deepEqual(flattenTree([{name:'a',type:'dir',children:[{name:'x',type:'file'}]},{name:'b',type:'file'}]),['a/x','b']);" }
] as const;

export const phase12HoldoutTasks = [
  { id: "HOLDOUT_SUM", file: "src/sum.mjs", source: "export function sum(values) { throw new Error('TODO'); }\n", goal: "Implement sum(values) in src/sum.mjs.", criteria: ["Exports sum.", "Accepts an array of finite numbers.", "Returns the numeric total and rejects invalid inputs."], verification: "import assert from 'node:assert/strict'; import { sum } from './src/sum.mjs'; assert.equal(sum([1,2,3]),6); assert.throws(() => sum([1,Infinity]), Error);" },
  { id: "HOLDOUT_CLAMP", file: "src/clamp.mjs", source: "export function clamp(value, lower, upper) { throw new Error('TODO'); }\n", goal: "Implement clamp(value, lower, upper) in src/clamp.mjs.", criteria: ["Exports clamp.", "Returns value constrained to inclusive bounds.", "Rejects non-finite numbers or inverted bounds."], verification: "import assert from 'node:assert/strict'; import { clamp } from './src/clamp.mjs'; assert.equal(clamp(9,0,5),5); assert.equal(clamp(-1,0,5),0); assert.throws(() => clamp(1,5,0), Error);" },
  { id: "HOLDOUT_UNIQUE", file: "src/unique.mjs", source: "export function unique(values) { throw new Error('TODO'); }\n", files: [{ file: "tests/unique-focused.mjs", source: "import assert from 'node:assert/strict'; import { unique } from '../src/unique.mjs'; assert.deepEqual(unique(['a','a','b']), ['a','b']);\n" }], goal: "Implement unique(values) in src/unique.mjs and add the focused regression test in tests/unique-focused.mjs.", criteria: ["Exports unique.", "Returns first occurrences in original order.", "Accepts only arrays.", "Adds a focused regression test covering duplicate removal."], verification: "import assert from 'node:assert/strict'; import { unique } from './src/unique.mjs'; await import('./tests/unique-focused.mjs'); assert.deepEqual(unique(['a','b','a']),['a','b']); assert.throws(() => unique(null), TypeError);" },
  { id: "HOLDOUT_PARSE_BOOL", file: "src/parse-bool.mjs", source: "export function parseBool(value) { throw new Error('TODO'); }\n", goal: "Implement parseBool(value) in src/parse-bool.mjs.", criteria: ["Exports parseBool.", "Parses true/false strings case-insensitively after trimming.", "Rejects other values with a RangeError."], verification: "import assert from 'node:assert/strict'; import { parseBool } from './src/parse-bool.mjs'; assert.equal(parseBool(' TRUE '),true); assert.equal(parseBool('false'),false); assert.throws(() => parseBool('yes'), RangeError);" },
  { id: "HOLDOUT_GROUP", file: "src/group-by.mjs", source: "export function groupBy(values, key) { throw new Error('TODO'); }\n", goal: "Implement groupBy(values, key) in src/group-by.mjs.", criteria: ["Exports groupBy.", "Groups object entries by a string property.", "Preserves input order within each group and rejects invalid entries."], verification: "import assert from 'node:assert/strict'; import { groupBy } from './src/group-by.mjs'; assert.deepEqual(groupBy([{k:'a',v:1},{k:'b',v:2},{k:'a',v:3}],'k'),{a:[{k:'a',v:1},{k:'a',v:3}],b:[{k:'b',v:2}]});" },
  { id: "HOLDOUT_LINES", file: "src/join-lines.mjs", source: "export function joinLines(values) { throw new Error('TODO'); }\n", goal: "Implement joinLines(values) in src/join-lines.mjs.", criteria: ["Exports joinLines.", "Trims entries, drops blank entries and joins with newline.", "Accepts only arrays of strings."], verification: "import assert from 'node:assert/strict'; import { joinLines } from './src/join-lines.mjs'; assert.equal(joinLines([' a ','','b ']),'a\\nb'); assert.throws(() => joinLines([1]), TypeError);" }
] as const;

export const phase12Tasks = [...phase12DevelopmentTasks, ...phase12HoldoutTasks] as const;
export const phase12TaskPopulation = (value: string | undefined): readonly typeof phase12Tasks[number][] => value === "development" ? phase12DevelopmentTasks : value === "holdout" ? phase12HoldoutTasks : phase12Tasks;
export const phase12TaskHash = (task: typeof phase12Tasks[number]): string => createHash("sha256").update(JSON.stringify(task)).digest("hex");
export const asControlledTasks = (tasks: readonly typeof phase12Tasks[number][]): ControlledTask[] => tasks as unknown as ControlledTask[];

export type Phase12Models = { strong: string; cheap: string; strongReasoning: "low" | "medium" };
export type Phase12PairChecksEvidence = {
  id: string;
  population: "development" | "holdout";
  sameBase: boolean;
  isolated: boolean;
  specConsistent: boolean;
  testsConsistent: boolean;
  acceptanceConsistent: boolean;
  routeConsistent: boolean;
  artifactConsistent: boolean;
  sharedPlanner: {
    runId: string;
    status: string;
    model: string | null;
    reasoning: string | null;
    durationMs: number | null;
    usageJson: string | null;
    failure: { domain: "runtime" | "task" | "user"; code: string } | null;
    artifactPaths: string[];
  };
};
export type Phase12TaskEvidence = { id: string; population: "development" | "holdout"; baseline: unknown; variant?: unknown };
export type Phase12EvidenceDocument = {
  schemaVersion: "1.2";
  population: "development" | "holdout" | "all";
  models: Phase12Models;
  preflight: unknown;
  definitionHashes: Record<string, string>;
  importedDevelopment: boolean;
  pairs: Phase12Pair[];
  pairChecks: Phase12PairChecksEvidence[];
  taskEvidence: Phase12TaskEvidence[];
};

type JsonRecord = Record<string, unknown>;

const hashMap = (population: "development" | "holdout" | "all"): Record<string, string> => Object.fromEntries(phase12TaskPopulation(population).map((task) => [task.id, phase12TaskHash(task)]));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNullableNumber = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value: unknown, expected: readonly string[]): boolean => isRecord(value) && sameJson(Object.keys(value), expected);

/** Creates the immutable Phase 1.2 evidence shape without synthesizing paths or planner metadata. */
export const buildPhase12Evidence = (input: Omit<Phase12EvidenceDocument, "schemaVersion" | "definitionHashes">): Phase12EvidenceDocument => {
  // A holdout run merges the validated four development records with six new
  // holdouts, so its final output is the complete ten-task population.
  const evidencePopulation = input.population === "development" ? "development" : "all";
  const expected = phase12TaskPopulation(evidencePopulation).map((task) => task.id);
  const ids = input.pairs.map((pair) => pair.id);
  if (ids.length !== expected.length || new Set(ids).size !== ids.length || !expected.every((id) => ids.includes(id))) throw new Error("Phase 1.2 evidence population does not match the preregistration");
  if (input.pairChecks.length !== ids.length || input.taskEvidence.length !== ids.length) throw new Error("Phase 1.2 evidence is missing pair checks or task evidence");
  return { schemaVersion: "1.2", ...input, definitionHashes: hashMap(evidencePopulation) };
};

export type Phase12BlockedEvidence = Phase12EvidenceDocument & {
  evaluation: { status: "BLOCKED"; validCount: number; reason: "RUNTIME_OR_USER_FAILURE"; failureCode: string };
};

/** Writes fail-fast evidence without pretending that an interrupted pair completed. */
export const buildPhase12BlockedEvidence = (input: Omit<Phase12EvidenceDocument, "schemaVersion" | "definitionHashes"> & { failureCode: string }): Phase12BlockedEvidence => {
  const evidencePopulation = input.population === "development" ? "development" : "all";
  const expected = new Set<string>(phase12TaskPopulation(evidencePopulation).map((task) => task.id));
  const idsAreUniqueAndExpected = (items: Array<{ id: string }>) => new Set(items.map((item) => item.id)).size === items.length && items.every((item) => expected.has(item.id));
  if (!idsAreUniqueAndExpected(input.pairs) || !idsAreUniqueAndExpected(input.pairChecks) || !idsAreUniqueAndExpected(input.taskEvidence)) throw new Error("Phase 1.2 blocked evidence contains an unknown or duplicate task");
  if (!input.pairChecks.every((checks) => input.pairs.some((pair) => pair.id === checks.id))) throw new Error("Phase 1.2 blocked evidence has checks without a completed pair");
  return {
    schemaVersion: "1.2",
    population: input.population,
    models: input.models,
    preflight: input.preflight,
    definitionHashes: hashMap(evidencePopulation),
    importedDevelopment: input.importedDevelopment,
    pairs: input.pairs,
    pairChecks: input.pairChecks,
    taskEvidence: input.taskEvidence,
    evaluation: { status: "BLOCKED", validCount: input.pairs.length, reason: "RUNTIME_OR_USER_FAILURE", failureCode: input.failureCode }
  };
};

const validSummary = (value: unknown): boolean => {
  if (!isRecord(value) || !isRecord(value.metrics)) return false;
  const booleans = ["sameBase", "isolated", "sourceClean", "testsPassed", "gatesPassed", "evidenceComplete", "specConsistent", "testsConsistent", "acceptanceConsistent", "highTierUsageComplete"];
  if (!booleans.every((key) => isBoolean(value[key]))) return false;
  if (typeof value.finalVerdict !== "string" || !isNullableNumber(value.metrics.highTierCalls)) return false;
  return true;
};
const validPair = (value: unknown, id: string): value is Phase12Pair => isRecord(value)
  && value.id === id
  && value.population === "development"
  && validSummary(value.baseline)
  && validSummary(value.variant)
  && isBoolean(value.eventualSuccess)
  && isBoolean(value.firstAttemptSuccess)
  && typeof value.sharedPlannerCalls === "number"
  && typeof value.humanIntervention === "number"
  && isBoolean(value.routeConsistent)
  && isBoolean(value.artifactConsistent);
const validSharedPlanner = (value: unknown): boolean => isRecord(value)
  && typeof value.runId === "string"
  && typeof value.status === "string"
  && (typeof value.model === "string" || value.model === null)
  && (typeof value.reasoning === "string" || value.reasoning === null)
  && isNullableNumber(value.durationMs)
  && (typeof value.usageJson === "string" || value.usageJson === null)
  && (value.failure === null || (isRecord(value.failure) && (value.failure.domain === "runtime" || value.failure.domain === "task" || value.failure.domain === "user") && typeof value.failure.code === "string"))
  && isStringArray(value.artifactPaths);
const validPairChecks = (value: unknown, id: string): boolean => isRecord(value)
  && value.id === id && value.population === "development"
  && ["sameBase", "isolated", "specConsistent", "testsConsistent", "acceptanceConsistent", "routeConsistent", "artifactConsistent"].every((key) => isBoolean(value[key]))
  && validSharedPlanner(value.sharedPlanner);
const validTaskEvidence = (value: unknown, id: string): boolean => isRecord(value)
  && value.id === id && value.population === "development"
  && isRecord(value.baseline) && isRecord(value.variant)
  && value.baseline.arm === "baseline" && value.variant.arm === "variant"
  && value.baseline.taskId === id && value.variant.taskId === id
  && isStringArray(value.baseline.evidencePaths) && isStringArray(value.variant.evidencePaths);

/** Strictly accepts only a complete, current-model development evidence document for holdout merging. */
export const importPhase12DevelopmentEvidence = (value: unknown, models: Phase12Models): Phase12EvidenceDocument => {
  if (!isRecord(value) || value.schemaVersion !== "1.2" || value.population !== "development" || !sameJson(value.models, models) || !sameJson(value.definitionHashes, hashMap("development")) || value.importedDevelopment !== false || !Array.isArray(value.pairs) || !Array.isArray(value.pairChecks) || !Array.isArray(value.taskEvidence)) throw new Error("Invalid development evaluation evidence");
  const ids = phase12DevelopmentTasks.map((task) => task.id);
  const uniqueIds = (items: unknown[]): string[] => items.map((item) => isRecord(item) && typeof item.id === "string" ? item.id : "");
  if (value.pairs.length !== 4 || value.pairChecks.length !== 4 || value.taskEvidence.length !== 4 || !sameJson(uniqueIds(value.pairs).sort(), [...ids].sort()) || !sameJson(uniqueIds(value.pairChecks).sort(), [...ids].sort()) || !sameJson(uniqueIds(value.taskEvidence).sort(), [...ids].sort())) throw new Error("Invalid development evaluation evidence");
  for (const id of ids) {
    const pair = value.pairs.find((entry) => isRecord(entry) && entry.id === id);
    const checks = value.pairChecks.find((entry) => isRecord(entry) && entry.id === id);
    const taskEvidence = value.taskEvidence.find((entry) => isRecord(entry) && entry.id === id);
    if (!validPair(pair, id) || !validPairChecks(checks, id) || !validTaskEvidence(taskEvidence, id)) throw new Error("Invalid development evaluation evidence");
  }
  return value as unknown as Phase12EvidenceDocument;
};

const expectedAllIds = phase12Tasks.map((task) => task.id);
const expectedDevelopmentIds = phase12DevelopmentTasks.map((task) => task.id);
const expectedHoldoutIds = phase12HoldoutTasks.map((task) => task.id);

const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validFailure = (value: unknown): boolean => value === null || (isRecord(value)
  && (value.domain === "runtime" || value.domain === "task" || value.domain === "user")
  && typeof value.code === "string");
const validArmShape = (value: unknown, id: string, arm: "baseline" | "variant"): value is JsonRecord => isRecord(value)
  && value.arm === arm
  && value.taskId === id
  && typeof value.taskSuccess === "boolean"
  && typeof value.testsPassed === "boolean"
  && typeof value.gatePassed === "boolean"
  && typeof value.finalVerdict === "string"
  && validNumber(value.p0Findings)
  && validNumber(value.p1Findings)
  && isRecord(value.metrics)
  && typeof value.highTierUsageComplete === "boolean"
  && validFailure(value.failure)
  && isRecord(value.base)
  && isStringArray(value.evidencePaths)
  && value.evidencePaths.length >= 4
  && isRecord(value.evidenceFileHashes)
  && (typeof value.evidenceManifestSha256 === "string" || value.evidenceManifestSha256 === null)
  && validNumber(value.humanIntervention)
  && typeof value.specJson === "string"
  && typeof value.specHash === "string"
  && typeof value.testsHash === "string"
  && typeof value.acceptanceHash === "string"
  && isRecord(value.detail);

const verifyArmEvidence = (value: unknown, id: string, arm: "baseline" | "variant", requireManifest: boolean): boolean => {
  if (!validArmShape(value, id, arm)) return false;
  const evidence = value as JsonRecord & { evidencePaths: string[]; evidenceFileHashes: Record<string, string>; detail: JsonRecord; runs: unknown[]; base: JsonRecord; evidenceManifestSha256: string | null; failure: unknown };
  try {
    const armRoot = path.dirname(evidence.evidencePaths[0]);
    if (!existsSync(armRoot) || !evidence.evidencePaths.every((entry: string) => path.isAbsolute(entry) && existsSync(entry))) return false;
    const armRootReal = realpathSync(armRoot);
    if (!evidence.evidencePaths.every((entry: string) => {
      try {
        const physical = path.relative(armRootReal, realpathSync(entry));
        return physical !== "" && physical !== ".." && !physical.startsWith(`..${path.sep}`) && !path.isAbsolute(physical);
      } catch { return false; }
    })) return false;
    for (const [relative, expectedHash] of Object.entries(evidence.evidenceFileHashes)) {
      if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
      const target = containedFile(armRoot, relative);
      if (target === null || sha256File(target) !== expectedHash) return false;
    }
    const taskSpecPath = containedFile(armRoot, "task-spec.json");
    const sourceStatePath = containedFile(armRoot, "source-state.json");
    const armResultPath = containedFile(armRoot, "arm-result.json");
    if (taskSpecPath === null || sourceStatePath === null || armResultPath === null) return false;
    const taskSpec = JSON.parse(readFileSync(taskSpecPath, "utf8")) as JsonRecord;
    if (taskSpec.approvedSpecJson !== evidence.specJson || taskSpec.specHash !== evidence.specHash || taskSpec.testsHash !== evidence.testsHash || taskSpec.acceptanceHash !== evidence.acceptanceHash) return false;
    if (!sameJson(JSON.parse(readFileSync(sourceStatePath, "utf8")), evidence.base)) return false;
    // arm-result.json is intentionally checked against the copied raw result. Its
    // sibling hashes cover the immutable files, while this equality prevents a
    // caller from editing only the evaluation wrapper around a real result.
    if (!sameJson(JSON.parse(readFileSync(armResultPath, "utf8")), evidence)) return false;
    const detailSnapshot = isRecord(evidence.detail.snapshot) ? evidence.detail.snapshot : null;
    if (detailSnapshot === null) return !requireManifest && evidence.failure !== null && isRecord(evidence.failure) && (evidence.failure.domain === "runtime" || evidence.failure.domain === "user");
    const attemptId = typeof detailSnapshot.attemptId === "string" ? detailSnapshot.attemptId : null;
    const artifacts = Array.isArray(detailSnapshot.artifacts) ? detailSnapshot.artifacts : null;
    if (attemptId === null || artifacts === null) return false;
    const attemptRoot = containedDirectory(armRoot, path.join("artifacts", "attempts", attemptId));
    if (attemptRoot === null) return false;
    const normalizedArtifacts: Phase12ArtifactEvidence[] = [];
    for (const entry of artifacts) {
      if (!isRecord(entry) || typeof entry.kind !== "string" || typeof entry.path !== "string" || !validNumber(entry.sizeBytes) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || typeof entry.sha256 !== "string") return false;
      const artifact = { kind: entry.kind, path: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
      if (!matchesArtifact(attemptRoot, artifact)) return false;
      normalizedArtifacts.push(artifact);
    }
    const manifests = normalizedArtifacts.filter((artifact) => artifact.kind === "manifest");
    if (requireManifest && manifests.length !== 1) return false;
    if (manifests.length > 1) return false;
    if (manifests.length === 1) {
      const manifest = manifests[0];
      if (evidence.evidenceManifestSha256 !== manifest.sha256) return false;
      const manifestFile = containedFile(attemptRoot, manifest.path);
      if (manifestFile === null) return false;
      const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as JsonRecord;
      const context = isRecord(evidence.base) && isRecord(detailSnapshot) ? {
        taskId: id,
        attemptId,
        baseSha: typeof evidence.base.canonicalSha === "string" ? evidence.base.canonicalSha : "",
        branch: typeof detailSnapshot.branch === "string" ? detailSnapshot.branch : "",
        worktreeHead: typeof evidence.base.worktreeHead === "string" ? evidence.base.worktreeHead : ""
      } : null;
      if (context === null || parsed.schema_version !== "1.0" || parsed.task_id !== context.taskId || parsed.attempt_id !== context.attemptId || parsed.base_sha !== context.baseSha || parsed.branch !== context.branch || parsed.worktree_head !== context.worktreeHead || !Array.isArray(parsed.artifacts)) return false;
      const snapshotByPath = new Map(normalizedArtifacts.filter((artifact) => artifact.kind !== "manifest").map((artifact) => [artifact.path, artifact]));
      if (!parsed.artifacts.every((entry) => isRecord(entry) && typeof entry.path === "string" && snapshotByPath.has(entry.path) && sameJson(entry, snapshotByPath.get(entry.path)))) return false;
    } else if (evidence.evidenceManifestSha256 !== null) return false;
    const databasePath = containedFile(armRoot, "run.sqlite");
    if (databasePath === null) return false;
    const database = new AppDatabase(databasePath);
    try {
      const persistedRuns = database.listTaskRuns(id);
      if (persistedRuns.length !== evidence.runs.length || !sameJson(persistedRuns, evidence.runs)) return false;
    } finally { database.close(); }
    return true;
  } catch { return false; }
};

const containedDirectory = (root: string, relative: string): string | null => {
  if (!relative || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  const lexical = path.relative(path.resolve(root), target);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical) || !existsSync(target)) return null;
  try {
    const rootReal = realpathSync(root); const targetReal = realpathSync(target);
    const physical = path.relative(rootReal, targetReal);
    return physical !== "" && physical !== ".." && !physical.startsWith(`..${path.sep}`) && !path.isAbsolute(physical) && statSync(targetReal).isDirectory() ? targetReal : null;
  } catch { return null; }
};

const validPairForPopulation = (value: unknown, id: string, population: "development" | "holdout"): value is Phase12Pair => isRecord(value)
  && value.id === id
  && value.population === population
  && validSummary(value.baseline)
  && validSummary(value.variant)
  && isBoolean(value.eventualSuccess)
  && isBoolean(value.firstAttemptSuccess)
  && validNumber(value.sharedPlannerCalls)
  && validNumber(value.humanIntervention)
  && isBoolean(value.routeConsistent)
  && isBoolean(value.artifactConsistent)
  && evaluatePhase12Pair(value as unknown as Phase12Pair).valid;
const validChecksForPopulation = (value: unknown, id: string, population: "development" | "holdout"): value is Phase12PairChecksEvidence => isRecord(value)
  && value.id === id
  && value.population === population
  && ["sameBase", "isolated", "specConsistent", "testsConsistent", "acceptanceConsistent", "routeConsistent", "artifactConsistent"].every((key) => isBoolean(value[key]))
  && validSharedPlanner(value.sharedPlanner);
const validCompletedTaskEvidence = (value: unknown, id: string, population: "development" | "holdout"): value is Phase12TaskEvidence => isRecord(value)
  && value.id === id
  && value.population === population
  && verifyArmEvidence(value.baseline, id, "baseline", population === "holdout")
  && verifyArmEvidence(value.variant, id, "variant", population === "holdout");
const validDevelopmentTaskEvidence = (value: unknown, id: string): value is Phase12TaskEvidence => isRecord(value)
  && value.id === id
  && value.population === "development"
  && isRecord(value.baseline)
  && isRecord(value.variant)
  && value.baseline.arm === "baseline"
  && value.variant.arm === "variant"
  && value.baseline.taskId === id
  && value.variant.taskId === id
  && isStringArray(value.baseline.evidencePaths)
  && isStringArray(value.variant.evidencePaths);

const taskEvidenceHasRuntimeFailure = (value: unknown): boolean => isRecord(value) && [value.baseline, value.variant].some((arm) => isRecord(arm) && isRecord(arm.failure) && (arm.failure.domain === "runtime" || arm.failure.domain === "user"));
const taskEvidenceHasTaskFailure = (value: unknown): boolean => isRecord(value) && [value.baseline, value.variant].some((arm) => isRecord(arm) && isRecord(arm.failure) && arm.failure.domain === "task");
const checksMatchPair = (pair: Phase12Pair, checks: Phase12PairChecksEvidence): boolean => {
  const summaries = [pair.baseline, pair.variant];
  return summaries.every((summary) => summary.sameBase === checks.sameBase
    && summary.isolated === checks.isolated
    && summary.specConsistent === checks.specConsistent
    && summary.testsConsistent === checks.testsConsistent
    && summary.acceptanceConsistent === checks.acceptanceConsistent)
    && pair.routeConsistent === checks.routeConsistent
    && pair.artifactConsistent === checks.artifactConsistent;
};
const hasAllDefinitionHashes = (value: unknown): boolean => isRecord(value)
  && exactKeys(value, expectedAllIds)
  && expectedAllIds.every((id) => value[id] === phase12TaskHash(phase12Tasks.find((task) => task.id === id)!));

/**
 * Imports only completed holdout pairs from a prior blocked/runtime-invalid
 * evaluation. Development records must be the exact frozen records supplied
 * for this run; the incomplete runtime record is deliberately discarded.
 */
export const importPhase12HoldoutEvidence = (value: unknown, models: Phase12Models, developmentEvidence?: unknown): Phase12EvidenceDocument => {
  if (!isRecord(value) || value.schemaVersion !== "1.2" || (value.population !== "holdout" && value.population !== "all") || !sameJson(value.models, models) || !hasAllDefinitionHashes(value.definitionHashes) || value.importedDevelopment !== true || !Array.isArray(value.pairs) || !Array.isArray(value.pairChecks) || !Array.isArray(value.taskEvidence)) throw new Error("Invalid holdout evaluation evidence");
  if (!isRecord(value.preflight) || value.preflight.passed !== true) throw new Error("Invalid holdout evaluation evidence");
  const pairIds = value.pairs.map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : "");
  const checksIds = value.pairChecks.map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : "");
  const taskIds = value.taskEvidence.map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : "");
  const isPrefix = (ids: string[], allowed: readonly string[]) => ids.every((id, index) => id === allowed[index]) && new Set(ids).size === ids.length;
  if (!isPrefix(pairIds, expectedAllIds) || !isPrefix(checksIds, expectedAllIds) || !isPrefix(taskIds, expectedAllIds) || pairIds.length !== checksIds.length || pairIds.length > taskIds.length) throw new Error("Invalid holdout evaluation evidence");
  const pairById = new Map(value.pairs.map((entry) => [isRecord(entry) && typeof entry.id === "string" ? entry.id : "", entry]));
  const checksById = new Map(value.pairChecks.map((entry) => [isRecord(entry) && typeof entry.id === "string" ? entry.id : "", entry]));
  const taskById = new Map(value.taskEvidence.map((entry) => [isRecord(entry) && typeof entry.id === "string" ? entry.id : "", entry]));
  for (const id of expectedDevelopmentIds) {
    if (!validPairForPopulation(pairById.get(id), id, "development") || !validChecksForPopulation(checksById.get(id), id, "development") || !validDevelopmentTaskEvidence(taskById.get(id), id)) throw new Error("Invalid holdout evaluation evidence");
  }
  const holdoutPairCount = pairIds.length - expectedDevelopmentIds.length;
  if (holdoutPairCount < 0 || holdoutPairCount > expectedHoldoutIds.length) throw new Error("Invalid holdout evaluation evidence");
  for (let index = 0; index < holdoutPairCount; index += 1) {
    const id = expectedHoldoutIds[index];
    if (!validPairForPopulation(pairById.get(id), id, "holdout") || !validChecksForPopulation(checksById.get(id), id, "holdout") || !validCompletedTaskEvidence(taskById.get(id), id, "holdout")) throw new Error("Invalid holdout evaluation evidence");
    const pair = pairById.get(id) as Phase12Pair;
    const checks = checksById.get(id) as Phase12PairChecksEvidence;
    if (!checksMatchPair(pair, checks) || !pair.artifactConsistent || !pair.baseline.evidenceComplete || !pair.variant.evidenceComplete || checks.sharedPlanner.model !== models.strong || checks.sharedPlanner.reasoning !== models.strongReasoning || checks.sharedPlanner.status !== "SUCCEEDED" || checks.sharedPlanner.failure !== null || checks.sharedPlanner.artifactPaths.length === 0 || !checks.sharedPlanner.artifactPaths.every((entry) => path.isAbsolute(entry) && existsSync(entry))) throw new Error("Invalid holdout evaluation evidence");
  }
  if (taskIds.length > pairIds.length) {
    const incomplete = value.taskEvidence[pairIds.length];
    if (taskIds.length !== pairIds.length + 1 || !isRecord(incomplete) || !taskEvidenceHasRuntimeFailure(incomplete) || taskEvidenceHasTaskFailure(incomplete) || incomplete.population !== "holdout" || !(typeof incomplete.id === "string" && expectedHoldoutIds.includes(incomplete.id as typeof expectedHoldoutIds[number]))) throw new Error("Invalid holdout evaluation evidence");
    if (!validArmShape(incomplete.baseline, incomplete.id as string, "baseline") || (incomplete.variant !== undefined && !validArmShape(incomplete.variant, incomplete.id as string, "variant"))) throw new Error("Invalid holdout evaluation evidence");
  }
  if (developmentEvidence !== undefined) {
    const development = importPhase12DevelopmentEvidence(developmentEvidence, models);
    const priorHashes = value.definitionHashes as Record<string, string>;
    if (!sameJson(Object.fromEntries(expectedDevelopmentIds.map((id) => [id, priorHashes[id]])), development.definitionHashes)
      || !sameJson(value.pairs.slice(0, 4), development.pairs)
      || !sameJson(value.pairChecks.slice(0, 4), development.pairChecks)
      || !sameJson(value.taskEvidence.slice(0, 4), development.taskEvidence)) throw new Error("Invalid holdout development evidence");
  }
  const evaluation = value.evaluation;
  if (!isRecord(evaluation) || evaluation.status !== "BLOCKED" || evaluation.validCount !== pairIds.length || evaluation.reason !== "RUNTIME_OR_USER_FAILURE" || typeof evaluation.failureCode !== "string" || evaluation.failureCode.length === 0) throw new Error("Invalid holdout evaluation evidence");
  return {
    schemaVersion: "1.2",
    population: "holdout",
    models,
    preflight: value.preflight,
    definitionHashes: hashMap("all"),
    importedDevelopment: true,
    pairs: value.pairs.slice(0, pairIds.length) as Phase12Pair[],
    pairChecks: value.pairChecks.slice(0, pairIds.length) as Phase12PairChecksEvidence[],
    taskEvidence: value.taskEvidence.slice(0, pairIds.length) as Phase12TaskEvidence[]
  };
};

/** Returns frozen holdout definitions that do not yet have a valid pair. */
export const selectPhase12HoldoutTasks = (evidence: Pick<Phase12EvidenceDocument, "pairs">): readonly typeof phase12HoldoutTasks[number][] => {
  const completed = new Set(evidence.pairs.filter((pair) => pair.population === "holdout").map((pair) => pair.id));
  return phase12HoldoutTasks.filter((task) => !completed.has(task.id));
};

export type Phase12ArtifactEvidence = { kind: string; path: string; sizeBytes: number; sha256: string };
export type Phase12ManifestContext = { taskId: string; attemptId: string; baseSha: string; branch: string; worktreeHead: string };
export type Phase12ArmFileEvidence = { armRoot: string; attemptRoot: string; fileHashes: Record<string, string>; artifacts: Phase12ArtifactEvidence[]; manifestContext: Phase12ManifestContext | null };
const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const containedFile = (root: string, relative: string): string | null => {
  if (!relative || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  const lexical = path.relative(path.resolve(root), target);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical) || !existsSync(target)) return null;
  try {
    const rootReal = realpathSync(root);
    const targetReal = realpathSync(target);
    const physical = path.relative(rootReal, targetReal);
    if (physical === "" || physical === ".." || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical) || !statSync(targetReal).isFile()) return null;
    return targetReal;
  } catch { return null; }
};
const matchesArtifact = (root: string, artifact: Phase12ArtifactEvidence): boolean => {
  if (typeof artifact.kind !== "string" || typeof artifact.path !== "string" || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) return false;
  const target = containedFile(root, artifact.path);
  return target !== null && statSync(target).size === artifact.sizeBytes && sha256File(target) === artifact.sha256;
};

/** Re-hashes copied arm files and all manifest-declared artifacts without allowing paths to escape their evidence roots. */
export const verifyPhase12ArmFileEvidence = (evidence: Phase12ArmFileEvidence): boolean => {
  try {
    for (const [relative, hash] of Object.entries(evidence.fileHashes)) {
      if (!/^[a-f0-9]{64}$/i.test(hash)) return false;
      const target = containedFile(evidence.armRoot, relative);
      if (target === null || sha256File(target) !== hash) return false;
    }
    if (!evidence.artifacts.every((artifact) => matchesArtifact(evidence.attemptRoot, artifact))) return false;
    const manifests = evidence.artifacts.filter((artifact) => artifact.kind === "manifest");
    if (evidence.manifestContext === null) return manifests.length === 0;
    if (manifests.length !== 1) return false;
    const manifest = manifests[0];
    const manifestFile = containedFile(evidence.attemptRoot, manifest.path);
    if (manifestFile === null || sha256File(manifestFile) !== manifest.sha256) return false;
    const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as { schema_version?: unknown; task_id?: unknown; attempt_id?: unknown; base_sha?: unknown; branch?: unknown; worktree_head?: unknown; artifacts?: unknown };
    const context = evidence.manifestContext;
    if (parsed.schema_version !== "1.0" || parsed.task_id !== context.taskId || parsed.attempt_id !== context.attemptId || parsed.base_sha !== context.baseSha || parsed.branch !== context.branch || parsed.worktree_head !== context.worktreeHead || !Array.isArray(parsed.artifacts)) return false;
    const snapshotByPath = new Map(evidence.artifacts.filter((artifact) => artifact.kind !== "manifest").map((artifact) => [artifact.path, artifact]));
    return parsed.artifacts.every((entry) => {
      if (!isRecord(entry)) return false;
      const snapshot = typeof entry.path === "string" ? snapshotByPath.get(entry.path) : undefined;
      return snapshot !== undefined && entry.kind === snapshot.kind && entry.path === snapshot.path && entry.sizeBytes === snapshot.sizeBytes && entry.sha256 === snapshot.sha256 && matchesArtifact(evidence.attemptRoot, snapshot);
    });
  } catch { return false; }
};
