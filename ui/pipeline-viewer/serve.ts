#!/usr/bin/env tsx
/**
 * Static server for pipeline viewer.
 *   npm run view:serve
 *   open http://localhost:4173/?mapper=demo-ai-recognition-mapper
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { paths } from "../../src/config/env.js";

const PORT = Number(process.env.VIEW_PORT ?? 4173);
const ROOT = join(paths.root, "ui/pipeline-viewer");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = join(ROOT, filePath);

  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const body = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "text/plain" });
  res.end(body);
}).listen(PORT, () => {
  console.log(`Pipeline viewer: http://localhost:${PORT}/?mapper=demo-ai-recognition-mapper`);
});
