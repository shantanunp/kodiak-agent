# Kodiak Agent

Orchestrator for Java mapping discovery, indexing, and (future) pipeline visualization.

**Target mapping repo:** [shantanunp/Kmismomapper](https://github.com/shantanunp/Kmismomapper) (public)

## Quick start

```bash
cp .env.example .env          # GITHUB_TOKEN recommended (5000/hr vs 60/hr unauthenticated)
npm install
npm run build:indexer         # JavaParser shadow jar (needs JDK 21 — see note below)
npm run latest-sha            # HEAD SHA for Kmismomapper/main
npm run read-source -- --path src/main/java/com/kodiakservice/mapper/DemoAiRecognitionMapper.java --remote
npm run scan -- --mapper demo-ai-recognition-mapper --remote
npm run scan -- --mapper lpa-request-mapper --remote
npm run label -- --mapper demo-ai-recognition-mapper   # Phase 2: Gemini labels RAW steps
npm run scan:incremental      # re-scan only when main advances
npm run poll                  # poll every 15 min
```

Registered mappers (see `registry/mapping-registry.yaml`):

| ID | File | Notes |
|----|------|-------|
| `demo-ai-recognition-mapper` | `DemoAiRecognitionMapper.java` | Small canary — good first scan |
| `lpa-request-mapper` | `LpaRequestMapper.java` | Full LPA/MISMO mapping (~11k LOC) |

## JDK note for indexer build

Gradle requires JDK 21. If your system default is newer:

```bash
curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" | tar -xz -C .jdk --strip-components=1
npm run build:indexer
```

## Phase 0–1 scope (this delivery)

- `registry/mapping-registry.yaml` — scoped mapper list
- `indexer/` — JavaParser deterministic AST indexer (no AI)
- `validator/golden-dataset/` — ground-truth capture harness
- `src/mcp/githubClient.ts` — read-only GitHub via MCP + REST fallback
- `src/orchestrator/scanRepo.ts` — fetch → index → cache
- `src/orchestrator/incrementalScan.ts` — re-index changed files only
- `src/poll/cron.ts` — 15-minute poll (webhooks deferred)

## GitHub auth

Repo is **public** — unauthenticated reads work (60 requests/hour). For automated polling, add a fine-grained PAT with **Contents: Read-only** on [Kmismomapper](https://github.com/shantanunp/Kmismomapper):

```
GITHUB_TOKEN=ghp_...
```

## AI (Phase 2 — Gemini)

API key from [Google AI Studio](https://aistudio.google.com/apikey):

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-flash-latest
GEMINI_TEMPERATURE=0
```

Uses REST `generativelanguage.googleapis.com/v1beta/...:generateContent` with `X-goog-api-key`.

```bash
npm run label -- --mapper demo-ai-recognition-mapper
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for phase boundaries and the no-AI-in-discovery rule.
