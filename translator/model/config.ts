import { config as loadDotenv } from "dotenv";

loadDotenv();

/** Wire format for the HTTP model API. Change with MODEL_API_STYLE. */
export type ModelApiStyle = "openai" | "claude" | "copilot";

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
  const v = (raw ?? "openai").toLowerCase();
  if (v === "claude" || v === "anthropic") return "claude";
  if (v === "copilot" || v === "github-copilot" || v === "github_copilot") return "copilot";
  if (v === "openai" || v === "openai-compatible" || v === "compat") return "openai";
  return "openai";
}

function defaultsForStyle(apiStyle: ModelApiStyle): { baseUrl: string; model: string } {
  switch (apiStyle) {
    case "claude":
      return { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" };
    case "copilot":
      return { baseUrl: "https://api.githubcopilot.com", model: "gpt-4o" };
    default:
      return { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  }
}

/**
 * Load model provider settings from env.
 *
 * Preferred:
 *   MODEL_API_KEY, MODEL_BASE_URL, MODEL_NAME, MODEL_TEMPERATURE, MODEL_API_STYLE
 *
 * Aliases (still accepted):
 *   ANTHROPIC_API_KEY (claude)
 *   COPILOT_TOKEN / GITHUB_TOKEN (copilot)
 */
export function loadModelConfig(): ModelConfig {
  const apiStyle = parseApiStyle(firstEnv("MODEL_API_STYLE", "AI_API_STYLE"));
  const defaults = defaultsForStyle(apiStyle);

  const apiKey =
    apiStyle === "copilot"
      ? firstEnv("MODEL_API_KEY", "COPILOT_TOKEN", "GITHUB_TOKEN")
      : apiStyle === "claude"
        ? firstEnv("MODEL_API_KEY", "ANTHROPIC_API_KEY")
        : firstEnv("MODEL_API_KEY");

  if (!apiKey) {
    const hint =
      apiStyle === "copilot"
        ? "MODEL_API_KEY, COPILOT_TOKEN, or GITHUB_TOKEN"
        : apiStyle === "claude"
          ? "MODEL_API_KEY or ANTHROPIC_API_KEY"
          : "MODEL_API_KEY";
    throw new Error(
      `${hint} is required. ` +
        "Set endpoint via MODEL_BASE_URL and style via MODEL_API_STYLE=openai|claude|copilot",
    );
  }

  return {
    apiKey,
    model: firstEnv("MODEL_NAME", "MODEL_MODEL") ?? defaults.model,
    temperature: Number(firstEnv("MODEL_TEMPERATURE") ?? "0"),
    baseUrl: (
      firstEnv("MODEL_BASE_URL", "MODEL_API_BASE_URL") ?? defaults.baseUrl
    ).replace(/\/$/, ""),
    apiStyle,
  };
}

export function isModelConfigured(): boolean {
  const style = parseApiStyle(firstEnv("MODEL_API_STYLE", "AI_API_STYLE"));
  if (style === "copilot") {
    return !!firstEnv("MODEL_API_KEY", "COPILOT_TOKEN", "GITHUB_TOKEN");
  }
  if (style === "claude") {
    return !!firstEnv("MODEL_API_KEY", "ANTHROPIC_API_KEY");
  }
  return !!firstEnv("MODEL_API_KEY");
}
