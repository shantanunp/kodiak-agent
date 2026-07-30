import { config as loadDotenv } from "dotenv";

loadDotenv();

/** Google AI Studio (Gemini) — https://aistudio.google.com/apikey */
export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature: number;
  baseUrl: string;
}

export function loadGeminiConfig(): GeminiConfig {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required. Create one at https://aistudio.google.com/apikey",
    );
  }

  return {
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
    temperature: Number(process.env.GEMINI_TEMPERATURE ?? "0"),
    baseUrl:
      process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com",
  };
}

export function isGeminiConfigured(): boolean {
  return !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
}
