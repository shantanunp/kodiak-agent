import { loadGeminiConfig, type GeminiConfig } from "./config.js";

export interface LabelRequest {
  sourceText: string;
  currentKind: string;
  context?: string;
  targetField?: string;
}

export interface FieldMappingRequest {
  javaTargetField: string;
  indexerOps: unknown[];
  schemaContext?: string;
}

export interface PipelineOpLabel {
  kind: string;
  sourceField?: string;
  op?: string;
  value?: string;
  condition?: string;
}

export interface LabelResponse {
  recognized: boolean;
  kind?: string;
  targetField?: string;
  sourceField?: string;
  value?: string;
  reason?: string;
  /** Multi-step pipeline for one target (preferred for split/trim/take patterns). */
  pipeline?: PipelineOpLabel[];
}

export interface FieldMappingResponse {
  recognized: boolean;
  targetField?: string;
  pipeline?: PipelineOpLabel[];
  reason?: string;
}

export interface DiscoverRequest {
  sourceJava: string;
  className?: string;
  entryMethod?: string;
}

export interface DiscoverHit {
  javaTargetHint: string;
  codeSnippet: string;
  note?: string;
}

export interface DiscoverResponse {
  mappings: DiscoverHit[];
}

const FIELD_MAPPING_PROMPT = `You rewrite one already-parsed Java mapper field into a business pipeline.

The JavaParser indexer already extracted operations (hints only). You own the final output:
kinds, pipeline steps, and business/schema field paths.

Allowed operation kinds (lowercase): read, filter, select, transform, build, write, constant, raw.
Transform "op" values: trim, split, takeFirst, takeLast, takeIndex, multiply, add, subtract, divide, uppercase, lowercase, join.

CRITICAL — business paths only:
- targetField and sourceField MUST come from the Known source/target fields in context (or a close leaf match).
- NEVER emit Java class names, packages, or DTO type prefixes.
- Forbidden substrings in field paths: "com.", "LpaMappedResponse", "LoanApplicationRequest", "$", "dto.".
- Good targets: MESSAGE.DEAL.PARTY.FirstName, MESSAGE.MISMOReferenceModelIdentifier
- Good sources: applicant.displayName, mortgage.termYears, refNumber

Rules:
- Indexer ops (READ/CONSTANT/TRANSFORM/RAW/…) are hints — correct them when wrong.
- Literals/static finals → single constant step with "value"; never invent a read for constants.
- Direct getter→setter → [{"kind":"read","sourceField":"<schema source path>"}]
- Arithmetic (e.g. termYears * 12) → read + transform multiply with value "12"
- Name-split (parts[0]/parts[1] from trim+split helper):
  [{"kind":"read","sourceField":"applicant.displayName"},
   {"kind":"transform","op":"trim"},
   {"kind":"transform","op":"split","value":" "},
   {"kind":"transform","op":"takeFirst"}]  // or takeLast for parts[1]
- Drop meaningless null-guard filters.
- If RAW meta.code is present, expand it into the correct pipeline.
- If unsure, return recognized=false.

Respond with JSON only:
{"recognized":true,"targetField":"MESSAGE.…","pipeline":[{"kind":"read","sourceField":"…"},…],"reason":"…"}
or {"recognized":false,"reason":"…"}`;

const DISCOVER_PROMPT = `You discover field writes in a Java mapper class. You do NOT label business paths.

Given the full Java source, list every place a target DTO field is set (setX(...), field = ..., builder puts).
Include writes inside helpers, Optional chains, ternaries, switch arms, and loops when they set a field.

Return JSON only:
{"mappings":[{"javaTargetHint":"Party.firstName or setFirstName","codeSnippet":"relevant lines including helper if needed","note":"optional"}]}

Rules:
- Prefer one entry per distinct target field. If the same field is set twice, include both snippets in codeSnippet or two entries with the same hint.
- codeSnippet must be real code from the file (abbreviate long helpers with ... only in the middle).
- Do not invent mappings that are not in the source.
- javaTargetHint can be a setter name, simple field, or dotted path — leaf name is enough.`;

/** Gemini REST API — same shape as AI Studio / curl generateContent. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
}

function normalizePipeline(pipeline: PipelineOpLabel[] | undefined): PipelineOpLabel[] | undefined {
  if (!pipeline) return undefined;
  return pipeline.map((op) => ({
    ...op,
    kind: (op.kind ?? "").toLowerCase(),
    op: op.op?.toLowerCase(),
  }));
}

export class GeminiLabelProvider {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private baseUrl: string;

  constructor(config: GeminiConfig = loadGeminiConfig()) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.temperature = config.temperature;
    this.baseUrl = config.baseUrl;
  }

  /** @deprecated Prefer labelFieldMapping — kept for cache/tests of single RAW steps. */
  async labelStep(request: LabelRequest): Promise<LabelResponse> {
    const userPrompt = JSON.stringify({
      sourceText: request.sourceText,
      currentKind: request.currentKind,
      targetField: request.targetField ?? "",
      context: request.context ?? "",
    });

    const text = await this.generateContent(FIELD_MAPPING_PROMPT, userPrompt);

    try {
      const parsed = JSON.parse(text) as LabelResponse;
      if (parsed.recognized && parsed.kind) {
        parsed.kind = parsed.kind.toLowerCase();
      }
      parsed.pipeline = normalizePipeline(parsed.pipeline);
      return parsed;
    } catch {
      return { recognized: false, reason: `Invalid JSON from model: ${text.slice(0, 200)}` };
    }
  }

  /** AI-own one field mapping: Java indexer ops → business target + pipeline. */
  async labelFieldMapping(request: FieldMappingRequest): Promise<FieldMappingResponse> {
    const userPrompt = JSON.stringify({
      javaTargetField: request.javaTargetField,
      indexerOps: request.indexerOps,
      context: request.schemaContext ?? "",
    });

    const text = await this.generateContent(FIELD_MAPPING_PROMPT, userPrompt);

    try {
      const parsed = JSON.parse(text) as FieldMappingResponse;
      parsed.pipeline = normalizePipeline(parsed.pipeline);
      return parsed;
    } catch {
      return { recognized: false, reason: `Invalid JSON from model: ${text.slice(0, 200)}` };
    }
  }

  /** AI discovery: find target field writes in full Java source (complements AST). */
  async discoverMappings(request: DiscoverRequest): Promise<DiscoverResponse> {
    const userPrompt = JSON.stringify({
      className: request.className ?? "",
      entryMethod: request.entryMethod ?? "map",
      sourceJava: request.sourceJava,
    });

    const text = await this.generateContent(DISCOVER_PROMPT, userPrompt);

    try {
      const parsed = JSON.parse(text) as DiscoverResponse;
      if (!Array.isArray(parsed.mappings)) {
        return { mappings: [] };
      }
      return {
        mappings: parsed.mappings
          .filter((m) => m && typeof m.javaTargetHint === "string")
          .map((m) => ({
            javaTargetHint: m.javaTargetHint,
            codeSnippet: typeof m.codeSnippet === "string" ? m.codeSnippet : "",
            note: typeof m.note === "string" ? m.note : undefined,
          })),
      };
    } catch {
      return { mappings: [] };
    }
  }

  /** POST .../models/{model}:generateContent with X-goog-api-key header. */
  async generateContent(systemPrompt: string, userText: string): Promise<string> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;

    const body = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          parts: [{ text: userText }],
        },
      ],
      generationConfig: {
        temperature: this.temperature,
        responseMimeType: "application/json",
      },
    };

    const maxAttempts = 4;
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as GenerateContentResponse;

      if (response.ok) {
        const text = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) {
          throw new Error("Gemini API returned no text in candidates[0]");
        }
        return text;
      }

      lastError = payload.error?.message ?? response.statusText;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Gemini API ${response.status}: ${lastError}`);
      }
      const waitMs = Math.min(20_000, 2000 * attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    throw new Error(`Gemini API failed: ${lastError}`);
  }
}
