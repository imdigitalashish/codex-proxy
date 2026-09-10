// Responses API <-> Chat Completions translation, so Codex (Responses wire) can drive models that a
// Copilot-style upstream only exposes on /chat/completions (Claude, Gemini, ...). Covers: system/developer
// instructions, message history with text+images, function tools and tool results, Codex "custom" (freeform)
// tools mapped onto function tools, tool_choice, reasoning effort, JSON schema output, streaming SSE in
// Responses event format, and usage accounting.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type Json = any;
const uid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

function partsToChatContent(parts: Json): Json {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  const out: Json[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") out.push({ type: "text", text: String(p.text ?? "") });
    else if (p.type === "input_image" || p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? p.url;
      if (url) out.push({ type: "image_url", image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
    } else if (p.type === "input_file") out.push({ type: "text", text: `[file ${p.filename ?? ""} omitted]` });
    else if (p.type === "refusal") out.push({ type: "text", text: String(p.refusal ?? "") });
  }
  if (out.length === 1 && out[0].type === "text") return out[0].text;
  return out.length ? out : "";
}
function contentToText(c: Json): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && (p.text ?? p.refusal)) ?? (p?.type === "input_image" ? "[image]" : "")).join("");
  return c == null ? "" : String(c);
}


// Flatten Codex's tool list into plain function tools: namespace containers are expanded, custom (freeform)
// tools become a function with a single "input" string, and tool types with no equivalent are dropped.
type ToolIdentity = { name: string; namespace?: string };
export type ToolIdentityMap = Map<string, ToolIdentity>;
export class ToolMappingError extends Error {}
const TOOL_ALIAS_PREFIX = "_cp_";

function upstreamToolName(name: unknown, namespace?: unknown): string {
  if (typeof name !== "string" || !name || (namespace != null && (typeof namespace !== "string" || !namespace))) {
    throw new ToolMappingError("Tool names and namespaces must be nonempty strings");
  }
  if (namespace == null && /^[A-Za-z0-9_-]{1,64}$/.test(name) && !name.startsWith(TOOL_ALIAS_PREFIX)) return name;
  // Independent of tool order or which tools are enabled. The reserved prefix
  // also escapes root tools that could otherwise impersonate a generated alias.
  const label = `${namespace == null ? "" : namespace + "__"}${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 39);
  const hash = createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 20);
  return `${TOOL_ALIAS_PREFIX}${label}_${hash}`;
}

function inputToolName(item: Json, identities: ToolIdentityMap, requireKnown = false): string {
  const name = upstreamToolName(item.name, item.namespace);
  if (item.namespace == null && !identities.has(name)) {
    // Older histories can lack namespace metadata. Only infer it when unambiguous.
    const matches = [...identities].filter(([, identity]) => identity.name === item.name);
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) throw new ToolMappingError(`Ambiguous tool reference: ${item.name}; a namespace is required`);
  }
  if (requireKnown && !identities.has(name)) throw new ToolMappingError(`Unknown or unsupported tool choice: ${item.name}`);
  return name;
}

function flattenedToolChoice(choice: Json, identities: ToolIdentityMap): Json {
  if (typeof choice === "string") return choice;
  const reference = (tool: Json) => {
    if (tool?.type !== "function" && tool?.type !== "custom") throw new ToolMappingError("Unsupported tool-choice reference");
    return { type: "function", name: inputToolName(tool, identities, true) };
  };
  if (choice?.type === "allowed_tools") {
    if (!Array.isArray(choice.tools)) throw new ToolMappingError("allowed_tools requires a tools array");
    if (choice.mode != null && choice.mode !== "auto" && choice.mode !== "required") throw new ToolMappingError("Unsupported allowed_tools mode");
    if (!choice.tools.length && choice.mode === "required") throw new ToolMappingError("No allowed tools remain for a required tool choice");
    return { ...choice, tools: choice.tools.map(reference) };
  }
  return reference(choice);
}

export type FlatTools = { tools: Json[]; customToolNames: Set<string>; namespaces: ToolIdentityMap; dropped: string[] };
export function flattenTools(tools: Json, opts: { strictSchemas?: boolean } = {}): FlatTools {
  const out: Json[] = []; const customToolNames = new Set<string>(); const namespaces: ToolIdentityMap = new Map(); const dropped: string[] = [];
  const definitions = new Map<string, Json>();
  const objectRoot = (schema: Json) => !schema || schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")) || (!!schema.properties && !schema.anyOf && !schema.oneOf);
  const pushTool = (t: Json, ns?: string) => {
    const params = t.parameters ?? { type: "object", properties: {} };
    if (t.type === "function" && opts.strictSchemas && !objectRoot(params)) { dropped.push(`${ns ? ns + "." : ""}${t.name}(non-object schema)`); return; }
    const name = upstreamToolName(t.name, ns);
    const identity: ToolIdentity = { name: t.name, ...(ns === undefined ? {} : { namespace: ns }) };
    if (namespaces.has(name)) {
      if (!isDeepStrictEqual(namespaces.get(name), identity) || !isDeepStrictEqual(definitions.get(name), t)) {
        throw new ToolMappingError(`Conflicting tool definitions: ${ns ? ns + "." : ""}${t.name}`);
      }
      return; // Only coalesce exact duplicates of the same logical tool.
    }
    namespaces.set(name, identity);
    definitions.set(name, t);
    if (t.type === "custom") {
      customToolNames.add(name);
      out.push({ ...customAsFunction(t), name });
    } else out.push({ type: "function", name, description: t.description ?? "", strict: false, parameters: params });
  };
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "function" || t.type === "custom") pushTool(t);
    else if (t.type === "namespace") {
      if (typeof t.name !== "string" || !t.name) throw new ToolMappingError("Tool namespaces must have a nonempty name");
      for (const inner of Array.isArray(t.tools) ? t.tools : []) {
        if (inner?.type === "function" || inner?.type === "custom") pushTool(inner, t.name);
      }
    }
    else dropped.push(String(t.type));
  }
  return { tools: out, customToolNames, namespaces, dropped };
}

/** Drop older encrypted `reasoning` items from a Responses `input`, keeping only the newest `keep`.
 *  The upstream accepts tool-call history without its reasoning items (verified 2026-09-04); the model just
 *  loses its earlier chain of thought. Used to shrink oversized bodies on slow uplinks. Returns the count dropped. */
export function trimReasoningItems(req: Json, keep: number): number {
  if (!req || !Array.isArray(req.input)) return 0;
  const idx: number[] = [];
  req.input.forEach((item: Json, i: number) => { if (item && typeof item === "object" && item.type === "reasoning") idx.push(i); });
  const drop = new Set(idx.slice(0, Math.max(0, idx.length - Math.max(0, keep))));
  if (drop.size === 0) return 0;
  req.input = req.input.filter((_: Json, i: number) => !drop.has(i));
  return drop.size;
}

export type SanitizedResponsesRequest = FlatTools & { request: Json };

export function normalizeResponsesToolControls(req: Json): Json {
  const request = { ...req };
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    if (Array.isArray(request.tools)) delete request.tools;
    delete request.tool_choice;
    delete request.parallel_tool_calls;
  }
  return request;
}

// Replayed tool item IDs belong to their originating provider; call_id pairs the call and output.
export function normalizeResponsesHistory(req: Json): Json {
  if (!Array.isArray(req?.input)) return req;
  return { ...req, input: req.input.map((item: Json) => {
    if (!["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(item?.type)) return item;
    const { id: _id, ...history } = item;
    return history;
  }) };
}

// Normalize Responses requests for non-OpenAI backends. Their tool definitions are plain functions,
// so historical calls to mapped custom tools must use the matching function-call item shapes too.
export function sanitizeResponsesRequest(req: Json): SanitizedResponsesRequest {
  const flat = flattenTools(req?.tools, { strictSchemas: true });
  const toolChoice = req.tool_choice && flattenedToolChoice(req.tool_choice, flat.namespaces);
  const request: Json = normalizeResponsesToolControls({ ...req, tools: flat.tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) });

  if (Array.isArray(request.input)) {
    request.input = request.input.flatMap((item: Json) => {
      if (!item || typeof item !== "object") return [item];
      if (item.type === "reasoning") return [];
      if (item.type === "custom_tool_call") {
        return [{
          type: "function_call",
          call_id: item.call_id,
          name: inputToolName(item, flat.namespaces),
          arguments: JSON.stringify({ input: item.input ?? "" }),
        }];
      }
      if (item.type === "custom_tool_call_output") {
        return [{
          type: "function_call_output",
          ...(item.id ? { id: item.id } : {}),
          call_id: item.call_id,
          output: item.output,
        }];
      }
      if (item.type === "function_call") {
        const { namespace: _namespace, ...plainItem } = item;
        return [{ ...plainItem, name: inputToolName(item, flat.namespaces) }];
      }
      return [item];
    });
  }

  delete request.include;
  return { request, ...flat };
}
// Restore the complete public tool identity before Codex dispatches a call.
export function withNamespace(item: Json, namespaces?: ToolIdentityMap): Json {
  const identity = namespaces?.get(item?.name);
  if (!identity) return item;
  const { namespace: _namespace, ...rest } = item;
  return { ...rest, ...identity };
}
function customAsFunction(t: Json): Json {
  return { type: "function", name: t.name, strict: false, description: `${t.description ?? ""}\n\nCall this tool with a single string argument "input" containing the raw tool input exactly as it should be applied.`.trim(), parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input text" } }, required: ["input"] } };
}
function customInputFromArgs(args: Json): string {
  if (typeof args !== "string") return typeof args?.input === "string" ? args.input : JSON.stringify(args ?? "");
  try { const p = JSON.parse(args); if (p && typeof p.input === "string") return p.input; } catch {}
  return args;
}
function customItem(item: Json): Json {
  return { type: "custom_tool_call", id: item.id, call_id: item.call_id, name: item.name, input: customInputFromArgs(item.arguments ?? ""), status: item.status ?? "completed" };
}
// Rewrite a Responses API JSON body so function calls to mapped custom tools become custom_tool_call items.
export function rewriteResponsesJson(res: Json, custom: Set<string>, namespaces?: ToolIdentityMap): Json {
  if (res && Array.isArray(res.output)) res.output = res.output.map((it: Json) => it?.type === "function_call" && custom.has(it.name) ? withNamespace(customItem(it), namespaces) : it?.type === "function_call" ? withNamespace(it, namespaces) : it);
  return res;
}
// Same for a streamed Responses SSE body.
export function rewriteResponsesSse(upstream: Response, custom: Set<string>, namespaces?: ToolIdentityMap): ReadableStream<Uint8Array> {
  const enc = new TextEncoder(); const marked = new Set<string>();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: Json) => controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      const reader = upstream.body!.getReader(); const dec = new TextDecoder(); let buf = "";
      const handle = (ev: Json) => {
        const t = ev.type as string;
        if (t === "response.output_item.added" && ev.item?.type === "function_call" && custom.has(ev.item.name)) { marked.add(ev.item.id); ev.item = withNamespace({ type: "custom_tool_call", id: ev.item.id, call_id: ev.item.call_id, name: ev.item.name, input: "", status: "in_progress" }, namespaces); return emit(ev); }
        if (t === "response.output_item.added" && ev.item?.type === "function_call") { ev.item = withNamespace(ev.item, namespaces); return emit(ev); }
        if (t === "response.function_call_arguments.delta" && marked.has(ev.item_id)) return; // deltas of the JSON wrapper are meaningless for the raw input
        if (t === "response.function_call_arguments.done" && marked.has(ev.item_id)) return emit({ ...ev, type: "response.custom_tool_call_input.done", input: customInputFromArgs(ev.arguments), arguments: undefined });
        if (t === "response.output_item.done" && ev.item?.type === "function_call" && custom.has(ev.item.name)) { ev.item = withNamespace(customItem(ev.item), namespaces); return emit(ev); }
        if (t === "response.output_item.done" && ev.item?.type === "function_call") { ev.item = withNamespace(ev.item, namespaces); return emit(ev); }
        if ((t === "response.completed" || t === "response.incomplete" || t === "response.failed") && ev.response) { rewriteResponsesJson(ev.response, custom, namespaces); return emit(ev); }
        emit(ev);
      };
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl; while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
            let ev: Json; try { ev = JSON.parse(data); } catch { continue; }
            if (ev && typeof ev.type === "string") handle(ev); else controller.enqueue(enc.encode(`data: ${data}\n\n`));
          }
        }
      } catch {}
      controller.close();
    },
  });
}

export type TranslatedRequest = { chat: Json; customToolNames: Set<string>; namespaces: ToolIdentityMap; hasImages: boolean; initiator: "user" | "agent"; stream: boolean };

export function responsesToChat(req: Json, supportedEfforts?: string[]): TranslatedRequest {
  const messages: Json[] = [];
  const systemChunks: string[] = [];
  if (typeof req.instructions === "string" && req.instructions.trim()) systemChunks.push(req.instructions);
  const customToolNames = new Set<string>();
  let hasImages = false;

  // tools (namespaces flattened, custom -> function)
  const flat = flattenTools(req.tools);
  let tools: Json[] = flat.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } }));
  let toolChoice: Json;
  if (req.tool_choice) {
    const tc = flattenedToolChoice(req.tool_choice, flat.namespaces);
    if (tc.type === "allowed_tools") {
      const allowed = new Set(tc.tools.map((tool: Json) => tool.name));
      tools = tools.filter((tool) => allowed.has(tool.function.name));
      toolChoice = tc.mode ?? "auto";
      if (!tools.length && toolChoice === "required") throw new ToolMappingError("No allowed tools remain for a required tool choice");
    } else toolChoice = typeof tc === "string" ? tc : { type: "function", function: { name: tc.name } };
  }
  for (const n of flat.customToolNames) customToolNames.add(n);

  // input
  const input = typeof req.input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: req.input }] }] : Array.isArray(req.input) ? req.input : [];
  const pendingToolCalls: Json[] = [];
  const flushAssistant = () => {
    if (pendingToolCalls.length) { messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls.splice(0) }); }
  };
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    const type = it.type ?? (it.role ? "message" : undefined);
    if (type === "message") {
      const role = it.role ?? "user";
      const content = partsToChatContent(it.content);
      if (JSON.stringify(content).includes('"image_url"')) hasImages = true;
      if (role === "system" || role === "developer") { systemChunks.push(contentToText(it.content)); continue; }
      if (role === "assistant") { flushAssistant(); messages.push({ role: "assistant", content: contentToText(it.content) }); continue; }
      flushAssistant(); messages.push({ role: "user", content });
    } else if (type === "function_call") {
      pendingToolCalls.push({ id: it.call_id ?? it.id ?? uid("call"), type: "function", function: { name: inputToolName(it, flat.namespaces), arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) } });
    } else if (type === "custom_tool_call") {
      pendingToolCalls.push({ id: it.call_id ?? it.id ?? uid("call"), type: "function", function: { name: inputToolName(it, flat.namespaces), arguments: JSON.stringify({ input: it.input ?? "" }) } });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushAssistant();
      messages.push({ role: "tool", tool_call_id: it.call_id, content: contentToText(it.output) || "(empty)" });
    } else if (type === "local_shell_call") {
      pendingToolCalls.push({ id: it.call_id ?? uid("call"), type: "function", function: { name: "shell", arguments: JSON.stringify(it.action ?? {}) } });
    } else if (type === "local_shell_call_output") {
      flushAssistant(); messages.push({ role: "tool", tool_call_id: it.call_id, content: contentToText(it.output) || "(empty)" });
    }
    // reasoning items (encrypted), web_search_call etc.: dropped
  }
  flushAssistant();
  if (systemChunks.length) messages.unshift({ role: "system", content: systemChunks.join("\n\n") });

  const chat: Json = { model: req.model, messages, stream: !!req.stream };
  if (tools.length) { chat.tools = tools; chat.parallel_tool_calls = req.parallel_tool_calls ?? true; }
  if (tools.length && toolChoice) chat.tool_choice = toolChoice;
  if (req.stream) chat.stream_options = { include_usage: true };
  if (typeof req.max_output_tokens === "number") chat.max_tokens = req.max_output_tokens;
  if (typeof req.temperature === "number") chat.temperature = req.temperature;
  if (typeof req.top_p === "number") chat.top_p = req.top_p;
  const effort = req.reasoning?.effort;
  if (typeof effort === "string") {
    const ok = !supportedEfforts || supportedEfforts.includes(effort);
    chat.reasoning_effort = ok ? effort : (supportedEfforts?.includes("high") ? "high" : supportedEfforts?.[supportedEfforts.length - 1]);
  }
  const fmt = req.text?.format;
  if (fmt?.type === "json_schema") chat.response_format = { type: "json_schema", json_schema: { name: fmt.name ?? "response", schema: fmt.schema, strict: fmt.strict ?? false } };
  else if (fmt?.type === "json_object") chat.response_format = { type: "json_object" };
  const last = messages[messages.length - 1];
  const initiator = last && last.role === "user" ? "user" : "agent";
  return { chat, customToolNames, namespaces: flat.namespaces, hasImages, initiator, stream: !!req.stream };
}

// ---------- response translation ----------
type ToolAcc = { id: string; callId: string; name: string; args: string; itemIndex: number; custom: boolean };
type StreamToolAcc = ToolAcc & { added: boolean; sentArgs: number };
function usageToResponses(u: Json) {
  if (!u) return undefined;
  return {
    input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
  };
}
function toolItem(t: ToolAcc): Json {
  if (t.custom) {
    let input = t.args; try { const parsed = JSON.parse(t.args); if (parsed && typeof parsed.input === "string") input = parsed.input; } catch {}
    return { type: "custom_tool_call", id: t.id, call_id: t.callId, name: t.name, input, status: "completed" };
  }
  return { type: "function_call", id: t.id, call_id: t.callId, name: t.name, arguments: t.args, status: "completed" };
}

export async function chatToResponsesNonStream(chatRes: Json, req: Json, customToolNames: Set<string>, namespaces?: ToolIdentityMap): Promise<Json> {
  const choice = chatRes.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const output: Json[] = [];
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === "string" && reasoning) output.push({ type: "reasoning", id: uid("rs"), summary: [{ type: "summary_text", text: reasoning }] });
  if (typeof msg.content === "string" && msg.content) output.push({ type: "message", id: uid("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content, annotations: [] }] });
  for (const tc of msg.tool_calls ?? []) output.push(withNamespace(toolItem({ id: uid("fc"), callId: tc.id ?? uid("call"), name: tc.function?.name ?? "", args: tc.function?.arguments ?? "", itemIndex: 0, custom: customToolNames.has(tc.function?.name) }), namespaces));
  return { id: uid("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: chatRes.model ?? req.model, output, usage: usageToResponses(chatRes.usage), error: null, incomplete_details: null };
}

// Streams a chat-completions SSE body and writes Responses-API SSE events to the returned ReadableStream.
export function chatStreamToResponsesStream(upstream: Response, req: Json, customToolNames: Set<string>, onDone?: (info: { status: string; error?: string }) => void, namespaces?: ToolIdentityMap): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const responseId = uid("resp");
  let seq = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, payload: Json) => { controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`)); };
      const base = () => ({ id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: req.model, output: [] as Json[] });
      emit("response.created", { response: { ...base(), status: "in_progress" } });
      emit("response.in_progress", { response: { ...base(), status: "in_progress" } });

      const output: Json[] = [];
      let outputIndex = 0;
      let msg: { id: string; index: number; text: string } | undefined;
      let reasoning: { id: string; index: number; text: string } | undefined;
      const tools = new Map<number, StreamToolAcc>();
      let usage: Json; let finish: string | undefined; let errorText: string | undefined;

      const closeMessage = () => { if (!msg) return; emit("response.output_text.done", { item_id: msg.id, output_index: msg.index, content_index: 0, text: msg.text }); const item = { type: "message", id: msg.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.text, annotations: [] }] }; emit("response.content_part.done", { item_id: msg.id, output_index: msg.index, content_index: 0, part: item.content[0] }); emit("response.output_item.done", { output_index: msg.index, item }); output[msg.index] = item; msg = undefined; };
      const closeReasoning = () => { if (!reasoning) return; emit("response.reasoning_summary_text.done", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, text: reasoning.text }); const item = { type: "reasoning", id: reasoning.id, summary: [{ type: "summary_text", text: reasoning.text }] }; emit("response.reasoning_summary_part.done", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: item.summary[0] }); emit("response.output_item.done", { output_index: reasoning.index, item }); output[reasoning.index] = item; reasoning = undefined; };
      const openTool = (t: StreamToolAcc, final = false) => {
        if (t.added) return;
        // Chat deltas can send arguments before the name, or fragment the name.
        // Never expose a partial alias (or guess its namespace/type) to Codex.
        const known = namespaces?.has(t.name);
        const ambiguousPrefix = namespaces && [...namespaces.keys()].some((name) => name !== t.name && name.startsWith(t.name));
        if (!final && (!known || !t.callId || ambiguousPrefix)) return;
        if (!t.name || (namespaces && !known)) throw new Error("Upstream returned an unknown or incomplete tool name");
        t.custom = customToolNames.has(t.name);
        t.id = uid(t.custom ? "ctc" : "fc");
        t.callId ||= uid("call");
        t.added = true;
        emit("response.output_item.added", { output_index: t.itemIndex, item: withNamespace({
          type: t.custom ? "custom_tool_call" : "function_call", id: t.id, call_id: t.callId, name: t.name,
          ...(t.custom ? { input: "" } : { arguments: "" }), status: "in_progress",
        }, namespaces) });
      };
      const flushToolArgs = (t: StreamToolAcc) => {
        if (!t.added || t.custom || t.sentArgs === t.args.length) return;
        emit("response.function_call_arguments.delta", { item_id: t.id, output_index: t.itemIndex, delta: t.args.slice(t.sentArgs) });
        t.sentArgs = t.args.length;
      };
      const closeTools = () => {
        for (const t of tools.values()) {
          openTool(t, true); flushToolArgs(t);
          const item = withNamespace(toolItem(t), namespaces);
          if (t.custom) emit("response.custom_tool_call_input.done", { item_id: t.id, output_index: t.itemIndex, input: item.input });
          else emit("response.function_call_arguments.done", { item_id: t.id, output_index: t.itemIndex, arguments: t.args });
          emit("response.output_item.done", { output_index: t.itemIndex, item }); output[t.itemIndex] = item;
        }
        tools.clear();
      };

      try {
        const reader = upstream.body!.getReader(); const dec = new TextDecoder(); let buf = "";
        outer: while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim(); if (!data) continue;
            if (data === "[DONE]") break outer;
            let chunk: Json; try { chunk = JSON.parse(data); } catch { continue; }
            if (chunk.error) { errorText = chunk.error.message ?? JSON.stringify(chunk.error); break outer; }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0]; if (!choice) continue;
            const d = choice.delta ?? {};
            const r = d.reasoning_content ?? d.reasoning;
            if (typeof r === "string" && r) {
              if (!reasoning) { closeMessage(); reasoning = { id: uid("rs"), index: outputIndex++, text: "" }; emit("response.output_item.added", { output_index: reasoning.index, item: { type: "reasoning", id: reasoning.id, summary: [] } }); emit("response.reasoning_summary_part.added", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } }); }
              reasoning.text += r; emit("response.reasoning_summary_text.delta", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, delta: r });
            }
            if (typeof d.content === "string" && d.content) {
              closeReasoning();
              if (!msg) { msg = { id: uid("msg"), index: outputIndex++, text: "" }; emit("response.output_item.added", { output_index: msg.index, item: { type: "message", id: msg.id, role: "assistant", status: "in_progress", content: [] } }); emit("response.content_part.added", { item_id: msg.id, output_index: msg.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); }
              msg.text += d.content; emit("response.output_text.delta", { item_id: msg.id, output_index: msg.index, content_index: 0, delta: d.content });
            }
            for (const tc of d.tool_calls ?? []) {
              closeReasoning(); closeMessage();
              const idx = tc.index ?? 0;
              let t = tools.get(idx);
              if (!t) {
                t = { id: "", callId: "", name: "", args: "", itemIndex: outputIndex++, custom: false, added: false, sentArgs: 0 };
                tools.set(idx, t);
              }
              if (tc.id) {
                if (t.callId && t.callId !== tc.id) throw new Error("Upstream changed a tool call ID mid-stream");
                t.callId = tc.id;
              }
              const name = tc.function?.name;
              if (typeof name === "string" && name) {
                if (t.added) { if (name !== t.name) throw new Error("Upstream changed a tool name after it was emitted"); }
                else t.name += name;
              }
              const a = tc.function?.arguments; if (typeof a === "string") t.args += a;
              openTool(t); flushToolArgs(t);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }
      } catch (e) { errorText = String(e); }
      closeReasoning(); closeMessage();
      try { closeTools(); } catch (e) { errorText ??= String(e); }
      const final = output.filter(Boolean);
      if (errorText) {
        emit("error", { code: "upstream_error", message: errorText });
        emit("response.failed", { response: { ...base(), status: "failed", output: final, error: { code: "upstream_error", message: errorText } } });
        onDone?.({ status: "failed", error: errorText });
      } else if (final.length === 0) {
        const limited = finish === "length";
        const status = limited ? "incomplete" : "failed";
        const message = limited
          ? "Upstream reached max_output_tokens before producing any output items (finish_reason=length)."
          : `Upstream stream produced no output items (finish_reason=${finish ?? "absent"}).`;
        const error = limited ? null : { code: "upstream_empty_output", message };
        if (error) emit("error", error);
        emit(`response.${status}`, { response: { ...base(), status, output: final, usage: usageToResponses(usage) ?? null, error, incomplete_details: limited ? { reason: "max_output_tokens" } : null } });
        onDone?.({ status, error: message });
      } else {
        emit("response.completed", { response: { ...base(), status: "completed", output: final, usage: usageToResponses(usage) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, incomplete_details: finish === "length" ? { reason: "max_output_tokens" } : null } });
        onDone?.({ status: "completed" });
      }
      controller.close();
    },
  });
}
