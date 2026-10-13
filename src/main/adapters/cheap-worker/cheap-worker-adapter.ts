import { CodexAdapter } from "../codex/codex-adapter.js";
import type { AgentExecution, WorkerAgentAdapter, WorkerInput } from "../agent-adapter.js";
import type { WorkerResult } from "../../../shared/core/worker-result.js";

/** The Phase 1 low-cost worker transport: local codex exec with a separate identity. */
export class CheapWorkerAdapter implements WorkerAgentAdapter {
  readonly id = "cheap-worker";
  private readonly codex: CodexAdapter;

  constructor(program = "codex", prefixArgs: string[] = []) {
    this.codex = new CodexAdapter(program, prefixArgs);
  }

  async runWorker(input: WorkerInput): Promise<AgentExecution<WorkerResult>> {
    return this.codex.runWorker(input);
  }
}
