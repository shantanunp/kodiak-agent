import { config as loadDotenv } from "dotenv";

loadDotenv();

/** Wire format for the HTTP model API. Change with MODEL_API_STYLE. */
export type ModelApiStyle = "gemini" | "openai" | "claude";

export interface ModelConfig {
  apiKey: string;
  model: string;
  temperature: number;
  /** Base URL only — path is appended per style (no trailing slash). */
  baseUrl: string;
  apiStyle: ModelApiStyle;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function parseApiStyle(raw: string | undefined): ModelApiStyle {
  const v = (raw ?? "gemini").toLowerCase();
  if (v === "openai" || v === "openai-compatible" || v === "compat") return "openai";
  if (v === "claude" || v === "anthropic") return "claude";
  return "gemini";
}

function defaultsForStyle(apiStyle: ModelApiStyle): { baseUrl: string; model: string } {
  switch (apiStyle) {
    case "openai":
      return { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
    case "claude":
      return { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" };
    default:
      return {
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-flash-latest",
      };
  }
}

/**
 * Load model provider settings from env.
 *
 * Preferred:
 *   MODEL_API_KEY, MODEL_BASE_URL, MODEL_NAME, MODEL_TEMPERATURE, MODEL_API_STYLE
 *
 * Aliases (still accepted):
 *   GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY
 *   GEMINI_API_BASE_URL, GEMINI_MODEL, GEMINI_TEMPERATURE
 */
export function loadModelConfig(): ModelConfig {
  const apiKey = firstEnv(
    "MODEL_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  );
  if (!apiKey) {
    throw new Error(
      "MODEL_API_KEY is required (or ANTHROPIC_API_KEY / GEMINI_API_KEY). " +
        "Set endpoint via MODEL_BASE_URL and style via MODEL_API_STYLE=gemini|openai|claude",
    );
  }

  const apiStyle = parseApiStyle(firstEnv("MODEL_API_STYLE", "AI_API_STYLE"));
  const defaults = defaultsForStyle(apiStyle);

  return {
    apiKey,
    model: firstEnv("MODEL_NAME", "MODEL_MODEL", "GEMINI_MODEL") ?? defaults.model,
    temperature: Number(firstEnv("MODEL_TEMPERATURE", "GEMINI_TEMPERATURE") ?? "0"),
    baseUrl: (
      firstEnv("MODEL_BASE_URL", "MODEL_API_BASE_URL", "GEMINI_API_BASE_URL") ?? defaults.baseUrl
    ).replace(/\/$/, ""),
    apiStyle,
  };
}

export function isModelConfigured(): boolean {
  return !!firstEnv(
    "MODEL_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  );
}

/** @deprecated use loadModelConfig */
export const loadGeminiConfig = loadModelConfig;
/** @deprecated use isModelConfigured */
export const isGeminiConfigured = isModelConfigured;
/** @deprecated use ModelConfig */
export type GeminiConfig = ModelConfig;
