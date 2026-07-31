#!/usr/bin/env tsx
/**
 * Dev server for all UI apps + schema API.
 *
 *   npm run ui:serve
 *   http://localhost:4173/structure-setup/?mapper=my-mapper
 *   http://localhost:4173/schema-builder/?mapper=my-mapper
 *   http://localhost:4173/pipeline-viewer/?mapper=demo-ai-recognition-mapper
 */

import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { paths } from "../src/config/env.js";
import { loadSchema, saveSchema, SCHEMAS_DIR } from "../schema/io.js";
import { parseImport } from "../schema/parse.js";
import { validateSchemaDocument } from "../schema/validate.js";
import type { ImportMode, MappingSchemaDocument } from "../schema/types.js";

const PORT = Number(process.env.VIEW_PORT ?? 4173);
const UI_ROOT = join(paths.root, "ui");

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

  // Pipeline viewer data
  if (pathname.startsWith("/data/")) {
    const file = join(UI_ROOT, "pipeline-viewer/data", pathname.slice("/data/".length));
    if (file.startsWith(join(UI_ROOT, "pipeline-viewer/data")) && existsSync(file)) {
      res.writeHead(200, { "Content-Type": "application/json" });
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
  console.log(`  Pipeline viewer: http://localhost:${PORT}/pipeline-viewer/?mapper=demo-ai-recognition-mapper`);
});
