import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HttpModelProvider } from "./provider.js";
import type { ModelConfig } from "./config.js";

/**
 * Online-path mechanics, verified WITHOUT network: global fetch is stubbed and
 * every vendor's exact wire format (URL, headers, body, response parsing) is
 * asserted. Switching vendors is config-only — no SDKs anywhere.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Captured { url: string; headers: Record<string, string>; body: any; }

function stubFetch(reply: unknown): Captured {
  const captured: Captured = { url: "", headers: {}, body: null };
  globalThis.fetch = (async (url: any, init: any) => {
    captured.url = String(url);
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => reply } as Response;
  }) as typeof fetch;
  return captured;
}

function config(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    apiKey: "k-test", model: "m", temperature: 0,
    baseUrl: "https://api.example.com/v1", apiStyle: "openai",
    ...overrides,
  };
}

test("claude style: /v1/messages, x-api-key + anthropic-version, content[].text parsed", async () => {
  const cap = stubFetch({
    content: [{ type: "text", text: '{"recognized":true,"targetField":"T.a","pipeline":[{"kind":"read","sourceField":"s.a","summary":"."}]}' }],
  });
  const p = new HttpModelProvider(config({
    apiStyle: "claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5",
  }));
  const res = await p.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });

  assert.equal(cap.url, "https://api.anthropic.com/v1/messages");
  assert.equal(cap.headers["x-api-key"], "k-test");
  assert.equal(cap.headers["anthropic-version"], "2023-06-01");
  assert.equal(cap.body.model, "claude-sonnet-4-5");
  assert.equal(cap.body.system.length > 100, true, "system prompt sent");
  assert.equal(cap.body.messages[0].role, "user");
  assert.equal(res.recognized, true);
  assert.equal(res.targetField, "T.a");
});

test("openai style: /chat/completions, Bearer auth, response_format json, choices parsed", async () => {
  const cap = stubFetch({
    choices: [{ message: { content: '```json\n{"recognized":false,"reason":"r"}\n```' } }],
  });
  const p = new HttpModelProvider(config({ apiStyle: "openai", model: "gpt-4o-mini" }));
  const res = await p.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });

  assert.equal(cap.url, "https://api.example.com/v1/chat/completions");
  assert.equal(cap.headers["Authorization"], "Bearer k-test");
  assert.deepEqual(cap.body.response_format, { type: "json_object" });
  assert.equal(res.recognized, false, "fenced JSON unwrapped and parsed");
});

test("gemini via config alias: openai wire style against Google's compat endpoint", async () => {
  process.env.MODEL_API_STYLE = "gemini";
  process.env.MODEL_API_KEY = "k-gem";
  delete process.env.MODEL_BASE_URL;
  delete process.env.MODEL_NAME;
  const { loadModelConfig } = await import("./config.js");
  const cfg = loadModelConfig();
  assert.equal(cfg.apiStyle, "openai", "gemini maps to the openai wire style");
  assert.equal(cfg.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(cfg.model, "gemini-2.5-flash");

  const cap = stubFetch({ choices: [{ message: { content: '{"recognized":false,"reason":"x"}' } }] });
  await new HttpModelProvider(cfg).labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  assert.equal(cap.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(cap.headers["Authorization"], "Bearer k-gem");
});

test("retry: 429 then success", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return { ok: false, status: 429, statusText: "rate", json: async () => ({ error: { message: "retry in 0.01 s" } }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"recognized":false,"reason":"ok"}' } }] }) } as Response;
  }) as typeof fetch;
  const res = await new HttpModelProvider(config({})).labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  assert.equal(call, 2);
  assert.equal(res.reason, "ok");
});
