/**
 * Independent scan — Copilot-style worktree search/read for a confident user
 * who disputes a "pipeline looks correct" verdict (or wants a second look).
 *
 * Tools are sandboxed to MAPPER_WORKTREE. The model picks search vs read via
 * native tool-calling (runToolLoop); we only execute and re-apply applyJudgeVerdict.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { paths } from "../../src/config/env.js";
import type { ModelConfig } from "../model/config.js";
import {
  HttpModelProvider,
  runToolLoop,
  type LoopTool,
  type ToolTraceEntry,
} from "../model/provider.js";
import {
  JUDGE_PROMPT,
  applyJudgeVerdict,
  type JudgeOutcome,
  type RawVerdictInput,
} from "./judge.js";

const MAX_SEARCH_HITS = 40;
const MAX_FILES_WALKED = 2000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  ".idea",
  ".cache",
]);

export const EXPLORE_TOOLS: LoopTool[] = [
  {
    name: "search_worktree",
    description:
      "Search the mapper worktree for a plain-text query (Java-focused). Returns up to 40 matching lines with path:line.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to find" },
        glob: {
          type: "string",
          description: 'optional suffix filter, e.g. ".java" (default .java)',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a numbered line range from a worktree-relative file path (max 120 lines per call).",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "path relative to worktree root" },
        start: { type: "integer", description: "1-based first line" },
        end: { type: "integer", description: "1-based last line (inclusive)" },
      },
      required: ["path", "start", "end"],
    },
  },
];

const EXPLORE_SYSTEM = `${JUDGE_PROMPT}

You may investigate with tools before answering:
- search_worktree: find relevant code across the mapper repo
- read_file: open exact line ranges

Treat the CST slice (if provided) as a hint only — verify by searching/reading the worktree.

CRITICAL: Your FINAL message must be ONLY the judge JSON object — no prose, no markdown,
no analysis paragraphs. Put all reasoning inside the JSON "evidence" / "reason" fields.`;

const FINALIZE_PROMPT = `Convert the investigation notes below into the verification-judge JSON only.

Rules:
- Output a single JSON object, no markdown fences, no commentary.
- agree=true ONLY if the code supports the user's claim (and include a full corrected pipeline).
- agree=false if the current pipeline already matches the code.
- evidence must quote real code fragments or cite path:line from the tool outputs.

Shape:
{"agree":true|false,"evidence":"…","reason":"…","pipeline":[…]}  // pipeline only when agree=true`;

/** Resolve path under worktree; reject escapes. */
export function resolveWorktreePath(worktree: string, relPath: string): string | null {
  const root = resolve(worktree);
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const abs = resolve(root, cleaned);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) return null;
  return abs;
}

function walkFiles(root: string, suffix: string, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.n <= 0) return;
    if (name.startsWith(".") && name !== ".java") continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkFiles(full, suffix, out, budget);
    } else if (st.isFile() && full.endsWith(suffix)) {
      out.push(full);
      budget.n--;
    }
  }
}

export function makeWorktreeTools(
  worktree: string,
): (name: string, input: Record<string, unknown>) => string {
  const root = resolve(worktree);
  return (name, input) => {
    if (name === "search_worktree") {
      const q = String(input.query ?? "");
      if (!q) return "empty query";
      const suffix = String(input.glob ?? ".java");
      const files: string[] = [];
      walkFiles(root, suffix.startsWith(".") ? suffix : `.${suffix}`, files, {
        n: MAX_FILES_WALKED,
      });
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        const rel = relative(root, file).replace(/\\/g, "/");
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (lines[i]!.includes(q)) hits.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
      }
      return hits.length
        ? hits.join("\n")
        : `no matches for "${q}" under ${root} (*${suffix})`;
    }
    if (name === "read_file") {
      const rel = String(input.path ?? "");
      const abs = resolveWorktreePath(root, rel);
      if (!abs) return `path rejected (must stay inside worktree): ${rel}`;
      if (!existsSync(abs)) return `file not found: ${rel}`;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch (err) {
        return `read failed: ${(err as Error).message}`;
      }
      const lines = text.split("\n");
      const start = Math.max(1, Number(input.start ?? 1));
      const end = Math.min(lines.length, Math.min(Number(input.end ?? start), start + 119));
      const shown = lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}: ${l}`)
        .join("\n");
      return `${relative(root, abs).replace(/\\/g, "/")}:${start}-${end}\n${shown}`;
    }
    return `unknown tool: ${name}`;
  };
}

export function exploreLogFile(): string {
  return process.env.KODIAK_EXPLORE_FILE ?? join(paths.root, "registry", "explore.jsonl");
}

export function logExploreTrace(record: {
  mapperId: string;
  field: string;
  userClaim: string;
  outcome: string;
  trace: ToolTraceEntry[];
}): void {
  const file = exploreLogFile();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify({
      ...record,
      at: new Date().toISOString(),
      steps: record.trace.map((t) => ({
        tool: t.tool,
        input: t.input,
        outputPreview: String(t.output).slice(0, 400),
      })),
    }) + "\n",
  );
}

export function parseJudgeJson(text: string): RawVerdictInput {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body) as RawVerdictInput;
  } catch {
    // Prefer the last JSON object in the text (models often prose then JSON).
    const start = body.lastIndexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as RawVerdictInput;
      } catch {
        /* fall through */
      }
    }
    return {
      agree: false,
      evidence: "",
      reason: `invalid explore judge JSON: ${body.slice(0, 160)}`,
    };
  }
}

export function isFailedJudgeParse(raw: RawVerdictInput): boolean {
  return (
    typeof raw.reason === "string" &&
    raw.reason.startsWith("invalid explore judge JSON") &&
    !raw.evidence
  );
}

async function finalizeExploreJson(options: {
  config: ModelConfig;
  field: string;
  userClaim: string;
  analysisText: string;
  trace: ToolTraceEntry[];
  generate?: (system: string, user: string) => Promise<string>;
}): Promise<RawVerdictInput> {
  const toolDigest = options.trace
    .map((t, i) => {
      const input = JSON.stringify(t.input);
      return `Step ${i + 1}: ${t.tool} ${input}\n${String(t.output).slice(0, 1500)}`;
    })
    .join("\n\n");
  const user = [
    `Field: ${options.field}`,
    `User claim: ${options.userClaim}`,
    "",
    "Model analysis (may be prose — extract a verdict):",
    options.analysisText.slice(0, 4000),
    "",
    "Tool outputs:",
    toolDigest.slice(0, 8000),
  ].join("\n");

  const generate =
    options.generate ??
    ((system, u) => new HttpModelProvider(options.config).generate(system, u));
  const text = await generate(FINALIZE_PROMPT, user);
  return parseJudgeJson(text);
}

/** Evidence corpus for citation checks: mapper source + tool outputs. */
function evidenceCorpus(sourceJava: string, trace: ToolTraceEntry[]): string {
  return [sourceJava, ...trace.map((t) => t.output)].join("\n");
}

export async function exploreAndJudge(options: {
  config: ModelConfig;
  worktree: string;
  mapperId: string;
  fingerprint: string;
  field: string;
  userClaim: string;
  currentPipeline: unknown[];
  sliceText?: string;
  sourceJava: string;
  schemaContext?: string;
  /** Test seam — defaults to runToolLoop. */
  runLoop?: typeof runToolLoop;
  /** Test seam — defaults to HttpModelProvider.generate (JSON finalize after prose). */
  finalizeGenerate?: (system: string, user: string) => Promise<string>;
}): Promise<JudgeOutcome & { trace: ToolTraceEntry[] }> {
  if (!options.worktree || !existsSync(options.worktree)) {
    const outcome = applyJudgeVerdict({
      mapperId: options.mapperId,
      fingerprint: options.fingerprint,
      field: options.field,
      sliceText: "",
      sourceJava: options.sourceJava,
      userClaim: options.userClaim,
      raw: {
        agree: false,
        evidence: "",
        reason: "No mapper worktree available for independent scan.",
      },
    });
    return { ...outcome, trace: [] };
  }

  const userPrompt = [
    `Field: ${options.field}`,
    `User claim: ${options.userClaim}`,
    `Current pipeline JSON:\n${JSON.stringify(options.currentPipeline, null, 2)}`,
    options.sliceText?.trim()
      ? `CST slice hint (verify independently):\n${options.sliceText}`
      : "No CST slice hint.",
    options.schemaContext ? `Schema context:\n${options.schemaContext}` : "",
    "",
    "Investigate with search_worktree / read_file as needed, then return judge JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  const loop = options.runLoop ?? runToolLoop;
  const { text, trace } = await loop({
    config: options.config,
    systemPrompt: EXPLORE_SYSTEM,
    userPrompt,
    tools: EXPLORE_TOOLS,
    executeTool: makeWorktreeTools(options.worktree),
  });

  let raw = parseJudgeJson(text);
  // Tool loop often returns analysis prose instead of JSON — finalize once.
  if (isFailedJudgeParse(raw) && (trace.length > 0 || text.trim().length > 0)) {
    raw = await finalizeExploreJson({
      config: options.config,
      field: options.field,
      userClaim: options.userClaim,
      analysisText: text,
      trace,
      generate: options.finalizeGenerate,
    });
  }

  const corpus = evidenceCorpus(options.sourceJava, trace);
  // Prefer tool outputs + source as the citation surface; keep slice as bonus.
  const sliceForCite = [options.sliceText ?? "", corpus].join("\n");

  // Still no JSON after finalize — not a mapping defect; ask user to retry.
  if (isFailedJudgeParse(raw)) {
    logExploreTrace({
      mapperId: options.mapperId,
      field: options.field,
      userClaim: options.userClaim,
      outcome: "unverifiable",
      trace,
    });
    return {
      outcome: "unverifiable",
      defectId: "",
      verdict: {
        agree: false,
        evidence:
          "Independent scan ran but did not return a structured verdict. Try Independent scan again.",
        reason: raw.reason,
        citationsVerified: false,
      },
      trace,
    };
  }

  const outcome = applyJudgeVerdict({
    mapperId: options.mapperId,
    fingerprint: options.fingerprint,
    field: options.field,
    sliceText: sliceForCite,
    sourceJava: options.sourceJava,
    userClaim: options.userClaim,
    raw,
  });

  logExploreTrace({
    mapperId: options.mapperId,
    field: options.field,
    userClaim: options.userClaim,
    outcome: outcome.outcome,
    trace,
  });

  return { ...outcome, trace };
}

/** Format tool trace for the pipeline-viewer activity log. */
export function formatExploreTrace(trace: ToolTraceEntry[]): string {
  if (!trace.length) return "(no tool calls)";
  return trace
    .map((t, i) => {
      const input = t.input && typeof t.input === "object" ? t.input as Record<string, unknown> : {};
      let detail = "";
      if (t.tool === "search_worktree") {
        detail = `query=${JSON.stringify(input.query ?? "")}`;
      } else if (t.tool === "read_file") {
        detail = `path=${input.path ?? ""} ${input.start ?? ""}-${input.end ?? ""}`;
      } else {
        detail = JSON.stringify(input);
      }
      const preview = String(t.output).replace(/\s+/g, " ").slice(0, 120);
      return `${i + 1}. ${t.tool}  ${detail}  → ${preview}`;
    })
    .join("\n");
}
