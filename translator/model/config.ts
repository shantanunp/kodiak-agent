import { config as loadDotenv } from "dotenv";

loadDotenv();

/**
 * Wire format for the HTTP model API. Change with MODEL_API_STYLE.
 * "gemini" is accepted as a vendor alias: Google exposes an OpenAI-compatible
 * endpoint, so it maps to the openai wire style with Gemini defaults.
 * No vendor SDKs anywhere — plain fetch for every provider.
 */
export type ModelApiStyle = "openai" | "claude" | "copilot";
/** Vendor aliases that share an OpenAI-compatible wire format. */
export type ModelVendorHint = ModelApiStyle | "gemini" | "deepseek";

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

function parseVendorHint(raw: string | undefined): ModelVendorHint {
  const v = (raw ?? "openai").toLowerCase();
  if (v === "claude" || v === "anthropic") return "claude";
  if (v === "copilot" || v === "github-copilot" || v === "github_copilot") return "copilot";
  if (v === "gemini" || v === "google") return "gemini";
  if (v === "deepseek") return "deepseek";
  return "openai";
}

function parseApiStyle(raw: string | undefined): ModelApiStyle {
  const hint = parseVendorHint(raw);
  return hint === "gemini" || hint === "deepseek" ? "openai" : hint;
}

function defaultsForStyle(hint: ModelVendorHint): { baseUrl: string; model: string } {
  switch (hint) {
    case "claude":
      return { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" };
    case "copilot":
      return { baseUrl: "https://api.githubcopilot.com", model: "gpt-4o" };
    case "gemini":
      return {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.5-flash",
      };
    case "deepseek":
      return { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
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
  const rawStyle = firstEnv("MODEL_API_STYLE", "AI_API_STYLE");
  const apiStyle = parseApiStyle(rawStyle);
  const defaults = defaultsForStyle(parseVendorHint(rawStyle));

  const vendor = parseVendorHint(rawStyle);
  const apiKey =
    apiStyle === "copilot"
      ? firstEnv("MODEL_API_KEY", "COPILOT_TOKEN", "GITHUB_TOKEN")
      : apiStyle === "claude"
        ? firstEnv("MODEL_API_KEY", "ANTHROPIC_API_KEY")
        : firstEnv(
            "MODEL_API_KEY",
            "DEEPSEEK_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_API_KEY",
          );

  if (!apiKey) {
    const hint =
      apiStyle === "copilot"
        ? "MODEL_API_KEY, COPILOT_TOKEN, or GITHUB_TOKEN"
        : apiStyle === "claude"
          ? "MODEL_API_KEY or ANTHROPIC_API_KEY"
          : vendor === "deepseek"
            ? "MODEL_API_KEY or DEEPSEEK_API_KEY"
            : "MODEL_API_KEY";
    throw new Error(
      `${hint} is required. ` +
        "Set endpoint via MODEL_BASE_URL and style via MODEL_API_STYLE=openai|claude|copilot|deepseek|gemini",
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
  return isConfiguredForStyle(parseApiStyle(firstEnv("MODEL_API_STYLE", "AI_API_STYLE")));
}

function isConfiguredForStyle(style: ModelApiStyle): boolean {
  if (style === "copilot") {
    return !!firstEnv("MODEL_API_KEY", "COPILOT_TOKEN", "GITHUB_TOKEN");
  }
  if (style === "claude") {
    return !!firstEnv("MODEL_API_KEY", "ANTHROPIC_API_KEY");
  }
  return !!firstEnv(
    "MODEL_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
  );
}
