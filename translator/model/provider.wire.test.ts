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

test("MON-2: token/latency metrics captured for claude + openai usage shapes", async () => {
  stubFetch({
    content: [{ type: "text", text: '{"recognized":false,"reason":"r"}' }],
    usage: { input_tokens: 11, output_tokens: 7 },
  });
  const claude = new HttpModelProvider(config({
    apiStyle: "claude", baseUrl: "https://api.anthropic.com/v1",
  }));
  await claude.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  const cm = claude.getMetrics();
  assert.equal(cm.calls, 1);
  assert.equal(cm.promptTokens, 11);
  assert.equal(cm.completionTokens, 7);
  assert.ok(cm.totalLatencyMs >= 0);
  assert.equal(cm.latenciesMs.length, 1);

  stubFetch({
    choices: [{ message: { content: '{"recognized":false,"reason":"r"}' } }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  });
  const openai = new HttpModelProvider(config({ apiStyle: "openai" }));
  await openai.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  const om = openai.getMetrics();
  assert.equal(om.calls, 1);
  assert.equal(om.promptTokens, 20);
  assert.equal(om.completionTokens, 5);
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

test("deepseek: disables thinking and still parses content", async () => {
  const cap = stubFetch({
    choices: [{ message: { content: '{"recognized":false,"reason":"ds"}' } }],
  });
  const p = new HttpModelProvider(config({
    apiStyle: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  }));
  const res = await p.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  assert.deepEqual(cap.body.thinking, { type: "disabled" });
  assert.equal(res.reason, "ds");
});

test("deepseek: falls back to reasoning_content when content is empty", async () => {
  stubFetch({
    choices: [{
      message: {
        content: "",
        reasoning_content: '{"recognized":false,"reason":"from-cot"}',
      },
    }],
  });
  const p = new HttpModelProvider(config({
    apiStyle: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  }));
  const res = await p.labelFieldMapping({ javaTargetField: "a", indexerOps: [] });
  assert.equal(res.reason, "from-cot");
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

test("tool loop (claude style): tool_use round trip then final text", async () => {
  const { runToolLoop } = await import("./provider.js");
  let call = 0;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    call++;
    bodies.push(JSON.parse(init.body));
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "search_source", input: { query: "setCode" } }],
      }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"recognized":true}' }],
    }) } as Response;
  }) as typeof fetch;

  const executed: any[] = [];
  const out = await runToolLoop({
    config: config({ apiStyle: "claude", baseUrl: "https://api.anthropic.com/v1" }),
    systemPrompt: "sys", userPrompt: "usr",
    tools: [{ name: "search_source", description: "d", schema: { type: "object" } }],
    executeTool: (name, input) => { executed.push([name, input]); return "42: x.setCode(y);"; },
  });

  assert.equal(call, 2);
  assert.deepEqual(executed, [["search_source", { query: "setCode" }]]);
  assert.equal(out.text, '{"recognized":true}');
  assert.equal(out.trace.length, 1);
  const second = bodies[1];
  assert.equal(second.messages[2].content[0].type, "tool_result", "tool result sent back");
});

test("tool loop (openai style): tool_calls round trip then final text", async () => {
  const { runToolLoop } = await import("./provider.js");
  let call = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    call++;
    const body = JSON.parse(init.body);
    if (call === 1) {
      assert.equal(body.tools[0].type, "function");
      return { ok: true, status: 200, json: async () => ({
        choices: [{ message: { tool_calls: [
          { id: "c1", function: { name: "read_lines", arguments: '{"start":1,"end":3}' } },
        ] } }],
      }) } as Response;
    }
    assert.equal(body.messages[3].role, "tool");
    return { ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: '{"recognized":false,"reason":"never written"}' } }],
    }) } as Response;
  }) as typeof fetch;

  const out = await runToolLoop({
    config: config({ apiStyle: "openai" }),
    systemPrompt: "sys", userPrompt: "usr",
    tools: [{ name: "read_lines", description: "d", schema: { type: "object" } }],
    executeTool: () => "1: a\n2: b\n3: c",
  });
  assert.equal(out.trace[0]!.tool, "read_lines");
  assert.ok(out.text.includes("never written"));
});

test("unknown step kinds normalize to RAW with the original preserved", async () => {
  const { fromPipelineOp, normalizeStepKind, CANONICAL_STEP_KINDS } =
    await import("./applyResponse.js");

  assert.equal(normalizeStepKind("read").kind, "READ");
  assert.equal(normalizeStepKind("TRANSFORM").kind, "TRANSFORM");

  const invented = normalizeStepKind("cast");
  assert.equal(invented.kind, "RAW", "model-invented kind falls back to RAW");
  assert.equal(invented.originalKind, "CAST");

  const step = fromPipelineOp(
    { kind: "cast", op: "toLong", summary: "Casts." } as never,
    "reason",
    "model",
  );
  assert.equal(step.kind, "RAW");
  assert.equal((step.meta as { originalKind: string }).originalKind, "CAST");
  assert.equal((step.meta as { op: string }).op, "toLong", "detail is not lost");
  assert.ok((CANONICAL_STEP_KINDS as readonly string[]).includes(step.kind));
});
