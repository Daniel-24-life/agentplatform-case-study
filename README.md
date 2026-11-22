# AgentPlatform Case Study

A retrospective on a TypeScript/Electron prototype that delivered a bounded single-task execution path and fell short of its broader product goal.

[中文说明](README.zh.md) · [Portfolio](https://github.com/Daniel-24-life/AIfile)

![AgentPlatform history panel captured using a synthetic fixture](docs/assets/product-metrics-refined-synthetic.png)

## What it demonstrates

- Trace a task from its specification through workspace isolation, review, and evidence collection.
- Read the schema and SQLite interfaces used by the prototype.
- Compare the implemented technical path with the product experience left incomplete.

**Stack** · TypeScript, React, Electron, SQLite, pnpm

## Repository layout

| Path | Contents |
| --- | --- |
| [`case-study/`](case-study/) | Static retrospective |
| [`docs/`](docs/) | Architecture, interfaces, source reading and verification |
| [`examples/`](examples/) | Synthetic TaskSpec example |
| [`schemas/`](schemas/) | Contracts for tasks and results |

## Run locally

```sh
python -m http.server 4182 --bind 127.0.0.1 --directory case-study
```

Open `http://127.0.0.1:4182`. The verification record specifies the separate source and test paths.

## Scope and limits

The project is discontinued. The screenshot uses a synthetic offline fixture. It documents a technical task path and leaves production use and product acceptance unclaimed.

[Architecture](docs/ARCHIVE_ARCHITECTURE.md) · [Retrospective](docs/PROJECT_RETROSPECTIVE.md) · [Verification](docs/VERIFICATION_RECORD.md)
