# First setup (Windows)

Get labeling working on a Windows laptop in a few steps. Use **PowerShell**.

---

## You need

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| JDK | 17+ (`JAVA_HOME` set) |
| Gradle | 8.x on `PATH` |
| Mapper repo checkout | e.g. `Kmismomapper` |

```powershell
node -v
java -version
gradle -v
echo $env:JAVA_HOME
```

Also clone the mapper repo (e.g. `Kmismomapper`) so you can use `--worktree` and skip GitHub for daily work.

---

## Setup once

```powershell
cd C:\Users\<you>\Workspace\kodiak-agent
Copy-Item .env.example .env
notepad .env
```

Minimum in `.env`:

```env
MODEL_API_KEY=your-key
```

Defaults use Google Gemini. For OpenAI-compatible or Claude:

```env
# OpenAI / office gateway
MODEL_API_STYLE=openai
MODEL_BASE_URL=https://your-gateway/v1
MODEL_NAME=gpt-4o-mini
MODEL_API_KEY=your-key

# Anthropic Claude (also accepts ANTHROPIC_API_KEY)
# MODEL_API_STYLE=claude
# MODEL_BASE_URL=https://api.anthropic.com/v1
# MODEL_NAME=claude-sonnet-4-5
# MODEL_API_KEY=sk-ant-...
```

Then:

```powershell
npm install
npm run build:indexer
```

Office Artifactory / npm mirrors should already be configured on your laptop (same as other projects). This repo has **no** `gradlew`.

---

## Daily commands

Replace the worktree path with your mapper checkout.

**Label one field** (AI discovery on; AST off by default):

```powershell
npm run label -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.COLLATERAL.AddressLineText
```

**Same, with AST confidence** (optional):

```powershell
npm run label -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.COLLATERAL.AddressLineText `
  --with-ast
```

**Clear cache** (if results look stale):

```powershell
npm run cache:clear -- --mapper lpa-request-mapper
```

**Inspect Java AST only** (no AI):

```powershell
npm run ast -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper
```

**Local UI** (optional):

```powershell
npm run ui:serve
# http://localhost:4173/pipeline-viewer/?mapper=lpa-request-mapper
```

Tips:

- Prefer `--fields` so you don’t burn quota labeling everything.
- Prefer `--worktree` over `--remote` (no GitHub needed).
- Second label run should show `"cacheHit": true` unless you pass `--no-cache`.

---

## Switch model provider

| Env var | Meaning |
|---------|---------|
| `MODEL_API_KEY` | Required |
| `MODEL_API_STYLE` | `gemini`, `openai`, or `claude` |
| `MODEL_BASE_URL` | API host (no trailing slash) |
| `MODEL_NAME` | Model id |

`STYLE` must match the endpoint shape (don’t point `gemini` style at an OpenAI URL).

---

## Offline (no model API)

When the office blocks Gemini/OpenAI:

```powershell
npm run label:export -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName

# Open .cache\agent-jobs\...\job.json in Cursor → write result.json

npm run label:import -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName

npm run label -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName `
  --from-cache-only
```

---

## Point at another mapper

1. Edit `registry/mapping-registry.yaml` (`repo`, `scope`, `mappers` entry).
2. Optional: add `registry/schemas/<mapper-id>.schema.json`.
3. Run with `--worktree` to that repo root (folder that contains `src\main\java\...`).

```powershell
npm run label -- --mapper my-test-mapper `
  --worktree C:\Users\<you>\Workspace\MyMapperRepo `
  --fields <business.field.Path>
```

---

## Checklist

- [ ] Node 20+, JDK 17+, Gradle on PATH  
- [ ] `.env` has `MODEL_API_KEY`  
- [ ] `npm install` && `npm run build:indexer`  
- [ ] Mapper repo on disk  
- [ ] `npm run label -- … --worktree … --fields …` returns a pipeline  
