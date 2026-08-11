#!/usr/bin/env tsx
/**
 * Dev server for all UI apps + schema API.
 *
 * App entry (no query params — mapper is localStorage `kodiak.mapper`):
 *   http://localhost:4173/kodiak
 *
 * Internal frames (loaded by the shell; do not use as bookmarks):
 *   /kodiak/frame/schema    /kodiak/frame/pipeline
 */

import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { getEnvOptional, paths } from "../src/config/env.js";
import { isSchemaReadyForMapping, loadSchema, saveSchema, SCHEMAS_DIR } from "../schema/io.js";
import { parseImport } from "../schema/parse.js";
import { validateSchemaDocument } from "../schema/validate.js";
import type { ImportMode, MappingSchemaDocument } from "../schema/types.js";
import {
  StepLabeler,
  isModelConfigured,
  type PipelineJson,
} from "../translator/model/index.js";
import { resolveMapperAst } from "../translator/resolvePipeline.js";
import { filterMappingByFields, parseFieldSelectors } from "../translator/filterByFields.js";
import {
  patchPipelineViewField,
  readPipelineView,
  writePipelineView,
} from "../translator/writePipelineView.js";
import {
  applyChangeToMapper,
  resolveMapperWorktree,
} from "../translator/applyChange.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { buildLabelTasks } from "../translator/agentloop/tasks.js";
import { runAgentLoop } from "../translator/agentloop/loop.js";
import {
  createModelProvider,
  loadModelConfig,
  loadSchemaJson,
} from "../translator/model/index.js";
import { schemaContextForLabeler } from "../schema/io.js";
import {
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
  listFieldPipelineCaches,
} from "../translator/cache/index.js";
import {
  approveVerified,
  computeVerifiedFingerprint,
  countByStatus,
  diffAgainstPrevious,
  getVerified,
} from "../translator/verified/store.js";
import {
  judgeSuggestion,
  logDefect,
  mockDefectId,
} from "../translator/judge/judge.js";
import { exploreAndJudge, formatExploreTrace } from "../translator/judge/explore.js";
import { inferWorktree } from "../analyzer/resolveType.js";
import { exportJudgeJob } from "../translator/judge/offline.js";
import { exportAgentJob } from "../translator/agent/exportJob.js";
import type { PipelineViewModel } from "../translator/toPipelineView.js";
import { toPipelineView } from "../translator/toPipelineView.js";
import { buildMapperReport } from "../translator/report/scorecard.js";
import { resetMappingData } from "../translator/resetMappingData.js";

const PORT = Number(process.env.VIEW_PORT ?? 4173);
const UI_ROOT = join(paths.root, "ui");
const VIEW_DATA_DIR = join(UI_ROOT, "pipeline-viewer/data");
const VIEW_SUFFIX = ".view.json";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
};

const ROUTES: Record<string, string> = {
  "/kodiak": "kodiak/index.html",
  "/kodiak/frame/schema": "schema-builder/index.html",
  "/kodiak/frame/pipeline": "pipeline-viewer/index.html",
  // Legacy paths still serve assets (app.js / styles); HTML entry redirects to /kodiak.
  "/schema-builder": "schema-builder/index.html",
  "/pipeline-viewer": "pipeline-viewer/index.html",
};

function redirect(
  res: import("node:http").ServerResponse,
  location: string,
): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function labelAndWriteView(options: {
  mapperId: string;
  worktree?: string;
  fields?: string;
  noCache?: boolean;
}): Promise<{
  viewPath: string;
  view: PipelineViewModel;
  fieldsLabeled?: number;
  labelModel?: string;
}> {
  const worktree = options.worktree;
  const resolved = await resolveMapperAst(options.mapperId, paths.registry, {
    worktree,
    remote: !worktree,
  });

  const selectors = parseFieldSelectors({ fields: options.fields });
  const pipeline = await new StepLabeler().labelIndex(resolved.ast, {
    fieldSelectors: selectors,
    sourceJava: resolved.sourceJava,
    noCache: options.noCache !== false,
  });

  if (selectors.length > 0) {
    pipeline.mapping = filterMappingByFields(pipeline.mapping, selectors);
  }

  if (!pipeline.mapping?.length) {
    throw new Error(
      "No labeled fields matched. Pass schema target paths (from your mapper schema), or omit fields to label all.",
    );
  }

  const labeled: PipelineJson = {
    ...resolved.ast,
    mapperId: pipeline.mapperId ?? options.mapperId,
    mapping: pipeline.mapping,
    labeledAt: pipeline.labeledAt,
    labelModel: pipeline.labelModel,
  };
  const { path: viewPath, view } = writePipelineView(labeled);
  return {
    viewPath,
    view,
    fieldsLabeled: pipeline.fieldsLabeled,
    labelModel: pipeline.labelModel,
  };
}


function viewStepsFor(mapperId: string, mapping: Array<{ targetField: string; pipeline: unknown[] }>): unknown[] {
  try {
    const view = toPipelineView({ mapperId, mapping } as never);
    return view.fields?.[0]?.steps ?? view.steps ?? [];
  } catch {
    return [];
  }
}

function serveStatic(urlPath: string, res: import("node:http").ServerResponse): boolean {
  const normalized = urlPath.replace(/\/$/, "") || "/";
  let rel = ROUTES[normalized];
  if (rel) {
    // mapped route
  } else if (urlPath.includes(".")) {
    rel = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
  } else {
    rel = (urlPath.startsWith("/") ? urlPath.slice(1) : urlPath) + "/index.html";
  }
  const abs = join(UI_ROOT, rel);

  if (!abs.startsWith(UI_ROOT) || !existsSync(abs)) {
    return false;
  }

  const body = readFileSync(abs);
  res.writeHead(200, { "Content-Type": MIME[extname(abs)] ?? "text/plain" });
  res.end(body);
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/$/, "") || "/";

  // ── App entry: / and legacy HTML bookmarks → /kodiak (no query params) ──
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (pathname === "/" || pathname === "/pipeline-viewer" || pathname === "/schema-builder")
  ) {
    redirect(res, "/kodiak");
    return;
  }

  // Label → write pipeline-viewer data (server-side model; no browser → vendor API)
  if (pathname === "/api/label" && req.method === "POST") {
    try {
      if (!isModelConfigured()) {
        sendJson(res, 503, {
          error:
            "MODEL_API_KEY not configured in .env (label runs on the server, not in the browser).",
        });
        return;
      }

      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string;
        fields?: string;
        worktree?: string;
        noCache?: boolean;
      };

      const mapperId = body.mapperId?.trim();
      if (!mapperId) {
        sendJson(res, 400, { error: "mapperId required" });
        return;
      }

      let worktree: string | undefined;
      try {
        worktree = resolveMapperWorktree(body.worktree);
      } catch {
        worktree =
          body.worktree?.trim() ||
          getEnvOptional("MAPPER_WORKTREE") ||
          getEnvOptional("LABEL_WORKTREE") ||
          undefined;
      }

      const result = await labelAndWriteView({
        mapperId,
        worktree,
        fields: body.fields,
        noCache: body.noCache,
      });

      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg.includes("No labeled fields") ? 404 : 500, { error: msg });
    }
    return;
  }

  // Natural-language edit of mapper worktree (file writes only) → re-label
  if (pathname === "/api/apply-change" && req.method === "POST") {
    try {
      if (!isModelConfigured()) {
        sendJson(res, 503, {
          error:
            "MODEL_API_KEY not configured in .env (edits run on the server, not in the browser).",
        });
        return;
      }

      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string;
        intent?: string;
        /** Target field(s) from current view / label --fields (required for POC scope). */
        fields?: string;
        pipelineHint?: string;
        worktree?: string;
      };

      const mapperId = body.mapperId?.trim();
      const intent = body.intent?.trim();
      const fieldsFilter = body.fields?.trim();
      if (!mapperId) {
        sendJson(res, 400, { error: "mapperId required" });
        return;
      }
      if (!intent) {
        sendJson(res, 400, { error: "intent required (describe the code change)" });
        return;
      }
      if (!fieldsFilter) {
        sendJson(res, 400, {
          error:
            "fields required. Run npm run label -- --fields <schema.target.path> first, then Build with AI on that field.",
        });
        return;
      }

      const focusFields = fieldsFilter.split(",").map((s) => s.trim()).filter(Boolean);
      const worktree = resolveMapperWorktree(body.worktree);
      const applied = await applyChangeToMapper({
        mapperId,
        intent,
        worktree,
        registryPath: paths.registry,
        focusFields,
        pipelineHint: body.pipelineHint,
      });

      let viewResult: Awaited<ReturnType<typeof labelAndWriteView>> | undefined;
      let labelError: string | undefined;
      try {
        viewResult = await labelAndWriteView({
          mapperId,
          worktree,
          fields: fieldsFilter,
          noCache: true,
        });
      } catch (err) {
        labelError = err instanceof Error ? err.message : String(err);
      }

      sendJson(res, 200, {
        ok: true,
        ...applied,
        view: viewResult?.view,
        viewPath: viewResult?.viewPath,
        labelModel: viewResult?.labelModel,
        fieldsLabeled: viewResult?.fieldsLabeled,
        labelError,
        labeled: true,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }


  // ── Deterministic checklist: ALL declared target fields, no model calls ───
  // The viewer renders this instantly (100 fields is fine); labeling happens
  // per field, on demand, when the user opens one.
  if (pathname === "/api/checklist" && req.method === "GET") {
    try {
      const mapperId = url.searchParams.get("mapper")?.trim();
      if (!mapperId) { sendJson(res, 400, { error: "mapper required" }); return; }
      let worktree: string | undefined;
      try { worktree = resolveMapperWorktree(url.searchParams.get("worktree") ?? undefined); }
      catch { worktree = getEnvOptional("MAPPER_WORKTREE") || undefined; }

      const resolved = await resolveMapperAst(mapperId, paths.registry, {
        worktree, remote: false,
      });
      const registry = loadRegistry(paths.registry);
      const mapperEntry = registry.mappers.find((m) => m.id === mapperId);
      if (!mapperEntry) { sendJson(res, 404, { error: `mapper not found: ${mapperId}` }); return; }
      worktree = worktree
        ?? inferWorktree(resolved.sourcePath, mapperEntry.sourceFile)
        ?? undefined;

      const tasks = buildLabelTasks({
        mapper: mapperEntry, sourceJava: resolved.sourceJava, worktree,
      });

      const schemaJson = loadSchemaJson(mapperId);
      const vfp = computeVerifiedFingerprint({ sourceJava: resolved.sourceJava, schemaJson });
      const verified = getVerified(mapperId, vfp);
      const verifiedByLeaf = new Map(
        (verified?.fields ?? []).map((f) => [
          f.targetField.split(".").pop()!.toLowerCase(), f,
        ]),
      );
      const cachedEntries = isModelConfigured()
        ? (() => {
            const config = loadModelConfig();
            const fp = computePipelineFingerprint({
              sourceJava: resolved.sourceJava,
              schemaJson,
              model: `${config.apiStyle}:${config.model}`,
              version: PIPELINE_CACHE_VERSION,
            });
            return listFieldPipelineCaches(mapperId, fp);
          })()
        : [];
      const cachedLeaves = new Set(
        cachedEntries.map((e) => e.javaTargetField.split(".").pop()!.toLowerCase()),
      );
      const cachedByLeaf = new Map(
        cachedEntries.map((e) => [
          e.javaTargetField.split(".").pop()!.toLowerCase(),
          e,
        ] as const),
      );

      // Surface cross-check flips in diagnostics (injection risks already in tasks.diagnostics).
      const crossCheckNotes = tasks.tasks
        .filter((t) => t.note?.startsWith("cross-check:"))
        .map((t) => `${t.field}: ${t.note}`);
      const diagnostics = [...(tasks.diagnostics ?? []), ...crossCheckNotes];

      const view = readPipelineView(mapperId);
      const viewLeaves = new Set(
        (view?.fields ?? []).map((f) =>
          (f.targetField.split(".").pop() ?? f.targetField).replace(/\[\]$/, "").toLowerCase(),
        ),
      );

      sendJson(res, 200, {
        mapperId,
        checklistSource: tasks.checklistSource,
        targetTypeFile: tasks.targetTypeFile,
        worktreeUsed: worktree ?? null,
        diagnostics,
        declaredFields: tasks.report.declaredFields,
        fields: tasks.tasks.map((t) => {
          const leaf = t.field.split(".").pop()!.toLowerCase();
          const v = verifiedByLeaf.get(leaf);
          const cached = cachedByLeaf.get(leaf);
          const provenance = v
            ? (v.status === "user-corrected"
              ? "corrected"
              : v.status === "pending-review"
                ? "pending-review"
                : "verified")
            : cached?.provenance
              ? cached.provenance
              : cached
                ? "cache"
                : t.note?.startsWith("cross-check:")
                  ? "cross-check"
                  : t.state === "unresolved"
                    ? "escalation"
                    : undefined;
          return {
            field: t.field,
            state: t.state,
            note: t.note,
            provenance,
            // Load button uses inView (view.json). labelAvailability is for dots only.
            inView: viewLeaves.has(leaf),
            labelAvailability: v
              ? (v.status === "user-corrected"
                ? "corrected"
                : v.status === "pending-review"
                  ? "pending"
                  : "verified")
              : cachedLeaves.has(leaf) ? "cached" : "none",
          };
        }),
        store: verified
          ? {
              fingerprint: vfp,
              counts: countByStatus(verified),
              previousDiff: diffAgainstPrevious(mapperId, vfp),
            }
          : null,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Label ONE field on demand (verified -> field cache -> model) ──────────
  if (pathname === "/api/label-field" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string; field?: string; worktree?: string; noCache?: boolean;
      };
      const mapperId = body.mapperId?.trim();
      const field = body.field?.trim();
      if (!mapperId || !field) { sendJson(res, 400, { error: "mapperId and field required" }); return; }

      let worktree: string | undefined;
      try { worktree = resolveMapperWorktree(body.worktree); }
      catch { worktree = body.worktree?.trim() || getEnvOptional("MAPPER_WORKTREE") || undefined; }

      const resolved = await resolveMapperAst(mapperId, paths.registry, { worktree, remote: false });
      const registry = loadRegistry(paths.registry);
      const mapperEntry = registry.mappers.find((m) => m.id === mapperId)!;
      worktree = worktree ?? inferWorktree(resolved.sourcePath, mapperEntry.sourceFile) ?? undefined;
      const tasks = buildLabelTasks({ mapper: mapperEntry, sourceJava: resolved.sourceJava, worktree });

      const leaf = field.split(".").pop()!.toLowerCase();
      const task = tasks.tasks.find(
        (t) => t.field.toLowerCase() === field.toLowerCase()
          || t.field.split(".").pop()!.toLowerCase() === leaf,
      );
      if (!task) { sendJson(res, 404, { error: `field not on checklist: ${field}` }); return; }
      if (task.state === "unmapped") {
        sendJson(res, 200, { mapperId, field: task.field, state: "unmapped",
          note: task.note, pipeline: [] });
        return;
      }

      const schemaJson = loadSchemaJson(mapperId);
      const vfp = computeVerifiedFingerprint({ sourceJava: resolved.sourceJava, schemaJson });
      const verified = getVerified(mapperId, vfp);
      const vHit = verified?.fields.find(
        (f) => f.targetField.split(".").pop()!.toLowerCase() === leaf,
      );
      if (vHit) {
        const src =
          vHit.status === "user-corrected"
            ? "corrected"
            : vHit.status === "pending-review"
              ? "pending-review"
              : "verified";
        // Persist viewer dump so a browser refresh can warm the pipeline.
        try {
          patchPipelineViewField({
            mapperId,
            targetField: vHit.targetField,
            pipeline: vHit.pipeline,
            sourceType: mapperEntry.sourceType,
            targetType: mapperEntry.targetType,
          });
        } catch { /* viewer dump is best-effort */ }
        sendJson(res, 200, { mapperId, field: task.field, state: task.state,
          resultSource: src,
          provenance: src,
          pipeline: vHit.pipeline,
          viewSteps: viewStepsFor(mapperId, [
            { targetField: vHit.targetField, pipeline: vHit.pipeline },
          ]),
          sliceText: task.sliceText, fingerprint: vfp });
        return;
      }

      if (!isModelConfigured()) {
        try {
          const exported = await exportAgentJob({
            mapper: mapperId,
            worktree,
            registry: paths.registry,
            selectors: [task.field],
          });
          sendJson(res, 200, {
            outcome: "offline-exported",
            mapperId, field: task.field, state: task.state,
            jobFile: exported.jobFile,
            steps: exported.vscodeSteps,
            note: "No model API configured — single-field job exported for the editor agent. Complete it, import, then reopen this field.",
          });
        } catch (err) {
          sendJson(res, 503, { error:
            "MODEL_API_KEY not configured and offline export failed: " +
            (err instanceof Error ? err.message : String(err)) });
        }
        return;
      }

      const config = loadModelConfig();
      const provider = createModelProvider(config);
      const fp = computePipelineFingerprint({
        sourceJava: resolved.sourceJava, schemaJson,
        model: `${config.apiStyle}:${config.model}`, version: PIPELINE_CACHE_VERSION,
      });
      const single = { ...tasks, tasks: [task] };
      const result = await runAgentLoop({ mapperId }, single, provider, {
        fingerprint: fp,
        schemaContext: schemaContextForLabeler(mapperId),
        sourceJava: resolved.sourceJava,
        noCache: Boolean(body.noCache),
        modelConfig: config,
        schemaContextText: schemaContextForLabeler(mapperId),
      });

      const labeled = result.mapping[0];
      const provenance =
        result.fieldProvenance?.[task.field] ??
        (result.fieldsFromCache > 0 ? "cache" : "slice");
      if (labeled?.pipeline) {
        // Persist viewer dump so a browser refresh can warm the pipeline.
        // Field cache alone made Load disappear while select stayed empty.
        try {
          patchPipelineViewField({
            mapperId,
            targetField: labeled.targetField,
            pipeline: labeled.pipeline,
            sourceType: mapperEntry.sourceType,
            targetType: mapperEntry.targetType,
          });
        } catch { /* viewer dump is best-effort */ }
      }
      sendJson(res, 200, {
        mapperId, field: task.field, state: task.state,
        resultSource: result.fieldsFromCache > 0 ? "cache" : "model",
        provenance,
        pipeline: labeled?.pipeline ?? [],
        viewSteps: labeled
          ? viewStepsFor(mapperId, [
              { targetField: labeled.targetField, pipeline: labeled.pipeline },
            ])
          : [],
        targetField: labeled?.targetField,
        unresolved: result.audit.unresolvedFields,
        sliceText: task.sliceText,
        fingerprint: vfp,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Offline bulk: one multi-field agent job ───────────────────────────────
  if (pathname === "/api/export-label-job" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string; fields?: string[]; worktree?: string;
      };
      const mapperId = body.mapperId?.trim();
      if (!mapperId) { sendJson(res, 400, { error: "mapperId required" }); return; }
      let worktree: string | undefined;
      try { worktree = resolveMapperWorktree(body.worktree); }
      catch { worktree = body.worktree?.trim() || getEnvOptional("MAPPER_WORKTREE") || undefined; }
      const selectors = Array.isArray(body.fields)
        ? body.fields.map((f) => String(f).trim()).filter(Boolean)
        : [];
      const exported = await exportAgentJob({
        mapper: mapperId,
        worktree,
        registry: paths.registry,
        selectors,
      });
      sendJson(res, 200, {
        outcome: "offline-exported",
        mapperId,
        fieldCount: exported.fieldCount,
        jobFile: exported.jobFile,
        steps: exported.vscodeSteps,
        vscodePrompt: exported.vscodePrompt,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Fresh-start: wipe caches + verified store + views + jobs for a mapper ─
  if (pathname === "/api/reset-mappings" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string;
        confirm?: boolean;
      };
      const mapperId = body.mapperId?.trim();
      if (!mapperId) {
        sendJson(res, 400, { error: "mapperId required" });
        return;
      }
      if (body.confirm !== true) {
        sendJson(res, 400, {
          error: 'Pass confirm: true to wipe mapping stores for this mapper.',
        });
        return;
      }
      const result = resetMappingData(mapperId);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Approve pending-review store entry ────────────────────────────────────
  if (pathname === "/api/approve-store" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string; worktree?: string; fingerprint?: string;
      };
      const mapperId = body.mapperId?.trim();
      if (!mapperId) { sendJson(res, 400, { error: "mapperId required" }); return; }
      let fingerprint = body.fingerprint?.trim();
      if (!fingerprint) {
        let worktree: string | undefined;
        try { worktree = resolveMapperWorktree(body.worktree); }
        catch { worktree = body.worktree?.trim() || getEnvOptional("MAPPER_WORKTREE") || undefined; }
        const resolved = await resolveMapperAst(mapperId, paths.registry, { worktree, remote: false });
        fingerprint = computeVerifiedFingerprint({
          sourceJava: resolved.sourceJava,
          schemaJson: loadSchemaJson(mapperId),
        });
      }
      const resApprove = approveVerified({ mapperId, fingerprint });
      if (!resApprove) {
        sendJson(res, 404, { error: `no store entry for ${mapperId}` });
        return;
      }
      const entry = getVerified(mapperId, fingerprint);
      // Sync verified fields into the dump the UI reads for paint.
      if (entry?.fields?.length) {
        let sourceType: string | undefined;
        let targetType: string | undefined;
        try {
          const registry = loadRegistry(paths.registry);
          const mapperEntry = registry.mappers.find((m) => m.id === mapperId);
          sourceType = mapperEntry?.sourceType;
          targetType = mapperEntry?.targetType;
        } catch { /* optional */ }
        for (const f of entry.fields) {
          if (!f.pipeline?.length) continue;
          try {
            patchPipelineViewField({
              mapperId,
              targetField: f.targetField,
              pipeline: f.pipeline,
              sourceType,
              targetType,
            });
          } catch { /* viewer dump is best-effort */ }
        }
      }
      sendJson(res, 200, {
        mapperId,
        fingerprint,
        approved: resApprove.approved,
        file: resApprove.file,
        counts: entry ? countByStatus(entry) : null,
        previousDiff: diffAgainstPrevious(mapperId, fingerprint),
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Steering: user challenges a field's pipeline; judge verifies ──────────
  // mode: judge (default) | force-defect | explore
  if (pathname === "/api/verify-suggestion" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        mapperId?: string; field?: string; claim?: string;
        currentPipeline?: unknown[]; worktree?: string;
        mode?: string;
      };
      const mapperId = body.mapperId?.trim();
      const field = body.field?.trim();
      const claim = body.claim?.trim();
      const mode = (body.mode?.trim() || "judge").toLowerCase();
      if (!mapperId || !field || !claim) {
        sendJson(res, 400, { error: "mapperId, field, and claim required" }); return;
      }
      if (mode !== "judge" && mode !== "force-defect" && mode !== "explore") {
        sendJson(res, 400, { error: 'mode must be "judge", "force-defect", or "explore"' }); return;
      }

      let worktree: string | undefined;
      try { worktree = resolveMapperWorktree(body.worktree); }
      catch { worktree = body.worktree?.trim() || getEnvOptional("MAPPER_WORKTREE") || undefined; }

      const resolved = await resolveMapperAst(mapperId, paths.registry, { worktree, remote: false });
      const registry = loadRegistry(paths.registry);
      const mapperEntry = registry.mappers.find((m) => m.id === mapperId)!;
      worktree = worktree ?? inferWorktree(resolved.sourcePath, mapperEntry.sourceFile) ?? undefined;
      const tasks = buildLabelTasks({ mapper: mapperEntry, sourceJava: resolved.sourceJava, worktree });
      const leaf = field.split(".").pop()!.toLowerCase();
      const task = tasks.tasks.find(
        (t) => t.field.toLowerCase() === field.toLowerCase()
          || t.field.split(".").pop()!.toLowerCase() === leaf,
      );

      const schemaJson = loadSchemaJson(mapperId);
      const vfp = computeVerifiedFingerprint({ sourceJava: resolved.sourceJava, schemaJson });
      const resolvedField = task?.field ?? field;

      if (mode === "force-defect") {
        const defectId = mockDefectId(`${mapperId}:${resolvedField}:${claim}:forced`);
        logDefect({
          mapperId,
          field: resolvedField,
          userClaim: claim,
          judgeEvidence: "User forced defect after judge confirmed the pipeline looks correct.",
          defectId,
        });
        sendJson(res, 200, {
          outcome: "unverifiable",
          forced: true,
          defectId,
          verdict: {
            agree: false,
            evidence: "User forced defect after judge confirmed the pipeline looks correct.",
            citationsVerified: false,
          },
        });
        return;
      }

      if (!isModelConfigured()) {
        const exported = await exportJudgeJob({
          mapper: mapperId,
          field,
          claim,
          worktree,
        });
        sendJson(res, 200, {
          outcome: "offline-exported",
          jobFile: exported.jobFile,
          steps: exported.steps,
          note: "No model API configured — judge job exported for the editor agent.",
        });
        return;
      }

      if (mode === "explore") {
        if (!worktree) {
          sendJson(res, 400, {
            error: "Independent scan needs MAPPER_WORKTREE or an explicit worktree.",
          });
          return;
        }
        const outcome = await exploreAndJudge({
          config: loadModelConfig(),
          worktree,
          mapperId,
          fingerprint: vfp,
          field: resolvedField,
          userClaim: claim,
          currentPipeline: body.currentPipeline ?? [],
          sliceText: task?.sliceText ?? "",
          sourceJava: resolved.sourceJava,
          schemaContext: schemaContextForLabeler(mapperId),
        });
        if (outcome.outcome === "corrected") {
          try {
            patchPipelineViewField({
              mapperId,
              targetField: resolvedField,
              pipeline: outcome.pipeline,
              sourceType: mapperEntry.sourceType,
              targetType: mapperEntry.targetType,
            });
          } catch { /* viewer dump is best-effort */ }
        }
        sendJson(res, 200, {
          ...outcome,
          activityLog: formatExploreTrace(outcome.trace),
          viewSteps:
            outcome.outcome === "corrected"
              ? viewStepsFor(mapperId, [
                  { targetField: resolvedField, pipeline: outcome.pipeline },
                ])
              : undefined,
        });
        return;
      }

      const outcome = await judgeSuggestion({
        provider: createModelProvider(),
        mapperId,
        fingerprint: vfp,
        field: resolvedField,
        sliceText: task?.sliceText ?? "",
        sourceJava: resolved.sourceJava,
        currentPipeline: body.currentPipeline ?? [],
        userClaim: claim,
        schemaContext: schemaContextForLabeler(mapperId),
      });

      sendJson(res, 200, {
        ...outcome,
        viewSteps:
          outcome.outcome === "corrected"
            ? viewStepsFor(mapperId, [
                { targetField: resolvedField, pipeline: outcome.pipeline },
              ])
            : undefined,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Schema API
  if (pathname.startsWith("/api/schemas/")) {
    const parts = pathname.slice("/api/schemas/".length).split("/");
    const mapperId = parts[0];
    const action = parts[1];

    if (pathname === "/api/schemas/parse" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          mode: ImportMode;
          text: string;
          rootName?: string;
        };
        const result = parseImport(body);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (!mapperId) {
      sendJson(res, 400, { error: "mapper id required" });
      return;
    }

    if (req.method === "GET" && action === "ready") {
      const ready = isSchemaReadyForMapping(mapperId);
      sendJson(res, 200, {
        mapperId,
        ready,
        entry: "/kodiak",
      });
      return;
    }

    if (req.method === "GET" && !action) {
      const doc = loadSchema(mapperId);
      if (!doc) {
        sendJson(res, 404, { error: "Schema not found" });
        return;
      }
      sendJson(res, 200, doc);
      return;
    }

    if (req.method === "POST" && !action) {
      try {
        const body = JSON.parse(await readBody(req)) as MappingSchemaDocument;
        if (body.mapperId !== mapperId) {
          sendJson(res, 400, { error: "mapperId in body must match URL" });
          return;
        }
        const validated = validateSchemaDocument(body);
        if (!validated.ok) {
          sendJson(res, 400, { error: validated.errors.join("; ") });
          return;
        }
        const file = saveSchema(validated.doc);
        sendJson(res, 200, { ok: true, path: file });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // Static registry schemas (read-only)
  if (pathname.startsWith("/registry/schemas/") && pathname.endsWith(".schema.json")) {
    const file = join(paths.root, pathname.slice(1));
    if (file.startsWith(SCHEMAS_DIR) && existsSync(file)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(readFileSync(file));
      return;
    }
  }

  // Scorecard — journal + live miss + coverage (zero model calls).
  if (pathname === "/api/report" && req.method === "GET") {
    try {
      const mapperId = url.searchParams.get("mapper")?.trim();
      if (!mapperId) {
        sendJson(res, 400, { error: "mapper query required" });
        return;
      }
      const since = url.searchParams.get("since")?.trim() || undefined;
      const worktree =
        url.searchParams.get("worktree")?.trim() ||
        getEnvOptional("MAPPER_WORKTREE") ||
        undefined;
      const report = await buildMapperReport({
        mapperId,
        worktree,
        since,
        registryPath: paths.registry,
      });
      sendJson(res, 200, report);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // MON-5 — local health (no model calls, no secrets).
  if (pathname === "/api/health" && req.method === "GET") {
    const started = Date.now();
    let registryCount = 0;
    try {
      registryCount = loadRegistry(paths.registry).mappers.length;
    } catch {
      registryCount = 0;
    }
    let verifiedEntries = 0;
    let userCorrected = 0;
    let pendingReview = 0;
    const verifiedRoot = process.env.KODIAK_VERIFIED_DIR
      ?? join(paths.root, "registry", "verified");
    if (existsSync(verifiedRoot)) {
      for (const mapperDir of readdirSync(verifiedRoot)) {
        const dir = join(verifiedRoot, mapperDir);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch { continue; }
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
          verifiedEntries++;
          try {
            const entry = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
              fields?: Array<{ status?: string }>;
            };
            userCorrected +=
              entry.fields?.filter((x) => x.status === "user-corrected").length ?? 0;
            pendingReview +=
              entry.fields?.filter((x) => x.status === "pending-review").length ?? 0;
          } catch { /* skip bad file */ }
        }
      }
    }
    let staleCount = 0;
    try {
      const { checkDrift } = await import("../translator/telemetry/drift.js");
      const rows = await checkDrift({ registryPath: paths.registry });
      staleCount = rows.filter((r) => r.status === "stale").length;
    } catch {
      staleCount = -1;
    }
    let modelStyle: string | null = null;
    let modelName: string | null = null;
    if (isModelConfigured()) {
      try {
        const cfg = loadModelConfig();
        modelStyle = cfg.apiStyle;
        modelName = cfg.model;
      } catch { /* ignore */ }
    }
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      registryMappers: registryCount,
      modelConfigured: isModelConfigured(),
      modelStyle,
      modelName,
      verifiedEntries,
      userCorrected,
      pendingReview,
      staleMappers: staleCount,
      analyzerLanguages: ["java"],
      elapsedMs: Date.now() - started,
    });
    return;
  }

  // Default mapper for /pipeline-viewer with no ?mapper= :
  //   1) most recently written .view.json
  //   2) else a registry mapper whose sourceFile exists under MAPPER_WORKTREE
  //   3) else first registry entry
  if (pathname === "/api/views/latest" && req.method === "GET") {
    const views = existsSync(VIEW_DATA_DIR)
      ? readdirSync(VIEW_DATA_DIR)
          .filter((name) => name.endsWith(VIEW_SUFFIX))
          .map((name) => ({
            mapperId: name.slice(0, -VIEW_SUFFIX.length),
            mtimeMs: statSync(join(VIEW_DATA_DIR, name)).mtimeMs,
          }))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
      : [];
    const latest = views[0];
    let registryIds: string[] = [];
    let worktreePick: string | undefined;
    try {
      const registry = loadRegistry(paths.registry);
      registryIds = registry.mappers.map((m) => m.id);
      const wt = getEnvOptional("MAPPER_WORKTREE");
      if (wt) {
        worktreePick = registry.mappers.find((m) =>
          existsSync(join(wt, m.sourceFile)),
        )?.id;
      }
    } catch {
      registryIds = [];
    }
    const mapperId =
      latest?.mapperId ?? worktreePick ?? registryIds[0] ?? null;
    const source = latest
      ? "view"
      : worktreePick && mapperId === worktreePick
        ? "worktree"
        : mapperId
          ? "registry"
          : null;

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        mapperId,
        source,
        views: views.map((v) => v.mapperId),
        registry: registryIds,
      }),
    );
    return;
  }

  // Pipeline viewer data
  if (pathname.startsWith("/data/")) {
    const file = join(VIEW_DATA_DIR, pathname.slice("/data/".length));
    if (file.startsWith(VIEW_DATA_DIR) && existsSync(file)) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(file));
      return;
    }
  }

  // Shared assets
  if (pathname.startsWith("/shared/")) {
    const file = join(UI_ROOT, "shared", pathname.slice("/shared/".length));
    if (file.startsWith(join(UI_ROOT, "shared")) && existsSync(file)) {
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/plain" });
      res.end(readFileSync(file));
      return;
    }
  }

  if (serveStatic(pathname, res)) return;

  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, () => {
  console.log(`Kodiak UI: http://localhost:${PORT}/kodiak`);
  console.log(`  (mapper in localStorage; schema → pipeline when source+target are saved)`);
});
