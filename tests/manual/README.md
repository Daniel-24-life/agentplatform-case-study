# Historical manual qualification harnesses

These files preserve how AgentPlatform prepared and checked controlled runtime experiments. They are source material for understanding the safety boundary; they are **not** a one-command acceptance suite for a new machine or a supported way to resume the discontinued project.

| Group | What it records | What is missing from this showcase |
| --- | --- | --- |
| `phase1-3` through `phase1-11` | Read-only Architect qualification, sealed fixtures, bounded real-call attempts, and a controlled single-task end-to-end run | Original approval registrations, raw runtime evidence and the qualified local CLI/account state |
| `phase1-18` and `phase1-19` | Cursor/WSL read-only and proposal experiments | Registered WSL environment, readiness files, original evidence roots and approved executable identities |
| `phase1-22` | Product-planning qualification attempts | Original product approval and account/runtime qualification state |
| `phase1-27` through `phase1-34` | Isolated UI and metrics fixtures | Historical evidence-root registration and packaged app state |

`pnpm test` runs the offline-safe cases and skips tests whose explicit conditions are absent. The curated repository's final result is recorded in [the verification note](../../docs/VERIFICATION_RECORD.md). Skipped historical real-runtime tests are **not passing results**. Do not enable a historical environment flag or copy an old approval phrase to initiate model calls: the original approvals were bound to specific files, identities, budgets and evidence roots.

The Phase 1.6 plan in [`docs/`](../../docs/PHASE_1_6_WP5_EXECUTION_PLAN.md) is a copy with a historical local path redacted, retained because an offline hash-verification test reads it. It is not a current authorization. Four manual scripts tied only to local CodeBuddy/Cursor installations or omitted evidence were excluded from this showcase; the originals remain in the private project archive.
