# First setup (Windows)

Quick guide after you check out this repo on a **Windows** laptop: install, run locally, and where to change the AI model provider.

Use **PowerShell** or **Git Bash**. Examples below use PowerShell unless noted.

This project has **no Gradle Wrapper** (`gradlew`). Builds use your machine’s `gradle` and office package mirrors (Artifactory / internal npm / Maven). The UI does **not** load Google Fonts or other CDNs.

---

## 1. Prerequisites


| Tool            | Version            | Why                                                                      |
| --------------- | ------------------ | ------------------------------------------------------------------------ |
| Node.js         | ≥ 20               | App / CLIs — office Node install or [nodejs.org](https://nodejs.org) LTS |
| JDK             | 17+ (21 preferred) | Build JavaParser indexer — set `JAVA_HOME` to your office JDK            |
| Gradle          | 8.x (on `PATH`)    | `npm run build:indexer` → `cd indexer && gradle shadowJar`               |
| Git for Windows | any                | Checkout repos + optional Git Bash                                       |


Also clone the **mapper** repo locally (e.g. `Kmismomapper`) so you can use `--worktree` and avoid needing GitHub for daily runs.

**Check installs:**

```powershell
node -v          # v20+
npm -v
java -version    # 17+
gradle -v        # 8.x — must be on PATH (office install)
echo $env:JAVA_HOME
```

If `java` works but Gradle fails, set `JAVA_HOME` to your JDK folder, e.g.:

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.x.x-hotspot"
```

(Or set it permanently in System Properties → Environment Variables. Prefer the **office-provided** JDK if your laptop uses corporate tooling.)

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
MODEL_API_KEY=your-key

# Optional (defaults shown) — swap vendor by changing these
MODEL_API_STYLE=gemini
MODEL_BASE_URL=https://generativelanguage.googleapis.com
MODEL_NAME=gemini-flash-latest
MODEL_TEMPERATURE=0

# OpenAI-compatible office gateway example:
# MODEL_API_STYLE=openai
# MODEL_BASE_URL=https://your-gateway/v1
# MODEL_NAME=gpt-4o-mini

# Optional — only if you use --remote / scan / poll
# GITHUB_TOKEN=ghp_...
```

Then:

```powershell
npm install
npm run build:indexer
```

`build:indexer` runs **local** `gradle shadowJar` under `indexer\` (no `./gradlew`).  
Gradle/Maven deps should resolve via your **office Artifactory** / init scripts / `settings.xml` — same as other Java projects on your laptop.

**Office network / mirrors (typical):**


| Source                                        | Needed for                                                 |
| --------------------------------------------- | ---------------------------------------------------------- |
| Office npm registry / Artifactory npm         | `npm install`                                              |
| Office Maven / Artifactory                    | Java deps during `gradle shadowJar`                        |
| Office Gradle distribution (if IT manages it) | Running `gradle` itself                                    |
| Your `MODEL_BASE_URL` host                    | `npm run label` (Gemini Studio, OpenAI, or office gateway) |
| `api.github.com`                              | only if you use `--remote` / `scan` / `poll`               |


Prefer `--worktree` so you do **not** need GitHub daily.

If `npm install` or `gradle` still hits the public internet, ask IT for the office npm/Maven/Gradle mirror config (`.npmrc`, Gradle `init.gradle`, Maven `settings.xml`). This repo does not vendor those credentials.

---



## 3. How to run

Use a **Windows path** for the mapper checkout. Forward slashes often work in Node; backslashes are fine if quoted.

Example mapper path: `C:\Users\<you>\Workspace\Kmismomapper`

### A) AST only (no AI, no GitHub)

```powershell
npm run ast -- --mapper lpa-request-mapper --worktree C:\Users\<you>\Workspace\Kmismomapper
```



### B) Label one field (needs model API key; uses local Java)

```powershell
npm run label -- --mapper lpa-request-mapper --worktree C:\Users\<you>\Workspace\Kmismomapper --fields MESSAGE.DEAL.PARTY.FirstName
```

- First run may call the model once (with `--fields`, AI discovery is off by default).
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
# Also: /schema-builder/?mapper=...  and  /pipeline-viewer/?mapper=...
```

UI pages use **system fonts only** — no Google Fonts / CDN requests from the browser. API calls from the UI go only to the local server (`localhost`).

### Avoid if network is restricted

- `--remote`, `npm run scan`, `npm run poll` → GitHub  
- Labeling **all** fields with no `--fields` → many model calls / quota burn



### E) Point at another repo / mapper to test

Scanning is scoped by `[registry/mapping-registry.yaml](registry/mapping-registry.yaml)`. You never index arbitrary paths outside that registry + `--worktree` / remote checkout.

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

1. Update top-level `repo` / `scope` if the paths or GitHub repo differ.
2. Optional: add `registry/schemas/my-test-mapper.schema.json` so label uses business field paths.
3. Run:

```powershell
npm run ast -- --mapper my-test-mapper --worktree C:\Users\<you>\Workspace\MyMapperRepo
npm run label -- --mapper my-test-mapper --worktree C:\Users\<you>\Workspace\MyMapperRepo
```

Clear cache after switching repos/mappers if results look mixed:

```powershell
npm run cache:clear -- --mapper my-test-mapper
```



### Windows tips


| Topic                     | Note                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Line breaks in PowerShell | Use ``` at end of line, or keep the command on one line (as above)                                                      |
| Git Bash                  | Same `npm` commands; paths like `/c/Users/.../Kmismomapper` also work                                                   |
| Antivirus                 | First `npm install` / Gradle may be slow if Defender scans `node_modules`                                               |
| Execution policy          | If scripts are blocked: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`                                           |
| Proxy / Artifactory       | Use office `HTTP_PROXY` / `HTTPS_PROXY`, `.npmrc`, and Gradle/Maven mirror settings from IT — do not add `gradlew` back |


---



## 4. Change model / AI provider

Labeling goes through a generic **model provider** in `[translator/model/](translator/model/)`.  
Swap vendors by changing **endpoint + key + style** in `.env` — no code changes.

### Env vars


| Variable            | Effect                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `MODEL_API_KEY`     | API key (required)                                                                    |
| `MODEL_BASE_URL`    | API host (no trailing slash)                                                          |
| `MODEL_NAME`        | Model id                                                                              |
| `MODEL_TEMPERATURE` | default `0`                                                                           |
| `MODEL_API_STYLE`   | `gemini` (Google generateContent) or `openai` (OpenAI-compatible `/chat/completions`) |


Legacy `GEMINI_*` env names still work as aliases.

### Examples

**Google AI Studio (default):**

```env
MODEL_API_STYLE=gemini
MODEL_BASE_URL=https://generativelanguage.googleapis.com
MODEL_NAME=gemini-flash-latest
MODEL_API_KEY=...
```

**OpenAI / office OpenAI-compatible gateway:**

```env
MODEL_API_STYLE=openai
MODEL_BASE_URL=https://api.openai.com/v1
# or https://your-office-llm-gateway/v1
MODEL_NAME=gpt-4o-mini
MODEL_API_KEY=...
```



### Files involved


| File                                                           | Role                                         |
| -------------------------------------------------------------- | -------------------------------------------- |
| `[.env](.env)` / `[.env.example](.env.example)`                | Key, URL, style, model name                  |
| `[translator/model/config.ts](translator/model/config.ts)`     | Reads env → `loadModelConfig()`              |
| `[translator/model/provider.ts](translator/model/provider.ts)` | `HttpModelProvider` (gemini + openai styles) |
| `[translator/model/labeler.ts](translator/model/labeler.ts)`   | Label / cache orchestration                  |
| `[translator/cli.ts](translator/cli.ts)`                       | `npm run label` entry                        |


**Important:** set `MODEL_API_STYLE` to match the API shape of your endpoint. Changing only the model name while leaving `STYLE=gemini` against an OpenAI URL will fail.

### Offline office workflow (no model API)

When the office network blocks Gemini/OpenAI, use a VS Code / Cursor custom agent instead. Same JSON contract as the live API; next stages read field cache.

```powershell
# 1) Export AST + schema job packet (no API key needed)
npm run label:export -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName

# 2) In VS Code/Cursor: open .cache\agent-jobs\<mapper>\<fingerprint>\job.json
#    Ask your custom agent to write result.json beside it (see job instructions).

# 3) Import agent JSON into field cache (still no API key)
npm run label:import -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName

# 4) Next stage — cache hit, no MODEL_API_KEY
npm run label -- --mapper lpa-request-mapper `
  --worktree C:\Users\<you>\Workspace\Kmismomapper `
  --fields MESSAGE.DEAL.PARTY.LastName `
  --from-cache-only
```

Job files live under `.cache/agent-jobs/{mapperId}/{fingerprint}/` (`job.json`, `result.json`, `README.md`).

---

## 5. Quick checklist (Windows)

- [ ] `node -v` ≥ 20, `java -version` 17+, `gradle -v` works, `JAVA_HOME` set if needed  
- [ ] Office npm / Maven / Gradle mirrors configured (Artifactory) — no `gradlew` in this repo  
- [ ] `Copy-Item .env.example .env` + set `MODEL_API_KEY` (and style/URL if not Gemini)  
- [ ] `npm install` && `npm run build:indexer`  
- [ ] Mapper repo on disk (e.g. `C:\Users\...\Kmismomapper`)  
- [ ] `npm run ast -- --mapper … --worktree C:\...\Kmismomapper` works  
- [ ] `npm run label -- … --worktree … --fields …` works (model endpoint) **or** offline `label:export` → agent → `label:import` → `label -- --from-cache-only`  
- [ ] Know how to point `--worktree` / edit `mapping-registry.yaml` for another repo (§3E)  
- [ ] Know §4 env vars to switch Gemini ↔ OpenAI-compatible gateway  