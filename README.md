# Kodiak Agent

Orchestrator for Java mapping discovery, indexing, and (future) pipeline visualization.

**Target mapping repo:** [shantanunp/Kmismomapper](https://github.com/shantanunp/Kmismomapper) (public)

## Quick start

```bash
cp .env.example .env          # GEMINI_API_KEY required for label; GITHUB_TOKEN optional
npm install
npm run build:indexer         # JavaParser shadow jar (needs JDK 21 — see note below)
```

Two independent commands (do not need to run both):


| Command         | Role                                      | AI? |
| --------------- | ----------------------------------------- | --- |
| `npm run ast`   | Deterministic Java AST (Java DTO paths)   | No  |
| `npm run label` | Index + Gemini → business/schema paths    | Yes (every field) |


```bash
# 1) AST only — local checkout, no AI
npm run ast -- --mapper lpa-request-mapper \
  --worktree /home/shantanu/Workspace/vscode/Kmismomapper

npm run ast -- --mapper lpa-request-mapper \
  --worktree /home/shantanu/Workspace/vscode/Kmismomapper \
  --fields MESSAGE.MISMOReferenceModelIdentifier

# 2) AI label — remote GitHub, or local worktree for unpushed mapper changes
npm run label -- --mapper lpa-request-mapper --remote

npm run label -- --mapper lpa-request-mapper \
  --worktree /home/shantanu/Workspace/vscode/Kmismomapper

npm run label -- --mapper lpa-request-mapper \
  --worktree /home/shantanu/Workspace/vscode/Kmismomapper \
  --fields MESSAGE.MISMOReferenceModelIdentifier,MESSAGE.DataVersionIdentifier

# Optional: filter by business/JSON field paths (omit = all mappings)
--fields MESSAGE.MISMOReferenceModelIdentifier,MESSAGE.DataVersionIdentifier
```

Prefer business `--fields` paths (`MESSAGE.…`). Leaf names and Java paths also match for filtering.

`npm run label` output is AI-owned business JSON: `mapperId` + `mapping` (schema paths like `MESSAGE.DEAL.PARTY.FirstName`, `applicant.displayName`) — no Java DTO envelope. `npm run ast` keeps Java paths for debugging.

Each `mapping` entry has a `pipeline` of ops (`READ`, `TRANSFORM`, `CONSTANT`, …). No `sourceText` / `children`.

After changing indexer Java, rebuild once: `npm run build:indexer`.

Registered mappers (see `registry/mapping-registry.yaml`):


| ID                           | File                           | Notes                                                      |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `demo-ai-recognition-mapper` | `DemoAiRecognitionMapper.java` | Small canary — best first check                            |
| `lpa-request-mapper`         | `LpaRequestMapper.java`        | LPA DTO mapper (helpers inlined; use `--fields` to filter) |




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
npm run label -- --mapper demo-ai-recognition-mapper --remote
```



## Schema builder

Define source/target structures before mapping. Saved to `registry/schemas/{mapperId}.schema.json`.

```bash
npm run ui:serve
```

- **Page 1:** [http://localhost:4173/structure-setup/?mapper=my-new-mapper](http://localhost:4173/structure-setup/?mapper=my-new-mapper)
- **Page 2 (manual build):** [http://localhost:4173/schema-builder/?mapper=my-new-mapper](http://localhost:4173/schema-builder/?mapper=my-new-mapper)
- **Viewer:** [http://localhost:4173/pipeline-viewer/?mapper=my-new-mapper](http://localhost:4173/pipeline-viewer/?mapper=my-new-mapper)

Export/import uses Kodiak JSON (`.schema.json`). Import also accepts JSON/XML samples, JSON Schema, and XSD.

```bash
npm run schema:validate -- registry/schemas/my-new-mapper.schema.json
```



## Pipeline viewer (optional)

After `label` looks right:

```bash
npm run view   # export demo mapper + serve
# → http://localhost:4173/pipeline-viewer/?mapper=demo-ai-recognition-mapper
```

Or: `npm run view:export -- --mapper lpa-request-mapper --label && npm run view:serve`

## Architecture

See [CLAUDE.md](./CLAUDE.md) for phase boundaries and the no-AI-in-discovery rule.

See [ABOUT.md](./ABOUT.md) for phase completion status and project overview.