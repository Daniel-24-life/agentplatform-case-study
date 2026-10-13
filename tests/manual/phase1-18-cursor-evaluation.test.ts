import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateCursorReadonlyTrace } from "../../src/shared/core/cursor-readonly-qualification.js";

const root = path.resolve("cursor-wsl-readonly-run3");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("Phase 1.18 sealed real trace evaluation", () => {
  it.skipIf(process.env.PHASE118_EVALUATE !== "1")("evaluates exactly the approved run3 evidence", () => {
    expect(existsSync(root)).toBe(true);
    const readinessBytes = readFileSync("docs/PHASE_1_18_CURSOR_READONLY_READINESS.json");
    const readinessSha = "143f1a76b0d795001e1758c69b4dfb556ba9c8cd1b7c9cf3f1a3ea174d410e8f";
    expect(sha(readinessBytes)).toBe(readinessSha);
    const readiness = JSON.parse(readinessBytes.toString("utf8")) as {
      fixture: { path: string; marker_sha256: string; manifest_sha256: string };
      evidence: { output_root: string };
    };
    expect(path.resolve(readiness.evidence.output_root)).toBe(root);
    const controller = JSON.parse(readFileSync(path.join(root, "controller.json"), "utf8")) as {
      state: string; request_sha256: string; process_exit_code: number | null;
      duration_ms: number; process_converged: boolean; stderr_bytes: number; stdout_bytes: number;
      fixture_sha256_before: string; fixture_sha256_after: string;
    };
    expect(controller.request_sha256).toBe(readinessSha);
    const stdout = readFileSync(path.join(root, "stdout.ndjson"));
    const stderr = readFileSync(path.join(root, "stderr.raw"));
    expect(stdout.length).toBe(controller.stdout_bytes);
    expect(stderr.length).toBe(controller.stderr_bytes);
    const decision = evaluateCursorReadonlyTrace({
      stdout: stdout.toString("utf8"), stderrBytes: stderr.length,
      exitCode: controller.state === "process_exited" ? controller.process_exit_code : null,
      durationMs: controller.duration_ms, processConverged: controller.process_converged,
      fixtureRoot: readiness.fixture.path, expectedFixtureSha256: readiness.fixture.manifest_sha256,
      fixtureSha256Before: controller.fixture_sha256_before,
      fixtureSha256After: controller.fixture_sha256_after,
      expectedMarkerFileSha256: readiness.fixture.marker_sha256
    });
    const events = stdout.toString("utf8").trimEnd().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    const terminal = events.at(-1);
    const usage = terminal?.usage ?? null;
    const evaluation = {
      contract: "phase1-18-cursor-readonly-contract-readiness.v1",
      decision, request_sha256: readinessSha, stdout_sha256: sha(stdout), stderr_sha256: sha(stderr),
      event_count: events.length, event_types: events.map(event => event.type), usage
    };
    writeFileSync(path.join(root, "run-evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`, { flag: "wx" });
    expect(decision.status).toBe("PASS");
  });
});
