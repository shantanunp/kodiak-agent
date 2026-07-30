# CLAUDE.md — Kodiak Agent

## What this is

Orchestrator for viewing and proposing changes to prod Java mapping logic. Java mapping
classes in GitHub are the source of truth.

## Core principle (non-negotiable)

**AI only touches translation/suggestion.** Discovery, parsing, and verification stay
deterministic and test-gated. Business users never get direct write access to prod code.

## Phase boundaries

| Phase | Component | AI allowed? |
|-------|-----------|-------------|
| 0 | registry/, validator/golden-dataset/, GitHub MCP read | No |
| 1 | indexer/ (JavaParser), cache, scan orchestrator | No |
| 2 | translator/labeler.ts, ui/pipeline-viewer/ | Labeling only |
| 3 | patcher/, pr-bot/ | Suggestion + PR creation |
| 4 | validator/shadow-runner.ts | No |
| 5 | audit/log-store.ts | Logging only |
| 6 | Rollout metrics | No |

**Do not add LLM calls to indexer/, scanRepo.ts, or validator/ until Phase 2.**

## Language boundary

- **Java (`indexer/src/`)** — JavaParser AST walk only. No AI, no HTTP.
- **TypeScript (`src/`, `indexer/cli.ts`)** — orchestration, MCP, cache, polling.
- **Phase 2+ (`translator/`)** — LLM labeling of already-parsed constructs only.
  **AI provider: Google Gemini Studio** (`GEMINI_API_KEY` from https://aistudio.google.com/apikey).
  Model pinned via `GEMINI_MODEL`, temperature defaults to `0`.

## Key commands

```bash
npm run build:indexer          # build JavaParser jar
npm run index-mappings         # index all registered mappers (local paths)
npm run read-source -- --path src/main/java/.../ExampleMapper.java
npm run latest-sha
npm run scan -- --mapper example-mapper
npm run scan:incremental
npm run poll
npm run golden:capture
npm run label -- --mapper example-mapper   # Phase 2: Gemini labels RAW steps only
```

## Registry

All scanning is scoped by `registry/mapping-registry.yaml`. Never scan outside `scope` globs.
