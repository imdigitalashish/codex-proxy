// Local OpenAI-compatible proxy for Codex / ChatGPT desktop.
// Modes (UPSTREAM_MODE): relay (third-party OpenAI-compatible endpoint) | copilot (your GitHub Copilot account).
// - Streams SSE untouched for Responses-native models; translates Responses <-> Chat Completions for models the
//   upstream only serves on /chat/completions (Claude, Gemini, ...) so Codex tools/subagents work on them too.
// - Answers Codex clients' GET /v1/models in Codex's own schema: template models + generated entries for extra models.
import { responsesToChat, chatToResponsesNonStream, chatStreamToResponsesStream, normalizeResponsesToolControls, sanitizeResponsesRequest, rewriteResponsesJson, rewriteResponsesSse, trimReasoningItems } from "./responses-bridge.ts";
import { UploadGate, bodyBytes, drainSignalStream } from "./upload-gate.ts";
import { buildCodexModels, isUsablePickerModel, supportsResponses, type CatalogEntry } from "./model-catalog.ts";
import { COPILOT_MAX_BODY_BYTES, parseBodyLimit, assertBodyFits, RequestBodyTooLarge, bodyLimitResponse, codexRequestKind, readErrorPreview } from "./request-body-limit.ts";
import { homedir } from "node:os";

const HOME = Bun.env.HOME || homedir();
const mode = (Bun.env.UPSTREAM_MODE ?? (Bun.env.UPSTREAM_API_KEY ? "relay" : "copilot")).toLowerCase();
const relayBase = (Bun.env.UPSTREAM_BASE_URL ?? "").replace(/\/+$/, "");
const relayKey = Bun.env.UPSTREAM_API_KEY ?? "";
const port = Number(Bun.env.PORT ?? 4141);
const codexModelsTemplatePath = Bun.env.CODEX_MODELS_TEMPLATE ?? `${HOME}/.codex-proxy/models-template.json`;
const githubTokenFile = Bun.env.COPILOT_GITHUB_TOKEN_FILE ?? `${HOME}/.codex-proxy/github-token`;
const accountType = (Bun.env.COPILOT_ACCOUNT_TYPE ?? "individual").toLowerCase();
const aliases: Record<string, string> = (() => { try { return JSON.parse(Bun.env.MODEL_ALIASES ?? "{}"); } catch { return {}; } })();
const extraPickerModels = (Bun.env.EXTRA_PICKER_MODELS ?? "claude-opus-5,claude-sonnet-5,claude-opus-4.8,claude-opus-4.7,claude-sonnet-4.6,claude-haiku-4.5,gemini-3.7-flash,gemini-3.6-flash,grok-4.6,grok-4.5,gpt-5.3-codex,gpt-5.6-sol-fast").split(",").map((s) => s.trim()).filter(Boolean);
const pickerBaseSlug = Bun.env.PICKER_BASE_SLUG ?? "gpt-5.4-mini";
// Slow-uplink handling (README "Slow uplink"), in order of preference: 1) serialize large uploads so they do not share
// the uplink (lossless), 2) retry transient upstream failures that Codex treats as fatal, 3) only then shrink the body
// by dropping older encrypted reasoning items.
const uploadGate = new UploadGate(Math.max(0, Number(Bun.env.UPLOAD_CONCURRENCY ?? 1) || 0), Math.max(0, Number(Bun.env.UPLOAD_GATE_MIN_KB ?? 64) || 0));
const uploadStreaming = (Bun.env.UPLOAD_GATE_STREAM ?? "1") !== "0";
const upstreamRetries = Math.max(0, Number(Bun.env.UPSTREAM_RETRIES ?? 2) || 0);
const trimReasoningKB = Math.max(0, Number(Bun.env.TRIM_REASONING_KB ?? 0) || 0);
const trimReasoningOn408 = (Bun.env.TRIM_REASONING_ON_408 ?? "1") !== "0";
const trimReasoningKeep = Math.max(0, Number(Bun.env.TRIM_REASONING_KEEP ?? 4) || 0);
const retryableStatus = new Set([408, 502, 503, 504]);
const upstreamMaxBodyBytes = parseBodyLimit(Bun.env.UPSTREAM_MAX_BODY_BYTES, mode === "copilot" ? COPILOT_MAX_BODY_BYTES : 0);
const bodyBudgetPaths = new Set(["/responses", "/responses/compact", "/chat/completions"]);

if (mode === "relay" && (!relayBase || !relayKey)) { console.error("relay mode needs UPSTREAM_BASE_URL and UPSTREAM_API_KEY"); process.exit(1); }
if (mode !== "relay" && mode !== "copilot") { console.error(`unknown UPSTREAM_MODE ${mode}`); process.exit(1); }

const dropRequestHeaders = new Set(["host", "authorization", "content-length", "connection", "accept-encoding", "x-api-key", "cookie"]);
const dropResponseHeaders = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
function log(fields: Record<string, unknown>) { console.log(JSON.stringify({ at: new Date().toISOString(), ...fields })); }
const isCodexClient = (r: Request) => /codex/i.test(r.headers.get("user-agent") ?? "") || r.headers.has("originator");

// ---------- GitHub Copilot auth ----------
const COPILOT_VERSION = "0.26.7";
const VSCODE_VERSION = Bun.env.COPILOT_VSCODE_VERSION ?? "1.104.0";
const ghBaseHeaders = () => ({
  "content-type": "application/json", accept: "application/json",
  "editor-version": `vscode/${VSCODE_VERSION}`, "editor-plugin-version": `copilot-chat/${COPILOT_VERSION}`,
  "user-agent": `GitHubCopilotChat/${COPILOT_VERSION}`, "x-github-api-version": "2025-04-01", "x-vscode-user-agent-library-version": "electron-fetch",
});
type CopilotToken = { token: string; expiresAt: number; apiBase: string };
let copilotToken: CopilotToken | undefined; let copilotTokenPromise: Promise<CopilotToken> | undefined;
async function githubToken(): Promise<string> {
  const f = Bun.file(githubTokenFile);
  if (!(await f.exists())) throw new Error(`not logged in: run  bun ~/.codex-proxy/copilot-auth.ts`);
  return (await f.text()).trim();
}
async function fetchCopilotToken(): Promise<CopilotToken> {
  const gh = await githubToken();
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", { headers: { ...ghBaseHeaders(), authorization: `token ${gh}` } });
  if (!r.ok) throw new Error(`copilot token request failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { token: string; expires_at: number; endpoints?: { api?: string } };
  const defaultBase = accountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${accountType}.githubcopilot.com`;
  copilotToken = { token: body.token, expiresAt: body.expires_at * 1000, apiBase: (body.endpoints?.api ?? defaultBase).replace(/\/+$/, "") };
  log({ event: "copilot_token_refreshed", expiresInMin: Math.round((copilotToken.expiresAt - Date.now()) / 60000), apiBase: copilotToken.apiBase });
  return copilotToken;
}
async function getCopilotToken(force = false): Promise<CopilotToken> {
  if (!force && copilotToken && copilotToken.expiresAt - Date.now() > 120_000) return copilotToken;
  if (!copilotTokenPromise) copilotTokenPromise = fetchCopilotToken().finally(() => { copilotTokenPromise = undefined; });
  return copilotTokenPromise;
}
async function upstreamAuth(extra: Record<string, string> = {}): Promise<{ base: string; headers: Record<string, string> }> {
  if (mode === "relay") return { base: relayBase, headers: { authorization: `Bearer ${relayKey}`, ...extra } };
  const t = await getCopilotToken();
  return { base: t.apiBase, headers: { ...ghBaseHeaders(), authorization: `Bearer ${t.token}`, "copilot-integration-id": "vscode-chat", "openai-intent": "conversation-panel", "x-request-id": crypto.randomUUID(), ...extra } };
}

// ---------- upstream catalog (cached 5 min) ----------
let catalog: { at: number; models: Map<string, CatalogEntry> } | undefined;
async function getCatalog(): Promise<Map<string, CatalogEntry> | undefined> {
  if (catalog && Date.now() - catalog.at < 300_000) return catalog.models;
  try {
    const { base, headers } = await upstreamAuth();
    const r = await fetch(`${base}/models`, { headers });
    if (!r.ok) return catalog?.models;
    const body = (await r.json()) as { data?: any[] };
    const models = new Map<string, CatalogEntry>();
    for (const m of body.data ?? []) if (typeof m.id === "string") models.set(m.id, {
      id: m.id, name: m.name ?? m.id, vendor: m.vendor ?? "", endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints : [],
      efforts: m.capabilities?.supports?.reasoning_effort ?? [], vision: !!m.capabilities?.supports?.vision,
      ctx: m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens ?? 128000,
      picker: m.model_picker_enabled === true, toolCalls: m.capabilities?.supports?.tool_calls === true,
    });
    catalog = { at: Date.now(), models };
    return models;
  } catch { return catalog?.models; }
}
async function codexModels(): Promise<Response> {
  let template: { models?: any[] };
  try { template = await Bun.file(codexModelsTemplatePath).json(); } catch (error) { log({ event: "codex_models_template_unreadable", error: String(error) }); return Response.json({ models: [] }); }
  const cat = await getCatalog();
  const models = buildCodexModels(template, cat, { aliases, extraPickerModels, pickerBaseSlug });
  return Response.json({ models });
}

// ---------- request forwarding ----------
async function forward(request: Request): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 60);
  if (url.pathname === "/healthz") {
    let copilot: unknown;
    if (mode === "copilot") { try { const t = await getCopilotToken(); copilot = { authenticated: true, apiBase: t.apiBase, tokenExpiresInMin: Math.round((t.expiresAt - Date.now()) / 60000) }; } catch (e) { copilot = { authenticated: false, error: String(e).slice(0, 200) }; } }
    const cat = await getCatalog();
    const usablePickerModels = cat ? [...cat.values()].filter(isUsablePickerModel) : [];
    return Response.json({ ok: true, mode, port, upstream: mode === "relay" ? new URL(relayBase).host : "api.githubcopilot.com", aliases, copilot, requestLimits: { upstreamMaxBodyBytes }, uplink: { uploads: uploadGate.stats, streaming: uploadStreaming, upstreamRetries, trimReasoningKB, trimReasoningOn408, trimReasoningKeep }, catalogModels: cat?.size ?? 0, usablePickerModels: usablePickerModels.map((m) => m.id), extraPickerModels: extraPickerModels.filter((id) => cat?.has(id)), bridged: usablePickerModels.filter((m) => !supportsResponses(m)).map((m) => m.id) });
  }
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "GET" && path === "/models" && isCodexClient(request)) {
    const response = await codexModels();
    log({ method: "GET", path: url.pathname + url.search, served: "codex_models_schema", ua, status: response.status, ms: Date.now() - started });
    return response;
  }

  let body: BodyInit | null = null; let parsed: any; let model: string | undefined; let stream: boolean | undefined; let initiator = "user"; let vision = false; let reqKB = 0; let effort: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.arrayBuffer(); reqKB = Math.round(raw.byteLength / 1024);
    if ((request.headers.get("content-type") ?? "").includes("application/json") && raw.byteLength > 0) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
        if (parsed && typeof parsed === "object") {
          if (path === "/responses") parsed = normalizeResponsesToolControls(parsed);
          if (typeof parsed.model === "string") { const mapped = aliases[parsed.model]; if (mapped) parsed.model = mapped; model = parsed.model; }
          stream = parsed.stream; effort = parsed.reasoning?.effort;
          const items: any[] = Array.isArray(parsed.input) ? parsed.input : Array.isArray(parsed.messages) ? parsed.messages : [];
          const last = items[items.length - 1];
          if (last && typeof last === "object" && ((last.role && last.role !== "user") || (!last.role && last.type && last.type !== "message"))) initiator = "agent";
          if (/"type":"(input_image|image_url|image)"/.test(JSON.stringify(items).slice(0, 2_000_000))) vision = true;
          body = JSON.stringify(parsed);
        } else body = raw;
      } catch { body = raw; }
    } else body = raw;
  }

  let trimmedFromKB: number | undefined; let retries = 0; let queuedMs = 0; let translatedToChat = false;
  const extraLog = () => ({ ...(queuedMs ? { queuedMs } : {}), ...(retries ? { retries } : {}), ...(trimmedFromKB !== undefined ? { trimmedFromKB } : {}) });
  // Oversized /responses bodies: drop older encrypted reasoning items (the model loses its earlier chain of thought,
  // nothing else changes). Pre-emptively above TRIM_REASONING_KB, and always after an upstream 408 (upload too slow).
  const applyTrim = (reason: string): boolean => {
    if (path !== "/responses" || !parsed || trimmedFromKB !== undefined) return false;
    const dropped = trimReasoningItems(parsed, trimReasoningKeep);
    if (!dropped) return false;
    const before = reqKB; body = JSON.stringify(parsed); reqKB = Math.round((body as string).length / 1024); trimmedFromKB = before;
    log({ event: "reasoning_trimmed", reason, model, fromKB: before, toKB: reqKB, dropped, kept: trimReasoningKeep });
    return true;
  };
  if (trimReasoningKB > 0 && reqKB > trimReasoningKB) applyTrim("size");

  const copilotExtra = (init: string, vis: boolean) => (mode === "copilot" ? { "x-initiator": init, ...(vis ? { "copilot-vision-request": "true" } : {}) } : {});
  const send = async (targetPath: string, payload: BodyInit | null, extra: Record<string, string>, force = false): Promise<Response> => {
    const bytes = payload === null ? null : bodyBytes(payload as string | ArrayBuffer | ArrayBufferView);
    const limitBytes = request.method === "POST" && bodyBudgetPaths.has(targetPath) ? upstreamMaxBodyBytes : 0;
    if (bytes) assertBodyFits(bytes.byteLength, limitBytes);
    if (force && mode === "copilot") await getCopilotToken(true);
    const { base, headers: up } = await upstreamAuth(extra);
    const headers = new Headers();
    for (const [n, v] of request.headers) if (!dropRequestHeaders.has(n.toLowerCase())) headers.set(n, v);
    for (const [k, v] of Object.entries(up)) headers.set(k, v);
    const target = `${base}${targetPath}${url.search}`;
    if (bytes === null) return fetch(target, { method: request.method, headers, redirect: "manual" });
    headers.set("content-type", "application/json");
    // Large bodies wait for an upload slot. Streamed, so the slot frees as soon as the bytes have left the process
    // (release on response headers would also hold it through the model's time-to-first-token).
    const slot = await uploadGate.acquire(bytes.byteLength / 1024);
    queuedMs += slot.queuedMs;
    try {
      const response = slot.gated && uploadStreaming
        ? await fetch(target, { method: request.method, headers, body: drainSignalStream(bytes, slot.release), redirect: "manual", duplex: "half" } as RequestInit)
        : await fetch(target, { method: request.method, headers, body: bytes, redirect: "manual" });
      if (response.status === 413) throw new RequestBodyTooLarge(bytes.byteLength, limitBytes, response);
      return response;
    } finally { slot.release(); }
  };
  // Retry transient upstream failures that Codex treats as fatal. A 408 ("timed out reading request body") means our
  // upload was too slow for the upstream's deadline; `onRetry` lets the caller shrink the body before the next attempt.
  // Nothing has been streamed to the client at this point, so retrying is safe.
  const sendRetrying = async (targetPath: string, payload: () => BodyInit | null, extra: Record<string, string>, onRetry?: (status?: number) => void): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined; let failure: unknown;
      try { res = await send(targetPath, payload(), extra); } catch (error) {
        if (error instanceof RequestBodyTooLarge) throw error;
        failure = error;
      }
      if (res && !retryableStatus.has(res.status)) return res;
      if (attempt >= upstreamRetries) { if (res) return res; throw failure; }
      const detail = res ? `${res.status} ${(await res.text()).slice(0, 160)}` : String(failure).slice(0, 160);
      retries = attempt + 1;
      log({ event: "upstream_retry", attempt: retries, of: upstreamRetries, model, reqKB, ms: Date.now() - started, error: detail });
      onRetry?.(res?.status);
      await Bun.sleep(1500);
    }
  };

  try {
    // Responses request for a model the upstream only serves on /chat/completions -> translate both ways.
    if (path === "/responses" && request.method === "POST" && parsed && model) {
      const entry = (await getCatalog())?.get(model);
      if (entry && !supportsResponses(entry)) {
        const tr = responsesToChat(parsed, entry.efforts);
        translatedToChat = true;
        let up = await sendRetrying("/chat/completions", () => JSON.stringify(tr.chat), copilotExtra(tr.initiator, tr.hasImages || vision));
        if (up.status === 401 && mode === "copilot") up = await send("/chat/completions", JSON.stringify(tr.chat), copilotExtra(tr.initiator, tr.hasImages || vision), true);
        if (up.status === 400 && tr.chat.reasoning_effort) { // some chat models reject reasoning_effort; retry once without it
          const text = await up.clone().text();
          if (/reasoning/i.test(text)) { delete tr.chat.reasoning_effort; up = await send("/chat/completions", JSON.stringify(tr.chat), copilotExtra(tr.initiator, tr.hasImages || vision)); }
        }
        if (!up.ok) {
          const text = await up.text();
          log({ method: "POST", path: url.pathname, model, translated: true, reqKB, ...extraLog(), status: up.status, ms: Date.now() - started, ua, error: text.slice(0, 200) });
          return Response.json({ error: { message: `upstream ${up.status}: ${text.slice(0, 500)}`, type: "upstream_error" } }, { status: up.status });
        }
        if (tr.stream) {
          const stream = chatStreamToResponsesStream(up, parsed, tr.customToolNames, (info) => log({ method: "POST", path: url.pathname, model, translated: true, reqKB, ...extraLog(), stream: true, initiator: tr.initiator, status: info.status === "completed" ? 200 : 502, ms: Date.now() - started, ua, ...(info.error ? { error: info.error.slice(0, 200) } : {}) }), tr.namespaces);
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }
        const out = await chatToResponsesNonStream(await up.json(), parsed, tr.customToolNames, tr.namespaces);
        log({ method: "POST", path: url.pathname, model, translated: true, reqKB, ...extraLog(), stream: false, initiator: tr.initiator, status: 200, ms: Date.now() - started, ua });
        return Response.json(out);
      }
    }
    // Responses-native models from non-OpenAI vendors (Grok, mai-code) reject Codex's namespace/custom/web_search
    // tool types with a bare 422. Send them plain function tools and map custom-tool calls back in the stream.
    let sanitized: Set<string> | undefined; let sanitizedNamespaces: Map<string, string> | undefined;
    const sanitize = () => {
      const result = sanitizeResponsesRequest(parsed);
      sanitized = result.customToolNames; sanitizedNamespaces = result.namespaces;
      log({ event: "responses_tools_sanitized", model, kept: result.tools.length, custom: [...result.customToolNames], dropped: result.dropped });
      return JSON.stringify(result.request);
    };
    let payload = body;
    if (path === "/responses" && request.method === "POST" && parsed && model && Array.isArray(parsed.tools)) {
      const entry = (await getCatalog())?.get(model);
      if (entry && supportsResponses(entry) && !/openai/i.test(entry.vendor)) payload = sanitize();
    }
    let upstream = await sendRetrying(path, () => payload, copilotExtra(initiator, vision), (status) => { if (status === 408 && trimReasoningOn408 && applyTrim("retry")) payload = sanitized ? sanitize() : body; });
    if (upstream.status === 401 && mode === "copilot") { log({ event: "copilot_401_refreshing" }); upstream = await send(path, payload, copilotExtra(initiator, vision), true); }
    if (upstream.status === 422 && path === "/responses" && parsed && Array.isArray(parsed.tools) && !sanitized) { payload = sanitize(); upstream = await send(path, payload, copilotExtra(initiator, vision)); }
    if (upstream.ok && sanitized && path === "/responses") {
      if (stream) return new Response(rewriteResponsesSse(upstream, sanitized, sanitizedNamespaces), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
      const out = rewriteResponsesJson(await upstream.json(), sanitized, sanitizedNamespaces);
      log({ method: "POST", path: url.pathname, model, sanitized: true, status: 200, ms: Date.now() - started, ua });
      return Response.json(out);
    }
    const responseHeaders = new Headers();
    for (const [n, v] of upstream.headers) if (!dropResponseHeaders.has(n.toLowerCase())) responseHeaders.set(n, v);
    if (upstream.status >= 400) {
      // Capture the upstream error and the request that caused it for diagnosis (bodies stay local).
      const text = await upstream.text();
      const file = `${HOME}/.codex-proxy/errors/${Date.now()}-${upstream.status}-${(model ?? "nomodel").replace(/[^a-z0-9.-]/gi, "_")}.json`;
      try { await Bun.write(file, JSON.stringify({ at: new Date().toISOString(), status: upstream.status, model, path, ua, error: text.slice(0, 4000), request: parsed ?? null }, null, 2)); } catch {}
      log({ method: request.method, path: url.pathname + url.search, model, reqKB, ...extraLog(), stream, status: upstream.status, ms: Date.now() - started, ua, error: text.slice(0, 300), saved: file });
      responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }
    log({ method: request.method, path: url.pathname + url.search, model, effort, reqKB, ...extraLog(), stream, initiator: mode === "copilot" ? initiator : undefined, status: upstream.status, ms: Date.now() - started, ua });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      const headers = new Headers();
      if (error.upstream) for (const [n, v] of error.upstream.headers) if (!dropResponseHeaders.has(n.toLowerCase())) headers.set(n, v);
      const codexStream = isCodexClient(request) && request.method === "POST" && path === "/responses" && parsed?.stream === true;
      const passthrough = !codexStream && !translatedToChat;
      const text = error.upstream ? await readErrorPreview(passthrough ? error.upstream.clone() : error.upstream) : undefined;
      let response: Response;
      if (codexStream) response = bodyLimitResponse(error, "codex-sse", headers);
      else if (error.upstream && translatedToChat) {
        response = Response.json({ error: { message: `upstream 413: ${text?.slice(0, 500) ?? ""}`, type: "upstream_error" } }, { status: 413 });
      } else if (error.upstream) response = new Response(error.upstream.body, { status: 413, headers });
      else response = bodyLimitResponse(error, "json");
      // Keep size diagnostics, not another multi-megabyte copy of the rejected image history.
      log({
        event: "request_body_too_large", source: error.upstream ? "upstream" : "preflight",
        method: request.method, path: url.pathname, model, effort, requestKind: codexRequestKind(request, parsed),
        reqKB, bodyBytes: error.bytes, limitBytes: error.limitBytes, status: 413, clientStatus: response.status,
        upstreamRequestId: headers.get("x-request-id") ?? headers.get("x-github-request-id") ?? headers.get("x-oai-request-id") ?? undefined,
        ms: Date.now() - started, ua, error: text?.slice(0, 4000) ?? error.message,
      });
      return response;
    }
    log({ method: request.method, path: url.pathname, model, error: String(error).slice(0, 300), ms: Date.now() - started, ua });
    return Response.json({ error: { message: `Proxy could not reach upstream: ${String(error).slice(0, 300)}`, type: "proxy_upstream_error" } }, { status: 502 });
  }
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, fetch: forward });
log({ event: "listening", url: `http://127.0.0.1:${port}/v1`, mode, upstream: mode === "relay" ? new URL(relayBase).host : `api.githubcopilot.com (${accountType})`, upstreamMaxBodyBytes, aliases, extraPickerModels });
