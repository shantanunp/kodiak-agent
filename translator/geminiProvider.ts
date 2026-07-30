import { loadGeminiConfig, type GeminiConfig } from "./config.js";

export interface LabelRequest {
  sourceText: string;
  currentKind: string;
  context?: string;
}

export interface LabelResponse {
  recognized: boolean;
  kind?: string;
  targetField?: string;
  sourceField?: string;
  reason?: string;
}

const SYSTEM_PROMPT = `You label already-parsed Java mapping AST steps. You do NOT parse code from scratch.

Allowed step kinds (lowercase): read, filter, select, transform, build, write, raw.

Rules:
- Only relabel when you are confident the construct matches a known kind.
- Direct field assignment (obj.field = expr) is usually "write".
- if/else on a predicate is "filter" if already classified as filter — do not change unless clearly wrong.
- Method calls creating objects are "build".
- If unsure, return recognized=false and keep raw.
- Respond with JSON only: {"recognized":true,"kind":"write","targetField":"...","sourceField":"...","reason":"..."}
  or {"recognized":false,"reason":"..."}`;

/** Gemini REST API — same shape as AI Studio / curl generateContent. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
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

  async labelStep(request: LabelRequest): Promise<LabelResponse> {
    const userPrompt = JSON.stringify({
      sourceText: request.sourceText,
      currentKind: request.currentKind,
      context: request.context ?? "",
    });

    const text = await this.generateContent(userPrompt);

    try {
      const parsed = JSON.parse(text) as LabelResponse;
      if (parsed.recognized && parsed.kind) {
        parsed.kind = parsed.kind.toLowerCase();
      }
      return parsed;
    } catch {
      return { recognized: false, reason: `Invalid JSON from model: ${text.slice(0, 200)}` };
    }
  }

  /** POST .../models/{model}:generateContent with X-goog-api-key header. */
  async generateContent(userText: string): Promise<string> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;

    const body = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as GenerateContentResponse;

    if (!response.ok) {
      const msg = payload.error?.message ?? response.statusText;
      throw new Error(`Gemini API ${response.status}: ${msg}`);
    }

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      throw new Error("Gemini API returned no text in candidates[0]");
    }

    return text;
  }
}
