> Showcase copy: one historical local workspace path has been redacted. The original plan is preserved in the private project archive; this copy is included as an offline test input, not as current execution authorization.

# Phase 1.6 WP5 — Sealed Runtime Certification Execution Plan

Status: **WP5-A IMPLEMENTATION PASS / SEALED PREPARATION AUTHORIZED / WP5-B REAL EXECUTION NOT AUTHORIZED**
Date: 2026-09-22 (Asia/Shanghai)
Original authoritative workspace: `[local path redacted in showcase]`

## 1. Decision requested

This plan governs only WP5: one sealed, bounded, read-only Runtime Certification
of the Phase 1.5 bounded prepared-context `codex exec` candidate. It does not
authorize production routing, Builder/Reviewer calls, pilot use, WorkBuddy,
CodeBuddy, Cursor, another Provider, or any direct model API.

The independent audits found that the current sealed implementation is not safe to
execute unchanged. This plan therefore has two separate approval gates:

1. **WP5-A readiness hardening:** offline source/tests/evidence changes only, with
   zero real model calls, followed by a new preparation root and another audit.
2. **WP5-B real certification:** up to ten real calls only after WP5-A passes and
   the user approves the new prepared-manifest digest.

No real execution may begin until:

1. the independent plan audits in this document are complete;
2. every blocking audit finding has been fixed offline and independently retested;
3. the root Agent has reconciled the fixes and marked WP5-A `PASS`;
4. a new sealed preparation has been created without overwriting the current one;
5. the user explicitly approves the new sealed manifest digest and maximum of
   ten real calls.

## 2. Audited baseline and immutable behavioral contract

The current prepared manifest SHA-256 is
`50d240be46636e7c51c9742c46bae8dbe21236ddbfb9285b110996145508e617`.
It is preserved as an audit baseline but is **NOT EXECUTABLE** because the audit
found blocking source/evidence gaps. WP5-A source changes will intentionally make
its source digest stale. The current root must remain untouched; WP5-A uses a new
root named `phase1-6-evidence/preregistration-wp5-ready/`.

The following behavioral values remain fixed through WP5-A and WP5-B:

- candidate: bounded prepared-context `codex exec`;
- cases: exactly `P16-ARCH-01` through `P16-ARCH-10`, in order;
- model: `gpt-5.6-sol`;
- reasoning: `medium`;
- sandbox: `read-only`;
- approval policy: `never`;
- internal Codex multi-agent: disabled;
- application retry: `0`;
- human intervention after launch: `0`;
- per-case timeout: `300000` ms;
- termination/stdio cleanup ceiling: `10000` ms;
- maximum model calls: `10`;
- real output root: `phase1-6-runtime-certification-run1/`;
- Codex version: `codex-cli 0.151.0`;
- Codex executable SHA-256:
  `cf68265897197ac5f3bff6a10c168eec159842b353129726da5e3ed6b91ef0f4`;
- audited pre-hardening source digest:
  `593dbd2bbdff1e794a27ae6fd78181294317d29d4e85d57eb97a990ef21f8a68`
  (historical after WP5-A; never reuse it for execution).

WP5-A may change only the safety/evidence implementation listed in §4.1. It may not
change cases, prompts, model, reasoning, timeout, cleanup, retry/intervention rules
or PASS semantics. Never edit a sealed artifact in place.

## 3. Agent ownership and separation of duties

### Root/main Agent

The root Agent is the only execution owner and the only Agent allowed to:

- reconcile audit findings and decide whether the entry gate is satisfied;
- present the final approval request to the user;
- set the real-run environment variables and launch the single approved command;
- observe call count and stop conditions without altering the request;
- classify the aggregate result and publish the final phase decision;
- seal evidence and update handoff documents.

The root Agent must not delegate the launch, retry a case, repair an in-flight
fixture, reinterpret a fatal result, or delegate the final conclusion.

### 5.6 Luna audit Agents

Before approval, three bounded, read-only audits run independently:

1. **Execution-gate auditor:** verifies the command, double opt-in, executable and
   manifest identity checks, fresh-root rejection and zero-model preflight order.
2. **Evidence/decision auditor:** verifies per-case persistence, evaluator semantics,
   fail-fast behavior, missing-case treatment and final sealing requirements.
3. **Scope/safety auditor:** verifies call ceiling, timeout/cleanup bounds, no retry,
   no human intervention, credential redaction, protected roots and Provider scope.

Audit Agents may read source and sealed evidence and report findings. They may not
edit frozen source, run Codex, check login/account state, create the real output
root, modify fixtures or issue the final decision.

After execution, Luna Agents may perform bounded read-only evidence cross-checks if
requested by the root Agent. Their reports are advisory; root acceptance remains
authoritative.

### WP5-A implementation ownership after plan approval

The root Agent assigns non-overlapping, file-bounded work to 5.6 Luna:

1. **Runtime/log owner:** optional hash-only process logging and tests. Raw
   stdout/stderr must not be persisted by WP5-B.
2. **Executor/evidence owner:** Git tree capture, result/case manifests, artifact
   hash verification, absolute source path and manifest-version checks.
3. **Harness/failure owner:** guarantee a terminal failure sample and aggregate
   decision even when the executor throws after launch; add preflight-failure
   evidence outside the absent real-run root.
4. **Independent auditors:** re-run the three read-only audits against the completed
   changes and new preparation.

The root Agent owns integration, resolves overlap, runs the complete offline gate,
creates the new zero-call preparation, verifies its digest and makes the final
WP5-A decision. No child Agent may prepare or launch WP5-B.

## 4. Entry gate before WP5-B user approval

The root Agent must verify and record all of the following without invoking Codex:

- all three independent plan audits are complete with no unresolved blocking issue;
- `phase1-6-runtime-certification-run1/` does not exist;
- `phase1-6-evidence/preregistration-wp5-ready/prepare-manifest.json` has the new
  user-reviewed SHA-256;
- every file in the new WP5-ready source manifest matches it;
- all ten fixture repositories match their base SHA/tree and are clean;
- preregistration, human-readable preregistration, baseline, plan and schemas match;
- the pinned executable file exists and its SHA-256 matches;
- protected Phase 1.2–1.5 evidence remains unchanged;
- the normal offline gates remain green or no relevant file changed after their last
  successful run;
- no credential value is present in the proposed command or saved plan.

The entry gate is binary. A missing check is a blocker, not a warning.

## 4.1 WP5-A blocking hardening work

After the user approves this plan—but before any real-call approval—the following
offline work is mandatory:

1. **No raw runtime logs:** add a Phase 1.6-selected hash-only logging mode. The
   runner continues streaming SHA-256 and bounded in-memory parsing, but does not
   create raw `stdout.log`/`stderr.log` for WP5-B. Structured evidence stores only
   approved redacted fields and hashes. Default production behavior outside this
   certification must remain unchanged.
2. **Strict entry identity:** reject a missing or relative
   `PHASE1_6_SOURCE_ROOT`; explicitly require preparation manifest version
   `phase1.6-preparation.v2` (or a newly versioned successor) before use.
3. **Complete Git identity:** capture and compare both `HEAD` and `HEAD^{tree}`
   before and after every case, plus clean status/diff.
4. **Artifact integrity:** hash the TaskSpec/result, structured execution evidence
   and case manifest after writing; record stdout/stderr stream hashes from the
   process result. Re-read and verify the case manifest before marking
   `hashesValid`. The root post-run acceptance rehashes all artifacts again.
5. **Exception terminalization:** wrap each launched executor call so any thrown
   error still produces a sanitized failure artifact, a complete failure sample and
   an aggregate `decision.json`, then stops with no further call.
6. **Account-preflight failure evidence:** when zero-model `login status` fails,
   keep the real output root absent but write a sanitized, append-once failure record
   under a fresh Phase 1.6 evidence subroot. Never persist account text.
7. **Protected roots:** reject equality or containment beneath every sealed Phase
   1.2–1.6 evidence/runtime root, using resolved absolute paths.
8. **Call-count invariant:** before each launch require recorded launched calls to
   be below both the registered population and the hard maximum of ten.
9. Add focused negative tests for credential-like output, relative source root,
   manifest version drift, tree drift, artifact corruption, evidence-write failure,
   executor throw and the eleventh-call boundary.

WP5-A completion requires focused tests, typecheck, lint, the standard full suite
and build to pass with zero real calls. Then create a fresh
`preregistration-wp5-ready/`, report its new digest and repeat all three independent
audits. The old preregistration remains preserved and labeled non-executable.

## 5. Explicit user approval gate

After WP5-A completion and repeat audit, the root Agent presents:

- this plan and its SHA-256;
- the prepared-manifest SHA-256;
- the fixed maximum call count and worst-case bounded duration;
- confirmation that account status has not yet been queried and no real call has
  occurred;
- all remaining risks and any non-blocking audit observations.

Approval must explicitly authorize WP5-B, the displayed new prepared-manifest
digest and up to ten real calls. General phrases such as “continue” from an earlier
phase do not satisfy this gate. The internal execution variable is fixed exactly as
`PHASE1_6_EXECUTION_APPROVAL=I_APPROVE_10_REAL_CALLS`; the root Agent may set it only
after receiving that explicit WP5-B authorization.

## 6. Zero-model execution preflight

Only after approval, the approved execution entry point performs these checks in
order before the first model call:

1. require both `RUN_PHASE1_6_RUNTIME=1` and the exact execution-approval phrase;
2. require absolute preparation, source and output paths;
3. require the user-reviewed prepared-manifest SHA-256;
4. explicitly require the approved preparation-manifest protocol version;
5. run only `codex --version` and require the pinned version;
6. revalidate plan, source, schemas, registration, fixture contents, Git base/tree,
   executable SHA-256 and protected output-root boundaries;
7. require the real output root still not to exist;
8. run `codex login status` as a zero-model account-availability check;
9. persist only hashes/status from account preflight, never account details.

Any preflight failure ends WP5 with zero model calls and status `BLOCKED`. Do not
repair or retry inside the approved run.

## 7. Approved launch shape

The root Agent launches exactly one `pnpm phase1-6:execute` process from the
authoritative workspace with:

- `PHASE1_6_SOURCE_ROOT` set to the authoritative workspace;
- `PHASE1_6_PREPARATION_ROOT` set to the sealed preregistration root;
- `PHASE1_6_OUTPUT_ROOT` set to the fresh run1 root;
- `PHASE1_6_PREPARE_MANIFEST_SHA256` set to the approved digest;
- both explicit execution opt-in variables set exactly as reviewed.

No other runtime/model/timeout/case-order override is allowed. The full command is
recorded with variable names and redacted values; credential values are never
recorded.

Worst-case model runtime is 50 minutes for ten 300-second cases, plus at most 100
seconds of bounded cleanup. Test-runner allowance is 3,100,000 ms. Actual completion
may be earlier because the run stops on the first fatal case.

## 8. Per-case execution and persistence

For each registered case, in order:

1. confirm its fixture is at the registered base and clean;
2. reconstruct only the registered bounded context;
3. launch one read-only Architect request with fixed model/reasoning/timeout;
4. stream stdout/stderr only into bounded parsing and SHA-256 calculation; do not
   persist raw stdout/stderr logs;
5. persist sanitized structured process, terminal, transport, schema, semantic,
   usage, Git and hash evidence;
6. persist and verify a case artifact manifest covering TaskSpec/result and
   structured evidence;
7. persist `sample.json` before evaluating whether to continue, including when the
   executor throws after launch;
8. evaluate with the model-free certification evaluator;
9. continue only when the launched case has no fatal failure and the recorded call
   count remains below ten.

No missing usage value alone causes failure. Missing authoritative completion,
schema/semantic failure, timeout, process/stdio non-convergence, fixture drift,
hash drift, authentication/account failure, protocol ambiguity, retry or human
intervention prevents Runtime PASS.

## 9. Immediate stop conditions

Stop without another call on any of the following:

- timeout, cancellation or fatal process failure;
- cleanup exceeding 10 seconds or non-converged process/stdio;
- missing/failed/malformed authoritative terminal event;
- schema or semantic invalidity;
- fixture write, dirty status, base/tree drift or evidence-hash drift;
- authentication, account, quota or model-availability failure;
- credential exposure or unexpected protected-root write;
- manifest, source, executable, plan, schema, prompt or context drift;
- unknown/duplicate/reordered case or protocol ambiguity;
- user cancellation or host interruption.

Unstarted cases remain `NOT_RUN`. An interrupted/partial root is preserved and is
never resumed, overwritten or deleted. A new attempt requires a new plan, approval
and output root.

## 10. Decision rules

Runtime is `PASS` only if all ten cases launch exactly once and independently meet
every registered condition. There is no partial PASS.

- Runtime failure in a launched case: aggregate `FAIL`.
- Preregistration/auth/account blocker before a valid complete population:
  aggregate `BLOCKED`.
- No launched case: `NOT_RUN` unless the evaluator records a preregistration blocker.
- Missing/unstarted cases after any launch: never `PASS`.

Architecture, Runtime, Transport, Product, Pilot and External-Agent statuses must be
reported separately. Runtime PASS authorizes only a later architecture decision;
it does not authorize production migration or Provider work.

## 11. Post-run root-Agent acceptance

The root Agent performs a read-only acceptance pass:

- reconcile launched-call count with case directories and samples;
- verify every stdout/stderr stream hash and every persisted structured artifact
  hash; confirm raw runtime log files do not exist;
- recheck every fixture and protected evidence root;
- confirm the decision matches the model-free evaluator;
- record usage when available without inventing missing totals or cost;
- hash and seal the complete run root and final evaluation;
- update `PHASE_1_6_RUNTIME_EVALUATION.md`, handoff and next-session brief;
- report known risks, unstarted cases and any interruption exactly.

No source, fixture, prompt, schema or result may be edited to improve the outcome.

## 12. Rollback and recovery policy

There is no destructive rollback. Before the first call, a blocked preflight leaves
the real output root absent. After root creation or any launch, all partial evidence
is retained append-only. Recovery means documenting the stop and opening a new
decision; it never means deleting, resuming, retrying or relabeling the run.

## 13. External-Agent boundary

WorkBuddy/CodeBuddy and Cursor remain `NOT_STARTED`. WP5 neither installs nor calls
them and does not add a Provider registry. If bounded exec Runtime later passes, a
separate architecture decision may authorize one Provider qualification phase at a
time behind the existing `AgentAdapter`/Router boundary.

## 14. Audit record

Initial independent audits are complete. They establish that WP5-B must not use the
current sealed implementation.

- Execution-gate audit: `BLOCKING` — relative source root accepted; explicit
  manifest-version check absent.
- Evidence/decision audit: `BLOCKING` — result/case hashes and Git tree incomplete;
  executor throw can bypass sample/decision persistence.
- Scope/safety audit: `BLOCKING` — raw logs can persist credential-like output;
  execution-approval literal was not documented.
- Root reconciliation: `COMPLETE` — all findings mapped to mandatory WP5-A work in
  §4.1; current prepared manifest marked non-executable.
- Revised execution-gate plan audit: `PLAN_PASS`.
- Revised evidence/decision plan audit: `PLAN_PASS`.
- Revised scope/safety plan audit: `PLAN_PASS`.
- Root plan acceptance: `PASS` — all initial blocking findings have an explicit
  owner, implementation requirement, negative test and re-audit gate; no finding is
  waived or reclassified as a warning.
- User WP5-A approval: `APPROVED` on 2026-09-21; approval is limited to offline
  safety hardening with zero real model calls.
- WP5-A runtime/entry repeat audit: `PASS` — double gate, absolute roots, protected
  roots, preflight failure evidence and hard ten-call ceiling verified.
- WP5-A evidence repeat audit: `PASS` after remediation — raw logs disabled for the
  certification path; executor, terminal-event and transport diagnostics are
  redacted; result/evidence hashes and fatal sample/decision persistence verified.
- WP5-A scope/preparation pre-seal audit: `BLOCKED_ONLY_ON_EXPECTED_SEQUENCE` — no
  code or scope defect found; final PASS requires the new non-overwriting
  `preregistration-wp5-ready/` root and a post-seal identity audit.
- Root WP5-A implementation acceptance: `PASS` — focused offline tests, full test
  suite, typecheck, lint and build passed with no real model call. The plan is now
  frozen for the new preparation manifest.
- User WP5-B real-call approval: `NOT_REQUESTED`; may be requested only after WP5-A
  passes, a new preparation digest exists and repeat audits pass.
