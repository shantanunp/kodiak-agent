#!/usr/bin/env tsx
/**
 * Dev server for all UI apps + schema API.
 *
 *   npm run ui:serve
 *   http://localhost:4173/structure-setup/?mapper=my-mapper
 *   http://localhost:4173/schema-builder/?mapper=my-mapper
 *   http://localhost:4173/pipeline-viewer/
 */

import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { getEnvOptional, paths } from "../src/config/env.js";
import { loadSchema, saveSchema, SCHEMAS_DIR } from "../schema/io.js";
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
import { writePipelineView } from "../translator/writePipelineView.js";
import {
  applyChangeToMapper,
  resolveMapperWorktree,
} from "../translator/applyChange.js";
import type { PipelineViewModel } from "../translator/toPipelineView.js";

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
  "/": "schema-builder/index.html",
  "/structure-setup": "structure-setup/index.html",
  "/schema-builder": "schema-builder/index.html",
  "/pipeline-viewer": "pipeline-viewer/index.html",
};

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
  const pathname = url.pathname;

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

  // Mapper of the most recently written view, so the viewer can open it by default
  if (pathname === "/api/views/latest" && req.method === "GET") {
    const latest = existsSync(VIEW_DATA_DIR)
      ? readdirSync(VIEW_DATA_DIR)
          .filter((name) => name.endsWith(VIEW_SUFFIX))
          .map((name) => ({
            mapperId: name.slice(0, -VIEW_SUFFIX.length),
            mtimeMs: statSync(join(VIEW_DATA_DIR, name)).mtimeMs,
          }))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      : undefined;

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ mapperId: latest?.mapperId ?? null }));
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
  console.log(`Kodiak UI: http://localhost:${PORT}/structure-setup/?mapper=my-mapper`);
  console.log(`  Schema builder: http://localhost:${PORT}/schema-builder/?mapper=my-mapper`);
  console.log(`  Pipeline viewer: http://localhost:${PORT}/pipeline-viewer/`);
});
