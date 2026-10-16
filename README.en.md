<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cover-dark.svg" />
  <img src="docs/assets/cover-light.svg" alt="AgentPlatform · discontinued engineering case study" width="1280" />
</picture>

# AgentPlatform

[Portfolio](https://github.com/Daniel-24-life/AIfile)

**Discontinued · engineering and product case study · 2026-10-13**

AgentPlatform set out to take a product goal, have a lead agent plan and coordinate multiple agents, and deliver verified software. **That core experience was not achieved.** What remains is a controlled single-task execution path, a local desktop product workflow, and a formal product pilot that stopped before agent dispatch. This repository presents the code, the evidence boundary, and the reason for stopping.

[中文 README](README.md) · [Experience map](docs/EXPERIENCE_MAP.md) · [Architecture](docs/ARCHIVE_ARCHITECTURE.md) · [Data and interfaces](docs/ARCHIVE_DATA_INTERFACES.md) · [Engineering takeaways](docs/ENGINEERING_TAKEAWAYS.md) · [Retrospective](docs/PROJECT_RETROSPECTIVE.md)

[Read-only case study source](case-study/index.html) · [UI verification (Chinese)](docs/UI_QA.md)

![Read-only case study preview; project remains discontinued](docs/assets/case-study-desktop.png)

## The product promise and the observed result

![The product goal was saved, formal planning was blocked, and later product stages did not run](docs/assets/experience-gap.svg)

In the first formal desktop-app pilot, planning returned `RUNTIME_NOT_QUALIFIED`. There were **zero** model calls, development tasks, and agent runs. The [anonymized pilot](docs/PILOT_CASE_STUDY.md) explains the result. It is separate from the earlier controlled single-task acceptance.

## What was built

AgentPlatform is a Windows Electron prototype built with React, TypeScript, SQLite, Git worktrees, Codex CLI, JSON Schema, and Vitest. The platform controls process execution, tests, deterministic gates, and evidence instead of accepting an agent's completion claim as proof.

| Scope | Outcome at discontinuation |
| --- | --- |
| Single-task Git + Codex CLI kernel | One controlled functional path **passed**; broader runtime reliability remained **partial** |
| Local product workflow | Goal revisions, confirmed plans, a single linked task, bounded runs, static preview, and unpublished delivery were implemented and checked mainly offline |
| Real goal-to-product delivery | **Not run**; the first formal product pilot stopped at `RUNTIME_NOT_QUALIFIED` before agent dispatch |
| Dynamic multi-agent product coordination | **Not implemented**; Architect → Worker → Reviewer is a serial role sequence inside one task |
| Product advantage over existing tools | **Unproven**; no adequate real-product sample or controlled competitor comparison |

The primary reason for stopping was the missing core experience. The owner also judged that existing agent products, including Codex, already met their needs closely enough; extending this prototype risked turning it into an extra token intermediary. That is a product judgment, not a claim that all competing tools are equivalent.

## How the implemented task path works

![The platform owns the worktree, tests, gate, and evidence for a single task](docs/assets/trusted-task-path.svg)

A human approves the TaskSpec. The platform creates a managed worktree, runs the Codex Worker, starts the approved tests itself, checks the deterministic gate, and runs a read-only final review. The human receives a branch, diff, and evidence; the platform does not automatically commit, push, or merge. A worker's claim that tests passed is not test evidence. See the [architecture guide](docs/ARCHIVE_ARCHITECTURE.md) and [source reading guide](docs/SOURCE_READING_GUIDE.md).

## Product UI, with a clear evidence label

<img src="docs/assets/product-metrics-refined-synthetic.png" alt="Refined product history metrics UI, captured with a copy of the synthetic offline fixture; 100% means one of one linked tasks passed technically" width="847" />

This screenshot was captured on 2026-10-16 after a readability update to the existing React/Electron UI, using a copy of the Phase 1.34 **synthetic offline fixture**. It is not the formal pilot. Its 100% task pass rate means 1/1 linked fixture task reached a technical state; it does not mean a real product was delivered. The [original historical screenshot](docs/assets/product-metrics-synthetic-fixture.png) remains available for comparison. The [experience map](docs/EXPERIENCE_MAP.md) explains the UI, local connections, and missing capabilities.

## How to study it

1. Start with the [experience map](docs/EXPERIENCE_MAP.md) to distinguish the intended product journey, the implemented task path, and the blocked pilot.
2. Read the [architecture guide](docs/ARCHIVE_ARCHITECTURE.md) for the Renderer → Preload → Main boundary and the trusted task path.
3. Read [data and interfaces](docs/ARCHIVE_DATA_INTERFACES.md) and the [TaskSpec example guide](examples/README.md) for SQLite domains, typed IPC, and schema validation.
4. Follow the [source reading guide](docs/SOURCE_READING_GUIDE.md) into the orchestrator, Git adapter, deterministic gate, product services, and tests.
5. Compare the [anonymized pilot](docs/PILOT_CASE_STUDY.md), [verification record](docs/VERIFICATION_RECORD.md), and [retrospective](docs/PROJECT_RETROSPECTIVE.md). Detailed guides are currently in Chinese.

## Reproduce the offline checks

On Windows, install Node.js 22+, pnpm 10+, and Git. A real agent run also requires an independently installed and authenticated Codex CLI.

The static case study has no Electron or external-resource dependency. From the repository root, run `python -m http.server 4184 --bind 127.0.0.1` and visit <http://127.0.0.1:4184/case-study/>. Opening the HTML file directly also works. Run focused static checks with `pnpm test:case-study`. This public retrospective does not mean development resumed or the formal product pilot passed.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm dev
```

Build before testing: the static preview integration test starts the built local preview server. On the curated local repository, dependency installation, typecheck, lint, and build passed; the ordinary test suite reported **647 passed, 37 skipped, 0 failed** on 2026-10-13. These checks use temporary repositories and fake executables, with no real model calls. Historical real-runtime qualification scripts in `tests/manual/` need separate local evidence and are not a public one-command acceptance suite.

This repository does not contain user databases, raw sessions, managed worktrees, all historical runtime evidence, or Windows binaries. It is a technical case study, not a supported production platform. Code and documentation are available under the [MIT License](LICENSE).
