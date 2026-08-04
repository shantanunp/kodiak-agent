# First setup (Windows)

Get labeling working on a Windows laptop in a few steps. Use **PowerShell**.

---

## You need

| Tool                 | Version               |
| -------------------- | --------------------- |
| Node.js              | 20+                   |
| JDK                  | 17+ (`JAVA_HOME` set) |
| Gradle               | 8.x on `PATH`         |
| Mapper repo checkout | your Java mapper repo |


```powershell
node -v
java -version
gradle -v
echo $env:JAVA_HOME
```

Also clone your mapper repo so you can use `--worktree` and skip GitHub for daily work.

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

Defaults use OpenAI-compatible chat completions. Examples:

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

# GitHub Copilot (https://api.githubcopilot.com/chat/completions)
# MODEL_API_STYLE=copilot
# MODEL_BASE_URL=https://api.githubcopilot.com
# MODEL_NAME=gpt-4o
# MODEL_API_KEY=...   # or COPILOT_TOKEN / GITHUB_TOKEN
```

Then:

```powershell
npm install
npm run build:indexer
```

Office Artifactory / npm mirrors should already be configured on your laptop (same as other projects). This repo has **no** `gradlew`.

Edit `registry/mapping-registry.yaml` to point at your mapper repo and class files. Optionally add `registry/schemas/{mapperId}.schema.json`.

---

## Label a field (local worktree)

```powershell
npm run label -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName
```

Warm cache (same fingerprint):

```powershell
npm run label -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName
```

Clear caches:

```powershell
npm run cache:clear -- --mapper demo-ai-recognition-mapper
```

AST only (no AI):

```powershell
npm run ast -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo
```

---

## UI

```powershell
npm run ui:serve
# http://localhost:4173/pipeline-viewer/          # opens the most recently labeled mapper
# http://localhost:4173/pipeline-viewer/?mapper=<mapper-id>   # or pick one explicitly
```

**Build with AI (POC):**

1. Label one field first:
   ```powershell
   npm run label -- --mapper demo-ai-recognition-mapper `
     --worktree C:\Users\<you>\Workspace\your-mapper-repo `
     --fields Summary.displayName --no-cache
   ```
2. Open the viewer with that mapper/field.
3. Set `MAPPER_WORKTREE` in `.env` to the same checkout.
4. Describe a change and click **Build with AI**.

---

## Switch model provider

| Variable | Values |
| -------- | ------ |
| `MODEL_API_STYLE` | `openai`, `claude`, or `copilot` |
| `MODEL_BASE_URL` | API host (no trailing slash; copilot: `https://api.githubcopilot.com`) |

`STYLE` must match the endpoint shape (don’t point `claude` style at an OpenAI URL).

---

## Offline agent jobs (no model API / blocked office network)

`npm run label` now auto-detects when it can't reach the model API — no key set, **or**
the live call fails (blocked network/proxy) — and exports an offline job instead of just
erroring. It prints the job path and exact next steps, so you can usually just run your
normal `label` command and follow the printed instructions:

```powershell
npm run label -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName --no-cache
```

That prints something like:

```
Run this agent with this input:
  Job file: .cache\agent-jobs\demo-ai-recognition-mapper\<fingerprint>\job.json

1. Open that job.json in VS Code.
2. Ask Copilot Chat (agent mode): "Complete the offline label job in <jobFile>"
3. The agent writes <resultFile>
4. Then run label:import, then label --from-cache-only
```

Opening `job.json` (under `.cache/agent-jobs/**`) auto-attaches
`.github/instructions/kodiak-agent-label.instructions.md`, which tells Copilot Chat's agent
mode exactly how to fill in `result.json` — no external model API calls, no invented schema
paths. In Cursor, the equivalent rule lives at `.cursor/rules/kodiak-agent-label.mdc`.

You can also run each stage manually instead of relying on auto-fallback:

```powershell
npm run label:export -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName

# complete result.json via Copilot Chat (agent mode) / Cursor, then:

npm run label:import -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName

npm run label -- --mapper demo-ai-recognition-mapper `
  --worktree C:\Users\<you>\Workspace\your-mapper-repo `
  --fields Summary.displayName `
  --from-cache-only
```

---

## Checklist

- [ ] `npm install` && `npm run build:indexer`
- [ ] Registry points at your mapper repo
- [ ] `MODEL_API_KEY` (or style-specific key) in `.env`
- [ ] `npm run label -- --mapper … --worktree … --fields …`
- [ ] `npm run ui:serve` and open the pipeline viewer
