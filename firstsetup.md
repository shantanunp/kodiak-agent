# First setup (Windows)

Quick guide after you check out this repo on a **Windows** laptop: install, run locally, and where to change the AI model provider.

Use **PowerShell** or **Git Bash**. Examples below use PowerShell unless noted.

---

## 1. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | ≥ 20 | App / CLIs — [nodejs.org](https://nodejs.org) LTS |
| JDK | 17+ (21 preferred) | Build JavaParser indexer — Temurin/Oracle, set `JAVA_HOME` |
| Git for Windows | any | Checkout repos + optional Git Bash |

Also clone the **mapper** repo locally (e.g. `Kmismomapper`) so you can use `--worktree` and avoid needing GitHub for daily runs.

**Check installs:**

```powershell
node -v          # v20+
npm -v
java -version    # 17+
echo $env:JAVA_HOME
```

If `java` works but Gradle fails, set `JAVA_HOME` to your JDK folder, e.g.:

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.x.x-hotspot"
```

(Or set it permanently in System Properties → Environment Variables.)

---

## 2. One-time setup

```powershell
cd C:\Users\<you>\Workspace\kodiak-agent   # your checkout path
Copy-Item .env.example .env
notepad .env   # or open in VS Code / Cursor
```

Edit `.env` (same format on Windows; no quotes needed for simple values):

```env
# Required for npm run label
GEMINI_API_KEY=your-key-from-aistudio.google.com

# Optional (defaults shown)
GEMINI_MODEL=gemini-flash-latest
GEMINI_TEMPERATURE=0
# GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com

# Optional — only if you use --remote / scan / poll
# GITHUB_TOKEN=ghp_...
```

Then:

```powershell
npm install
npm run build:indexer
```

`build:indexer` runs Gradle under `indexer\`. First run downloads dependencies (needs Maven Central).

**Network allowlist (if outbound traffic is restricted):**

| Host | Needed for |
|------|------------|
| `registry.npmjs.org` | `npm install` (once) |
| Maven Central | `npm run build:indexer` (once) |
| `generativelanguage.googleapis.com` | `npm run label` |
| `api.github.com` | only if you use `--remote` / scan |

Prefer `--worktree` so you do **not** need GitHub daily.

---

## 3. How to run

Use a **Windows path** for the mapper checkout. Forward slashes often work in Node; backslashes are fine if quoted.

Example mapper path: `C:\Users\<you>\Workspace\Kmismomapper`

### A) AST only (no AI, no GitHub)

```powershell
npm run ast -- --mapper lpa-request-mapper --worktree C:\Users\<you>\Workspace\Kmismomapper
```

### B) Label one field (needs Gemini; uses local Java)

```powershell
npm run label -- --mapper lpa-request-mapper --worktree C:\Users\<you>\Workspace\Kmismomapper --fields MESSAGE.DEAL.PARTY.FirstName
```

- First run may call Gemini once (with `--fields`, AI discovery is off by default).
- Second run should hit field cache (`"cacheHit": true`).
- Cache files land under `.\.cache\` in the project folder.

### C) Clear caches if something looks stale

```powershell
npm run cache:clear
npm run cache:clear -- --mapper lpa-request-mapper
```

### D) Optional local UI

```powershell
npm run ui:serve
# Browser: http://localhost:4173/structure-setup/?mapper=lpa-request-mapper
```

### Avoid if network is restricted

- `--remote`, `npm run scan`, `npm run poll` → GitHub  
- Labeling **all** fields with no `--fields` → many Gemini calls / quota burn  

### E) Point at another repo / mapper to test

Scanning is scoped by [`registry/mapping-registry.yaml`](registry/mapping-registry.yaml). You never index arbitrary paths outside that registry + `--worktree` / remote checkout.

#### Option 1 — Same registered mapper, different local folder

Use any local clone of the mapper repo; only `--worktree` changes:

```powershell
npm run ast -- --mapper lpa-request-mapper --worktree D:\code\Kmismomapper-fork
npm run label -- --mapper lpa-request-mapper --worktree D:\code\Kmismomapper-fork --fields MESSAGE.DEAL.PARTY.FirstName
```

`--worktree` must be the **repo root** (the folder that contains `src\main\java\...` as listed in `sourceFile`).

#### Option 2 — Different GitHub repo (remote)

1. Edit `registry/mapping-registry.yaml`:
   - `repo: "owner/other-repo"`
   - `branch: "main"` (or your branch)
   - `scope:` globs for mapper Java files
2. Keep or add a `mappers:` entry with correct `sourceFile`, `class`, `entryMethod`, `sourceType`, `targetType`.
3. Run with remote (needs `api.github.com` + optional `GITHUB_TOKEN`):

```powershell
npm run label -- --mapper <your-mapper-id> --remote
```

#### Option 3 — New mapper class (local test)

1. Clone the target Java repo locally.
2. Add a mapper block under `mappers:` in `registry/mapping-registry.yaml`, for example:

```yaml
  - id: my-test-mapper
    sourceFile: src/main/java/com/example/mapper/MyMapper.java
    class: com.example.mapper.MyMapper
    entryMethod: map
    sourceType: com.example.dto.Source
    targetType: com.example.dto.Target
```

3. Update top-level `repo` / `scope` if the paths or GitHub repo differ.
4. Optional: add `registry/schemas/my-test-mapper.schema.json` so label uses business field paths.
5. Run:

```powershell
npm run ast -- --mapper my-test-mapper --worktree C:\Users\<you>\Workspace\MyMapperRepo
npm run label -- --mapper my-test-mapper --worktree C:\Users\<you>\Workspace\MyMapperRepo
```

Clear cache after switching repos/mappers if results look mixed:

```powershell
npm run cache:clear -- --mapper my-test-mapper
```

### Windows tips

| Topic | Note |
|-------|------|
| Line breaks in PowerShell | Use `` ` `` at end of line, or keep the command on one line (as above) |
| Git Bash | Same `npm` commands; paths like `/c/Users/.../Kmismomapper` also work |
| Antivirus | First `npm install` / Gradle may be slow if Defender scans `node_modules` |
| Execution policy | If scripts are blocked: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Proxy | If corporate proxy: set `HTTP_PROXY` / `HTTPS_PROXY` / `npm config set proxy ...` per IT |

---

## 4. Change model / AI provider

Today the app is wired to **Google Gemini Studio** only. Changing `GEMINI_MODEL` only switches Gemini models — it does **not** switch to Copilot / OpenAI.

### Env-only (same provider: Gemini)

| Variable | File | Effect |
|----------|------|--------|
| `GEMINI_API_KEY` | `.env` | API key |
| `GEMINI_MODEL` | `.env` | e.g. `gemini-flash-latest`, `gemini-2.0-flash` |
| `GEMINI_TEMPERATURE` | `.env` | default `0` |
| `GEMINI_API_BASE_URL` | `.env` | default `https://generativelanguage.googleapis.com` |

Loaded in [`translator/config.ts`](translator/config.ts).

### Files involved in the AI call path

| File | Role |
|------|------|
| [`.env`](.env) / [`.env.example`](.env.example) | Keys and model name |
| [`translator/config.ts`](translator/config.ts) | Reads env → `loadGeminiConfig()` |
| [`translator/geminiProvider.ts`](translator/geminiProvider.ts) | HTTP call to Gemini (`generateContent`) |
| [`translator/labeler.ts`](translator/labeler.ts) | Builds `GeminiLabelProvider`, runs label / cache |
| [`translator/discoverMerge.ts`](translator/discoverMerge.ts) | Optional AI discovery (skipped by default with `--fields`) |
| [`translator/cli.ts`](translator/cli.ts) | `npm run label` entry; checks `isGeminiConfigured()` |

**Actual API call** (Gemini REST):

```text
POST {GEMINI_API_BASE_URL}/v1beta/models/{GEMINI_MODEL}:generateContent
Header: X-goog-api-key: {GEMINI_API_KEY}
```

in `GeminiLabelProvider.generateContent()` inside `translator/geminiProvider.ts`.

### To switch to another provider (e.g. Copilot / OpenAI)

Not supported out of the box. You would need to:

1. Add a new provider module (e.g. `translator/openaiProvider.ts` or `copilotProvider.ts`) that implements the same methods:
   - `labelFieldMapping(...)`
   - `discoverMappings(...)`
   - (optional) `labelStep(...)`
2. Return the **same JSON shapes** as today’s Gemini responses (see types in `geminiProvider.ts`).
3. Add env vars (e.g. `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL`) in `.env` / `.env.example`.
4. Change [`translator/config.ts`](translator/config.ts) (or add `translator/aiConfig.ts`) to load the right provider.
5. Change [`translator/labeler.ts`](translator/labeler.ts) to construct the new provider instead of hard-coding `GeminiLabelProvider`.
6. Update [`translator/cli.ts`](translator/cli.ts) “API key missing” check for the new env var.
7. Document the new host in IT allowlist (e.g. `api.openai.com` or your Copilot/Azure endpoint).

**Do not** only change `GEMINI_MODEL` to a Copilot/OpenAI model name — the request still goes to Google’s URL and will fail.

---

## 5. Quick checklist (Windows)

- [ ] `node -v` ≥ 20, `java -version` 17+, `JAVA_HOME` set if needed  
- [ ] `Copy-Item .env.example .env` + set `GEMINI_API_KEY`  
- [ ] `npm install` && `npm run build:indexer`  
- [ ] Mapper repo on disk (e.g. `C:\Users\...\Kmismomapper`)  
- [ ] `npm run ast -- --mapper … --worktree C:\...\Kmismomapper` works  
- [ ] `npm run label -- … --worktree … --fields …` works (Gemini allowed)  
- [ ] Know how to point `--worktree` / edit `mapping-registry.yaml` for another repo (§3E)  
- [ ] Know files in §4 if switching AI provider later  
