/**
 * Investigation tool loop — for fields the escalation pass cannot settle.
 *
 * The model gets two deterministic, read-only tools over the ALREADY-RESOLVED
 * mapper source (no filesystem or network access):
 *   search_source(query) -> matching lines with line numbers
 *   read_lines(start, end) -> numbered source range
 * It investigates like an editor agent would, then must return the standard
 * FieldMappingResponse JSON. Every tool call is recorded (replayable trace).
 */

import type { ModelConfig } from "../model/config.js";
import { runToolLoop, type LoopTool, type ToolTraceEntry } from "../model/provider.js";
import { FIELD_MAPPING_PROMPT } from "../model/provider.js";

const TOOLS: LoopTool[] = [
  {
    name: "search_source",
    description:
      "Search the mapper source for a plain-text query. Returns up to 20 matching lines with line numbers.",
    schema: {
      type: "object",
      properties: { query: { type: "string", description: "text to find" } },
      required: ["query"],
    },
  },
  {
    name: "read_lines",
    description: "Read a range of the mapper source. Returns numbered lines (max 120 per call).",
    schema: {
      type: "object",
      properties: {
        start: { type: "integer", description: "1-based first line" },
        end: { type: "integer", description: "1-based last line (inclusive)" },
      },
      required: ["start", "end"],
    },
  },
];

export function makeSourceTools(source: string): (name: string, input: Record<string, unknown>) => string {
  const lines = source.split("\n");
  return (name, input) => {
    if (name === "search_source") {
      const q = String(input.query ?? "");
      if (!q) return "empty query";
      const hits: string[] = [];
      for (let i = 0; i < lines.length && hits.length < 20; i++) {
        if (lines[i]!.includes(q)) hits.push(`${i + 1}: ${lines[i]}`);
      }
      return hits.length ? hits.join("\n") : `no matches for "${q}"`;
    }
    if (name === "read_lines") {
      const start = Math.max(1, Number(input.start ?? 1));
      const end = Math.min(lines.length, Math.min(Number(input.end ?? start), start + 119));
      return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n");
    }
    return `unknown tool: ${name}`;
  };
}

export async function investigateField(options: {
  config: ModelConfig;
  field: string;
  note?: string;
  sourceJava: string;
  schemaContext?: string;
}): Promise<{ text: string; trace: ToolTraceEntry[] }> {
  const userPrompt = [
    `Target field to resolve: "${options.field}"`,
    options.note ? `Analyzer note: ${options.note}` : "",
    options.schemaContext ? `Allowed business paths:\n${options.schemaContext}` : "",
    "",
    "The write for this field could not be resolved statically. Use search_source and",
    "read_lines to investigate the mapper source until you can explain the field, then",
    "respond ONLY with the FieldMappingResponse JSON (recognized=false with a reason if",
    "the field is genuinely never written).",
  ].join("\n");

  return runToolLoop({
    config: options.config,
    systemPrompt: FIELD_MAPPING_PROMPT,
    userPrompt,
    tools: TOOLS,
    executeTool: makeSourceTools(options.sourceJava),
  });
}
