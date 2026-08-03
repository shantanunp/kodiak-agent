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
| 0 | registry/, GitHub MCP read | No |
| 1 | indexer/ (JavaParser), cache, scan orchestrator | No |
| 2 | translator/model/, ui/pipeline-viewer/ | Labeling only |
| 3 | Suggestion + PR creation (deferred) | Suggestion + PR creation |
| 4 | Shadow validation (deferred) | No |
| 5 | Audit logging (deferred) | Logging only |
| 6 | Rollout metrics | No |

**Do not add LLM calls to indexer/ or scanRepo.ts until Phase 2.**

## Language boundary

- **Java (`indexer/src/`)** — JavaParser AST walk only. No AI, no HTTP.
- **TypeScript (`src/`, `indexer/cli.ts`)** — orchestration, MCP, cache, polling.
- **Phase 2+ (`translator/model/`)** — LLM labeling of already-parsed constructs only.
  **Model provider** via `MODEL_API_KEY` + `MODEL_BASE_URL` + `MODEL_API_STYLE=gemini|openai`.
  Model name via `MODEL_NAME`, temperature defaults to `0`. Legacy `GEMINI_*` env aliases still work.

## Key commands

```bash
npm run build:indexer          # build JavaParser jar
npm run index-mappings         # index all registered mappers (local paths)
npm run read-source -- --path src/main/java/.../ExampleMapper.java
npm run latest-sha
npm run scan -- --mapper example-mapper
npm run scan:incremental
npm run poll
npm run label -- --mapper example-mapper   # Phase 2: model provider labels RAW steps
```

## Registry

All scanning is scoped by `registry/mapping-registry.yaml`. Never scan outside `scope` globs.
