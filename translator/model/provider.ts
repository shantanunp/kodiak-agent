import { loadModelConfig, type ModelConfig, type ModelApiStyle } from "./config.js";

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
  /** Short plain-English what this step does (shown under each stage in the UI). */
  summary?: string;
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

/** Provider surface used by labeler / discovery — independent of vendor. */
export interface ModelProvider {
  readonly model: string;
  labelFieldMapping(request: FieldMappingRequest): Promise<FieldMappingResponse>;
  discoverMappings(request: DiscoverRequest): Promise<DiscoverResponse>;
  labelStep(request: LabelRequest): Promise<LabelResponse>;
}

/** Shared with offline VS Code agent jobs — do not diverge. */
export const FIELD_MAPPING_PROMPT = `You rewrite one already-parsed Java mapper field into a business pipeline.

The JavaParser indexer already extracted operations (hints only). You own the final output:
kinds, pipeline steps, and business/schema field paths.

Allowed operation kinds (lowercase): read, filter, select, transform, build, write, constant, raw.
Transform "op" values: trim, split, takeFirst, takeLast, takeIndex, multiply, add, subtract, divide, uppercase, lowercase, join, lettersOnly, keepDigits.

keepDigits = keep digit characters (and optional hyphens). Prefer "keepDigits" — never invent names like keepDigitsAndHyphen.

CRITICAL — business paths only:
- targetField and sourceField MUST come from the Known source/target fields in context (or a close leaf match).
- NEVER emit Java class names, packages, or DTO type prefixes.
- Forbidden substrings in field paths: "com.", "$", "dto.", and any Java package / FQCN prefix.
- Good targets: Order.shipTo.postalCode, Customer.fullName, Invoice.lineItems[].amount
- Good sources: customer.displayName, order.termYears, account.refNumber

Rules:
- Indexer ops (READ/CONSTANT/TRANSFORM/RAW/…) are hints — correct them when wrong.
- Literals/static finals → single constant step with "value"; never invent a read for constants.
- Direct getter→setter → [{"kind":"read","sourceField":"<schema source path>","summary":"Reads customer.displayName from the source."}]
- Arithmetic (e.g. termYears * 12) → read + transform multiply with value "12"
- Name-split (parts[0]/parts[1] from trim+split helper):
  [{"kind":"read","sourceField":"customer.displayName","summary":"…"},
   {"kind":"transform","op":"trim","summary":"…"},
   {"kind":"transform","op":"split","value":" ","summary":"…"},
   {"kind":"transform","op":"takeFirst","summary":"…"}]  // or takeLast for parts[1]
- Letter sanitize / alpha-only normalize (trim + keep letters + uppercase, e.g. Character.isLetter loops or letter-filter helpers):
  [{"kind":"read","sourceField":"address.region","summary":"…"},
   {"kind":"transform","op":"trim","summary":"…"},
   {"kind":"transform","op":"lettersOnly","summary":"…"},
   {"kind":"transform","op":"uppercase","summary":"…"}]
  MUST emit lettersOnly whenever the code strips non-letters (Character.isLetter, letter-filter loops, alpha-only helpers).
  Never omit it as "implicit" — if the code filters letters, the pipeline must include lettersOnly.
- Drop meaningless null-guard filters.
- If RAW meta.code is present, expand it into the correct pipeline.
- EVERY pipeline step MUST include "summary": one short plain-English sentence describing what THAT step does (mention the real helper/method when known, e.g. "trimValue trims leading/trailing whitespace.").
- "reason" is a brief overall field explanation (helpers chain + source→target). Do not put per-step detail only in reason — put it in each step's summary.
- If unsure, return recognized=false.

Respond with JSON only:
{"recognized":true,"targetField":"Order.…","pipeline":[{"kind":"read","sourceField":"…","summary":"…"},{"kind":"transform","op":"trim","summary":"…"},…],"reason":"…"}
or {"recognized":false,"reason":"…"}`;

const DISCOVER_PROMPT = `You discover field writes in a Java mapper class. You do NOT label business paths.

Given the full Java source, list every place a target DTO field is set (setX(...), field = ..., builder puts).
Include writes inside helpers, Optional chains, ternaries, switch arms, and loops when they set a field.

Return JSON only:
{"mappings":[{"javaTargetHint":"Party.firstName or setFirstName","codeSnippet":"relevant lines including helper if needed","note":"optional"}]}

Rules:
- Prefer one entry per distinct target field. If the same field is set twice, include both snippets in codeSnippet or two entries with the same hint.
- codeSnippet must be real code from the file (abbreviate long helpers with ... only in the middle).
- When the setter argument is a same-class helper (or Optional/Stream chain) that trims, splits, filters, letter-sanitizes, uppercases, or otherwise transforms values, INLINE that helper method body (or the full chain) in codeSnippet — not only the setX(...) line. Short helpers for trim/split/take/letter-filter/toUpperCase must be fully included.
- Do not invent mappings that are not in the source.
- javaTargetHint can be a setter name, simple field, or dotted path — leaf name is enough.`;

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface ClaudeMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string; type?: string };
}

/** Strip ```json fences Claude sometimes wraps around JSON-only answers. */
function unwrapJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function normalizePipeline(pipeline: PipelineOpLabel[] | undefined): PipelineOpLabel[] | undefined {
  if (!pipeline) return undefined;
  return pipeline.map((op) => ({
    ...op,
    kind: (op.kind ?? "").toLowerCase(),
    op: op.op?.toLowerCase(),
    summary:
      typeof op.summary === "string" && op.summary.trim()
        ? op.summary.trim()
        : undefined,
  }));
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * HTTP model provider. Swap vendor by changing MODEL_BASE_URL + MODEL_API_KEY + MODEL_API_STYLE.
 * - openai: OpenAI-compatible /chat/completions (Azure, office gateways, Ollama, etc.)
 * - claude: Anthropic Messages API (/v1/messages)
 * - copilot: GitHub Copilot /chat/completions (https://api.githubcopilot.com)
 */
export class HttpModelProvider implements ModelProvider {
  readonly model: string;
  private apiKey: string;
  private temperature: number;
  private baseUrl: string;
  private apiStyle: ModelApiStyle;

  constructor(config: ModelConfig = loadModelConfig()) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.temperature = config.temperature;
    this.baseUrl = config.baseUrl;
    this.apiStyle = config.apiStyle;
  }

  /** @deprecated Prefer labelFieldMapping — kept for cache/tests of single RAW steps. */
  async labelStep(request: LabelRequest): Promise<LabelResponse> {
    const userPrompt = JSON.stringify({
      sourceText: request.sourceText,
      currentKind: request.currentKind,
      targetField: request.targetField ?? "",
      context: request.context ?? "",
    });

    const text = await this.generate(FIELD_MAPPING_PROMPT, userPrompt);

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

  async labelFieldMapping(request: FieldMappingRequest): Promise<FieldMappingResponse> {
    const userPrompt = JSON.stringify({
      javaTargetField: request.javaTargetField,
      indexerOps: request.indexerOps,
      context: request.schemaContext ?? "",
    });

    const text = await this.generate(FIELD_MAPPING_PROMPT, userPrompt);

    try {
      const parsed = JSON.parse(text) as FieldMappingResponse;
      parsed.pipeline = normalizePipeline(parsed.pipeline);
      return parsed;
    } catch {
      return { recognized: false, reason: `Invalid JSON from model: ${text.slice(0, 200)}` };
    }
  }

  async discoverMappings(request: DiscoverRequest): Promise<DiscoverResponse> {
    const userPrompt = JSON.stringify({
      className: request.className ?? "",
      entryMethod: request.entryMethod ?? "map",
      sourceJava: request.sourceJava,
    });

    const text = await this.generate(DISCOVER_PROMPT, userPrompt);

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

  /** Low-level completion — routes by MODEL_API_STYLE. */
  async generate(systemPrompt: string, userText: string): Promise<string> {
    if (this.apiStyle === "claude") {
      return this.generateClaude(systemPrompt, userText);
    }
    if (this.apiStyle === "copilot") {
      return this.generateCopilot(systemPrompt, userText);
    }
    return this.generateOpenAi(systemPrompt, userText);
  }

  private async generateOpenAi(systemPrompt: string, userText: string): Promise<string> {
    return this.generateChatCompletions(systemPrompt, userText, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }, true);
  }

  private async generateCopilot(systemPrompt: string, userText: string): Promise<string> {
    // Copilot rejects requests missing Copilot-Integration-Id.
    // copilot-developer-cli works with PAT / GITHUB_TOKEN; vscode-chat is for session tokens.
    return this.generateChatCompletions(systemPrompt, userText, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "Copilot-Integration-Id": process.env.COPILOT_INTEGRATION_ID?.trim() || "copilot-developer-cli",
      "Editor-Version": "vscode/1.96.0",
      "Editor-Plugin-Version": "copilot-chat/0.23.2",
      "User-Agent": "GitHubCopilotChat/0.23.2",
    }, false);
  }

  private async generateChatCompletions(
    systemPrompt: string,
    userText: string,
    headers: Record<string, string>,
    jsonObjectFormat: boolean,
  ): Promise<string> {
    const url = chatCompletionsUrl(this.baseUrl);
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: this.temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    };
    if (jsonObjectFormat) {
      body.response_format = { type: "json_object" };
    }

    return this.fetchText(url, headers, body, (payload) => {
      const p = payload as OpenAiChatResponse;
      const text = p.choices?.[0]?.message?.content?.trim() ?? null;
      return text ? unwrapJsonText(text) : null;
    }, (payload) => (payload as OpenAiChatResponse).error?.message);
  }

  private async generateClaude(systemPrompt: string, userText: string): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    const body = {
      model: this.model,
      max_tokens: 16384,
      temperature: this.temperature,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    };

    return this.fetchText(url, {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    }, body, (payload) => {
      const p = payload as ClaudeMessagesResponse;
      const text = (p.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text!)
        .join("\n")
        .trim();
      return text ? unwrapJsonText(text) : null;
    }, (payload) => (payload as ClaudeMessagesResponse).error?.message);
  }

  private async fetchText(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    extractText: (payload: unknown) => string | null,
    extractError: (payload: unknown) => string | undefined,
  ): Promise<string> {
    const maxAttempts = 4;
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const payload: unknown = await response.json();

      if (response.ok) {
        const text = extractText(payload);
        if (!text) {
          throw new Error(`Model API returned no text (${this.apiStyle})`);
        }
        return text;
      }

      lastError = extractError(payload) ?? response.statusText;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Model API ${response.status}: ${lastError}`);
      }
      const retryMatch = lastError.match(/retry in ([\d.]+)\s*s/i);
      const hintedMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1]!) * 1000) + 500 : 0;
      const waitMs = Math.min(90_000, Math.max(hintedMs, 2000 * attempt));
      await new Promise((r) => setTimeout(r, waitMs));
    }

    throw new Error(`Model API failed: ${lastError}`);
  }
}

export function createModelProvider(config?: ModelConfig): ModelProvider {
  return new HttpModelProvider(config ?? loadModelConfig());
}
