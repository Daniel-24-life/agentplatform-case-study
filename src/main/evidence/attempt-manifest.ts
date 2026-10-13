import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isRelativeSafePath } from "../../shared/core/paths.js";

export type ManifestReference = { kind: string; root: "attempt" | "runs"; path: string; sizeBytes: number; sha256: string };
export type AttemptManifest = {
  schema_version: "1.1";
  project_id: string;
  task_id: string;
  attempt_id: string;
  task_spec: { revision: number; approved_at: string; sha256: string; artifact: string };
  run_ids: string[];
  base_sha: string;
  branch: string;
  worktree_head: string;
  changed_files: string[];
  git: { diff: string; stat: string; changed_files: string };
  test_runs: Array<{ id: string; run_id: string; required: boolean; status: string; result: string; stdout: string; stderr: string }>;
  deterministic_gate: { passed: boolean; artifact: string };
  artifacts: ManifestReference[];
  generated_at: string;
};

const safeFile = (artifactRoot: string, attemptId: string, reference: Pick<ManifestReference, "root" | "path">): string => {
  if (!isRelativeSafePath(reference.path) || !["attempt", "runs"].includes(reference.root)) throw new Error("EVIDENCE_CORRUPT: invalid manifest path");
  const root = path.resolve(artifactRoot, reference.root === "attempt" ? path.join("attempts", attemptId) : "runs");
  const file = path.resolve(root, reference.path);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("EVIDENCE_CORRUPT: invalid manifest file");
  return file;
};

const checkedFile = (artifactRoot: string, attemptId: string, reference: ManifestReference): Buffer => {
  const file = safeFile(artifactRoot, attemptId, reference);
  const data = readFileSync(file);
  if (data.length !== reference.sizeBytes || createHash("sha256").update(data).digest("hex") !== reference.sha256) throw new Error("EVIDENCE_CORRUPT: manifest hash mismatch");
  return data;
};

export const referenceFile = (artifactRoot: string, attemptId: string, kind: string, root: ManifestReference["root"], relativePath: string): ManifestReference => {
  const target = safeFile(artifactRoot, attemptId, { root, path: relativePath });
  const data = readFileSync(target);
  const reference = { kind, root, path: relativePath.replace(/\\/g, "/"), sizeBytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  checkedFile(artifactRoot, attemptId, reference);
  return reference;
};

export const verifyAttemptManifest = (artifactRoot: string, manifest: AttemptManifest): void => {
  if (manifest.schema_version !== "1.1" || !Array.isArray(manifest.artifacts)) throw new Error("EVIDENCE_CORRUPT: invalid manifest");
  const paths = new Set<string>();
  for (const reference of manifest.artifacts) {
    const key = `${reference.root}:${reference.path}`;
    if (paths.has(key)) throw new Error("EVIDENCE_CORRUPT: duplicate manifest reference");
    paths.add(key);
    checkedFile(artifactRoot, manifest.attempt_id, reference);
  }
  const required = [manifest.task_spec.artifact, manifest.git.diff, manifest.git.stat, manifest.git.changed_files, manifest.deterministic_gate.artifact, ...manifest.test_runs.flatMap(test => [test.result, test.stdout, test.stderr])];
  if (required.some(kind => !manifest.artifacts.some(reference => reference.kind === kind))) throw new Error("EVIDENCE_CORRUPT: missing required artifact");
  if (!Number.isSafeInteger(manifest.task_spec.revision) || manifest.task_spec.revision < 1 || !manifest.task_spec.approved_at || !/^[0-9a-f]{64}$/.test(manifest.task_spec.sha256)) throw new Error("EVIDENCE_CORRUPT: invalid TaskSpec identity");
  if (!manifest.run_ids.length || !manifest.test_runs.every(test => manifest.run_ids.includes(test.run_id))) throw new Error("EVIDENCE_CORRUPT: missing run identity");
};
