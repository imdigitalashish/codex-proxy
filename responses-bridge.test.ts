import { describe, expect, test } from "bun:test";
import {
  chatStreamToResponsesStream, chatToResponsesNonStream, flattenTools, normalizeResponsesHistory, normalizeResponsesToolControls,
  responsesToChat, rewriteResponsesJson, rewriteResponsesSse, sanitizeResponsesRequest,
  ToolMappingError, trimReasoningItems, type FlatTools,
} from "./responses-bridge.ts";

const fn = (name = "search") => ({ type: "function", name, parameters: { type: "object", properties: { query: { type: "string" } } } });
const custom = (name = "search") => ({ type: "custom", name, description: "Accept raw text" });
const ns = (name: string, ...tools: any[]) => ({ type: "namespace", name, tools });
const collidingTools = () => [fn(), ns("crm", fn()), ns("support", fn()), ns("editor", custom())];
const publicIdentities = [
  { name: "search" }, { name: "search", namespace: "crm" },
  { name: "search", namespace: "support" }, { name: "search", namespace: "editor" },
];
const wireName = (flat: FlatTools, name: string, namespace?: string) => {
  const match = [...flat.namespaces].find(([, identity]) => identity.name === name && identity.namespace === namespace);
  if (!match) throw new Error(`Missing fixture tool: ${namespace}.${name}`);
  return match[0];
};
const wireCalls = (flat: FlatTools) => flat.tools.map((tool, i) => ({
  type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: tool.name,
  arguments: JSON.stringify(flat.customToolNames.has(tool.name) ? { input: "raw\ntext \u00e9" } : { query: `q${i}` }), status: "completed",
}));
const expectedCalls = () => publicIdentities.map((identity, i) => ({
  ...identity, call_id: `call_${i}`, status: "completed",
  ...(i === 3 ? { type: "custom_tool_call", input: "raw\ntext \u00e9" }
    : { type: "function_call", arguments: JSON.stringify({ query: `q${i}` }) }),
}));
const parseEvents = (text: string) => text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
  .map((line) => JSON.parse(line.slice(6)));
const sseResponse = (events: any[], chunkBytes = 13) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.slice(i, i + chunkBytes));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
};
const chatDelta = (tool_calls: any[], finish_reason: string | null = null) => ({ choices: [{ delta: { tool_calls }, finish_reason }] });

describe("namespace-safe tool identities", () => {
  test("keeps root and namespaced functions/custom tools with the same short name distinct", () => {
    const original = collidingTools();
    const before = structuredClone(original);
    const flat = flattenTools(original);
    const names = flat.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(4);
    expect(names[0]).toBe("search");
    expect([...flat.namespaces.values()]).toEqual(publicIdentities);
    expect([...flat.customToolNames]).toEqual([names[3]]);
    expect(flat.dropped).toEqual([]);
    expect(original).toEqual(before);
  });

  test("custom tools in separate namespaces never share their function wrapper name", () => {
    const flat = flattenTools([ns("one", custom()), ns("two", custom()), custom()]);
    expect(new Set(flat.tools.map((tool) => tool.name)).size).toBe(3);
    expect(flat.customToolNames.size).toBe(3);
    expect(flat.tools.every((tool) => tool.type === "function" && tool.parameters.required[0] === "input")).toBe(true);
  });

  test("aliases are stable across ordering, subsets, and previously unseen collisions", () => {
    const tools = collidingTools();
    const all = flattenTools(tools);
    expect(flattenTools([...tools].reverse()).namespaces).toEqual(all.namespaces);
    for (const tool of tools) {
      const only = flattenTools([tool]);
      const [name, identity] = [...only.namespaces][0];
      expect(all.namespaces.get(name)).toEqual(identity);
    }
  });

  test("aliases are valid, bounded, separator-safe, and cannot be spoofed by a root name", () => {
    const tools = [ns("a__b", fn("c")), ns("a", fn("b__c")), ns("a.b", fn("c")),
      ns("a_b", fn("c")), ns("n".repeat(90), fn("long".repeat(40))), fn("\u00e9 invalid.name"), fn("x".repeat(65))];
    const first = flattenTools(tools);
    const reserved = first.tools[0].name;
    const flat = flattenTools([...tools, fn(reserved)]);
    const names = flat.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(tools.length + 1);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(names[0]).toBe(reserved);
    expect(names.at(-1)).not.toBe(reserved);
    expect(flat.namespaces.get(names.at(-1))).toEqual({ name: reserved });
    expect(sanitizeResponsesRequest({ tools: [...tools, fn(reserved)], input: [
      { type: "function_call", call_id: "reserved", name: reserved, arguments: "{}" },
    ] }).request.input[0].name).toBe(names.at(-1));
  });

  test.each([fn(), custom()])("coalesces only identical declarations of the same logical tool: %j", (tool) => {
    const flat = flattenTools([tool, structuredClone(tool), ns("one", tool), ns("one", structuredClone(tool))]);
    expect(flat.tools).toHaveLength(2);
    expect(flat.namespaces.size).toBe(2);
  });

  test.each([
    [fn(), { ...fn(), description: "different" }],
    [fn(), custom()],
    [ns("one", fn()), ns("one", { ...fn(), parameters: { type: "object", properties: {} } })],
  ])("rejects conflicting declarations instead of choosing a tool silently: %j", (...tools) => {
    expect(() => flattenTools(tools)).toThrow(ToolMappingError);
    expect(() => flattenTools(tools)).toThrow("Conflicting tool definitions");
  });

  test.each([fn(""), ns("", fn()), { ...fn(), name: 1 }])("rejects invalid public identities: %j", (tool) => {
    expect(() => flattenTools([tool])).toThrow(ToolMappingError);
  });

  test("retains schema filtering without creating mappings for dropped tools", () => {
    const flat = flattenTools([ns("one", fn(), { ...fn("bad"), parameters: { type: "string" } }), { type: "web_search" }], { strictSchemas: true });
    expect(flat.tools).toHaveLength(1);
    expect(flat.namespaces.size).toBe(1);
    expect(flat.dropped).toEqual(["one.bad(non-object schema)", "web_search"]);
  });
});

describe("mapped tool choices and history", () => {
  test.each([
    { type: "function", name: "search" }, { type: "function", name: "search", namespace: "crm" },
    { type: "custom", name: "search", namespace: "editor" },
  ])("maps forced choices by complete identity: %j", (choice) => {
    const tools = collidingTools();
    const name = wireName(flattenTools(tools), choice.name, choice.namespace);
    const req = { tools, tool_choice: choice, input: "go" };
    expect(sanitizeResponsesRequest(req).request.tool_choice).toEqual({ type: "function", name });
    expect(responsesToChat(req).chat.tool_choice).toEqual({ type: "function", function: { name } });
    expect(req.tool_choice).toEqual(choice);
  });

  test.each(["auto", "none", "required"])("preserves the %s tool-choice mode", (tool_choice) => {
    const req = { tools: collidingTools(), tool_choice, input: "go" };
    expect(sanitizeResponsesRequest(req).request.tool_choice).toBe(tool_choice);
    expect(responsesToChat(req).chat.tool_choice).toBe(tool_choice);
  });

  test.each(["auto", "required"])("preserves allowed_tools restrictions in %s mode", (mode) => {
    const tools = collidingTools();
    const flat = flattenTools(tools);
    const allowed = [wireName(flat, "search", "crm"), wireName(flat, "search", "editor")];
    const req = { tools, input: "go", tool_choice: { type: "allowed_tools", mode, tools: [
      { type: "function", name: "search", namespace: "crm" }, { type: "custom", name: "search", namespace: "editor" },
    ] } };
    expect(sanitizeResponsesRequest(req).request.tool_choice).toEqual({ type: "allowed_tools", mode, tools: allowed.map((name) => ({ type: "function", name })) });
    const { chat } = responsesToChat(req);
    expect(chat.tools.map((tool: any) => tool.function.name)).toEqual(allowed);
    expect(chat.tool_choice).toBe(mode);
  });

  test("an empty allowed_tools auto list does not broaden access to every Chat tool", () => {
    const { chat } = responsesToChat({ tools: collidingTools(), input: "go", tool_choice: { type: "allowed_tools", mode: "auto", tools: [] } });
    expect(chat).not.toHaveProperty("tools");
    expect(chat).not.toHaveProperty("tool_choice");
  });

  test.each([
    { type: "function", name: "missing" }, { type: "custom", name: "search", namespace: "missing" },
    { type: "web_search" }, { type: "allowed_tools", mode: "required", tools: [] },
    { type: "allowed_tools", mode: "invalid", tools: [] },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "missing" }] },
  ])("fails closed for unknown or unsupported choices: %j", (tool_choice) => {
    for (const tools of [collidingTools(), []]) {
      const req = { tools, input: "go", tool_choice };
      expect(() => responsesToChat(req)).toThrow(ToolMappingError);
      expect(() => sanitizeResponsesRequest(req)).toThrow(ToolMappingError);
    }
  });

  test("round-trips function/custom history without changing call IDs, outputs, or caller data", () => {
    const tools = collidingTools();
    const flat = flattenTools(tools);
    const calls = expectedCalls();
    const outputs = calls.map((call, i) => ({ type: i === 3 ? "custom_tool_call_output" : "function_call_output", call_id: call.call_id, output: `result${i}` }));
    const req = { tools, input: [{ role: "user", content: "go" }, ...calls, ...outputs] };
    const before = structuredClone(req);
    const { request } = sanitizeResponsesRequest(req);
    expect(request.input.slice(1, 5).map((call: any) => call.name)).toEqual(flat.tools.map((tool) => tool.name));
    expect(request.input.slice(1, 5).every((call: any) => call.namespace === undefined && call.type === "function_call")).toBe(true);
    expect(request.input.slice(1, 5).map((call: any) => call.call_id)).toEqual(calls.map((call) => call.call_id));
    expect(request.input.slice(5)).toEqual(outputs.map((item) => ({ ...item, type: "function_call_output" })));
    const { chat } = responsesToChat(req);
    expect(chat.messages[1].tool_calls.map((call: any) => ({ name: call.function.name, id: call.id, arguments: call.function.arguments })))
      .toEqual(wireCalls(flat).map((call) => ({ name: call.name, id: call.call_id, arguments: call.arguments })));
    expect(chat.messages.slice(2)).toEqual(outputs.map((item) => ({ role: "tool", tool_call_id: item.call_id, content: item.output })));
    expect(req).toEqual(before);
  });

  test("historical namespaced tools keep their alias when absent from today's tool list", () => {
    const previous = flattenTools([ns("retired", fn())]);
    const name = wireName(previous, "search", "retired");
    const req = { tools: collidingTools(), input: [{ type: "function_call", call_id: "old", name: "search", namespace: "retired", arguments: "{}" }] };
    expect(sanitizeResponsesRequest(req).request.input[0].name).toBe(name);
    expect(responsesToChat(req).chat.messages[0].tool_calls[0].function.name).toBe(name);
  });

  test("legacy unqualified history and choices are inferred only for a unique identity", () => {
    const tools = [ns("one", custom())];
    const name = wireName(flattenTools(tools), "search", "one");
    const req = { tools, tool_choice: { type: "custom", name: "search" }, input: [{ type: "custom_tool_call", call_id: "legacy", name: "search", input: "raw" }] };
    expect(sanitizeResponsesRequest(req).request.input[0].name).toBe(name);
    expect(responsesToChat(req).chat.messages[0].tool_calls[0].function.name).toBe(name);
    expect(responsesToChat(req).chat.tool_choice.function.name).toBe(name);
    req.tools.push(ns("two", custom()));
    expect(() => responsesToChat(req)).toThrow("Ambiguous tool reference");
    expect(() => sanitizeResponsesRequest(req)).toThrow("Ambiguous tool reference");
    const historyOnly = { ...req, tool_choice: "auto" };
    expect(() => responsesToChat(historyOnly)).toThrow("Ambiguous tool reference");
    expect(() => sanitizeResponsesRequest(historyOnly)).toThrow("Ambiguous tool reference");
  });
});

describe("restoring tool calls to their public identities", () => {
  test("restores native Responses JSON and non-streamed Chat calls, including custom inputs", async () => {
    const flat = flattenTools(collidingTools());
    const calls = wireCalls(flat);
    const native = rewriteResponsesJson({ output: structuredClone(calls) }, flat.customToolNames, flat.namespaces);
    expect(native.output).toMatchObject(expectedCalls());
    const chat = await chatToResponsesNonStream({ choices: [{ message: { tool_calls: calls.map((call) => ({
      id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments },
    })) } }] }, { model: "claude-opus-5" }, flat.customToolNames, flat.namespaces);
    expect(chat.output).toMatchObject(expectedCalls());
    expect(native.output[0]).not.toHaveProperty("namespace");
    expect(chat.output[3]).not.toHaveProperty("arguments");
  });

  test.each(["response.completed", "response.incomplete", "response.failed"])("rewrites native Responses SSE at added, done, and %s", async (terminalType) => {
    const flat = flattenTools(collidingTools());
    const calls = wireCalls(flat);
    const upstream = sseResponse([
      ...calls.map((item, output_index) => ({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } })),
      ...calls.flatMap((item, output_index) => [
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: terminalType, response: { output: calls } },
    ]);
    const events = parseEvents(await new Response(rewriteResponsesSse(upstream, flat.customToolNames, flat.namespaces)).text());
    const added = events.filter((event) => event.type === "response.output_item.added");
    expect(added.map((event) => event.item)).toMatchObject(expectedCalls().map(({ status, input, arguments: args, ...item }) => ({
      ...item, status: "in_progress", ...(item.type === "custom_tool_call" ? { input: "" } : { arguments: "" }),
    })));
    expect(events.filter((event) => event.type === "response.output_item.done").map((event) => event.item)).toMatchObject(expectedCalls());
    expect(events.at(-1).response.output).toMatchObject(expectedCalls());
    expect(events.filter((event) => event.item_id === "fc_3").map((event) => event.type)).toEqual(["response.custom_tool_call_input.done"]);
    expect(events.find((event) => event.type === "response.custom_tool_call_input.done").input).toBe("raw\ntext \u00e9");
  });

  test.each([false, true])("Chat SSE preserves identities through parallel/interleaved calls (fragmented=%s)", async (fragmented) => {
    const flat = flattenTools(collidingTools());
    const calls = wireCalls(flat);
    const chunks: any[] = [];
    if (fragmented) {
      // Arguments first, then fragments, then IDs: no partial identity may escape.
      chunks.push(chatDelta(calls.map((call, index) => ({ index, function: { arguments: call.arguments.slice(0, 4) } }))));
      chunks.push(chatDelta(calls.map((call, index) => ({ index, function: { name: call.name.slice(0, 3) } }))));
      chunks.push(chatDelta(calls.map((call, index) => ({ index, function: { name: call.name.slice(3) } }))));
      chunks.push(chatDelta(calls.map((call, index) => ({ index, id: call.call_id }))));
    } else {
      chunks.push(chatDelta(calls.map((call, index) => ({ index, id: call.call_id, function: { name: call.name, arguments: call.arguments.slice(0, 4) } }))));
    }
    for (const index of [3, 1, 0, 2]) chunks.push(chatDelta([{ index, function: { arguments: calls[index].arguments.slice(4) } }]));
    chunks.push(chatDelta([], "tool_calls"));
    chunks.push({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } });
    const done: any[] = [];
    const stream = chatStreamToResponsesStream(sseResponse(chunks), { model: "claude-opus-5" }, flat.customToolNames, (info) => done.push(info), flat.namespaces);
    const events = parseEvents(await new Response(stream).text());
    const added = events.filter((event) => event.type === "response.output_item.added");
    const completed = events.filter((event) => event.type === "response.output_item.done");
    expect(added.map((event) => event.item)).toMatchObject(expectedCalls().map(({ status, input, arguments: args, ...item }) => ({ ...item, status: "in_progress" })));
    expect(completed.map((event) => event.item)).toMatchObject(expectedCalls());
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response: { output: expectedCalls(), usage: { input_tokens: 5, output_tokens: 7 } } });
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, i) => i));
    expect(done).toEqual([{ status: "completed" }]);
    for (const event of added) {
      const argumentEvents = events.filter((item) => item.item_id === event.item.id);
      expect(argumentEvents.every((item) => item.sequence_number > event.sequence_number)).toBe(true);
      if (event.item.type === "custom_tool_call") {
        expect(argumentEvents.map((item) => item.type)).toEqual(["response.custom_tool_call_input.done"]);
        expect(argumentEvents[0].input).toBe("raw\ntext \u00e9");
      } else {
        expect(argumentEvents.filter((item) => item.type.endsWith(".delta")).map((item) => item.delta).join(""))
          .toBe(calls[event.output_index].arguments);
      }
    }
  });

  test("a fragmented name matching a shorter root tool is not dispatched prematurely", async () => {
    const flat = flattenTools([fn("lookup"), fn("lookup_more")]);
    const chunks = [
      chatDelta([{ index: 0, id: "long", function: { name: "lookup" } }, { index: 1, id: "short", function: { name: "lookup", arguments: "{}" } }]),
      chatDelta([{ index: 0, function: { name: "_more", arguments: "{}" } }], "tool_calls"),
    ];
    const events = parseEvents(await new Response(chatStreamToResponsesStream(sseResponse(chunks), {}, flat.customToolNames, undefined, flat.namespaces)).text());
    expect(events.filter((event) => event.type === "response.output_item.added").map((event) => ({ name: event.item.name, call_id: event.item.call_id })))
      .toEqual([{ name: "lookup_more", call_id: "long" }, { name: "lookup", call_id: "short" }]);
    expect(events.at(-1).response.output.map((item: any) => item.name)).toEqual(["lookup_more", "lookup"]);
  });

  test.each(["", "_cp_incomplete", "not_a_declared_tool"])("fails a malformed upstream stream without dispatching the name %j", async (name) => {
    const flat = flattenTools(collidingTools());
    const stream = chatStreamToResponsesStream(sseResponse([chatDelta([{ index: 0, id: "bad", function: { name, arguments: "{}" } }], "tool_calls")]),
      {}, flat.customToolNames, undefined, flat.namespaces);
    const events = parseEvents(await new Response(stream).text());
    expect(events.some((event) => event.type === "response.output_item.added")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", output: [] } });
  });
});

describe("tool request normalization", () => {
  test("direct Responses requests omit controls when tools are empty", () => {
    const request = normalizeResponsesToolControls({
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: "hello",
    });

    expect(request).toEqual({ input: "hello" });
  });

  test("chat bridge omits tool choice when no tools survive", () => {
    const { chat } = responsesToChat({
      model: "claude-opus-5",
      input: "hello",
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });

    expect(chat).not.toHaveProperty("tools");
    expect(chat).not.toHaveProperty("tool_choice");
    expect(chat).not.toHaveProperty("parallel_tool_calls");
  });

  test("native bridge converts custom-tool history to function history", () => {
    const { request } = sanitizeResponsesRequest({
      tools: [{ type: "custom", name: "apply_patch" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "patch", status: "completed" },
        { type: "custom_tool_call_output", id: "out_1", call_id: "call_1", output: "Done" },
      ],
    });

    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toBe("auto");
    expect(request.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "apply_patch", arguments: JSON.stringify({ input: "patch" }) },
      { type: "function_call_output", id: "out_1", call_id: "call_1", output: "Done" },
    ]);
    expect(request).not.toHaveProperty("include");
  });

  test("native bridge removes tool-only options when every tool is dropped", () => {
    const { request } = sanitizeResponsesRequest({
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: "hello",
    });

    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).not.toHaveProperty("parallel_tool_calls");
  });
});

describe("trimReasoningItems", () => {
  const rs = (id: string) => ({ type: "reasoning", id, encrypted_content: "x".repeat(50) });
  const input = () => [
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    rs("rs_1"), { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" },
    rs("rs_2"), { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "" }, { type: "custom_tool_call_output", call_id: "c2", output: "ok" },
    rs("rs_3"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ];

  test("keeps the newest N reasoning items and every non-reasoning item", () => {
    const req = { input: input() };
    expect(trimReasoningItems(req, 1)).toBe(2);
    expect(req.input.filter((i: any) => i.type === "reasoning").map((i: any) => i.id)).toEqual(["rs_3"]);
    expect(req.input).toHaveLength(7);
    expect(req.input.map((i: any) => i.type ?? i.role)).toEqual(["user", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning", "message"]);
  });

  test("keep=0 drops all reasoning; nothing to drop returns 0; string input is untouched", () => {
    const req = { input: input() };
    expect(trimReasoningItems(req, 0)).toBe(3);
    expect(trimReasoningItems(req, 0)).toBe(0);
    expect(trimReasoningItems({ input: input() }, 5)).toBe(0);
    expect(trimReasoningItems({ input: "hello" }, 0)).toBe(0);
  });
});

// Replaying a thread across vendors: history minted by one provider carries that
// provider's item ids, which the next provider rejects (ctco_* where fc_* is expected).
describe("normalizeResponsesHistory", () => {
  const history = () => [
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "reasoning", id: "rs_1", encrypted_content: "x" },
    { type: "function_call", id: "fc_1", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "function_call_output", id: "fco_1", call_id: "c1", output: "ok" },
    { type: "custom_tool_call", id: "ctc_1", call_id: "toolu_abc", name: "apply_patch", input: "patch" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "toolu_abc", output: "done" },
  ];

  test("drops tool item ids while preserving call_id pairing and every other field", () => {
    const out = normalizeResponsesHistory({ model: "m", input: history() });
    expect(out.input.map((i: any) => i.id)).toEqual([undefined, "rs_1", undefined, undefined, undefined, undefined]);
    expect(out.input.map((i: any) => i.call_id)).toEqual([undefined, undefined, "c1", "c1", "toolu_abc", "toolu_abc"]);
    expect(out.input[4]).toEqual({ type: "custom_tool_call", call_id: "toolu_abc", name: "apply_patch", input: "patch" });
    expect(out.model).toBe("m");
  });

  test("leaves non-tool history untouched, is immutable, idempotent, and ignores non-array input", () => {
    const req = { input: history() };
    const once = normalizeResponsesHistory(req);
    expect(req.input[4].id).toBe("ctc_1");
    expect(normalizeResponsesHistory(once)).toEqual(once);
    expect(normalizeResponsesHistory({ input: "hello" })).toEqual({ input: "hello" });
  });
});

// An upstream stream that yields no output items is a failure, not a successful empty turn.
describe("empty translated streams", () => {
  const drain = async (events: any[]) => {
    const seen: { status: string; error?: string }[] = [];
    const stream = chatStreamToResponsesStream(sseResponse(events), { model: "m", stream: true }, new Set(), (info) => { seen.push(info); });
    const text = await new Response(stream).text();
    return { events: parseEvents(text), done: seen[0] };
  };

  test("reports an upstream anomaly when no output item and no finish reason arrive", async () => {
    const { events, done } = await drain([{ choices: [{ delta: {} }] }, { usage: { prompt_tokens: 9, completion_tokens: 0 } }]);
    const terminal = events.at(-1);
    expect(terminal.type).toBe("response.failed");
    expect(terminal.response.status).toBe("failed");
    expect(terminal.response.error.code).toBe("upstream_empty_output");
    expect(terminal.response.error.message).toContain("finish_reason=absent");
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
    expect(done.status).toBe("failed");
  });

  test("reports a length limit when the model was cut off before emitting anything", async () => {
    const { events, done } = await drain([{ choices: [{ delta: {}, finish_reason: "length" }] }]);
    const terminal = events.at(-1);
    expect(terminal.type).toBe("response.incomplete");
    expect(terminal.response.status).toBe("incomplete");
    expect(terminal.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(terminal.response.error).toBeNull();
    expect(done.status).toBe("incomplete");
  });

  test("still completes normally when the stream produced text", async () => {
    const { events, done } = await drain([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]);
    const terminal = events.at(-1);
    expect(terminal.type).toBe("response.completed");
    expect(terminal.response.status).toBe("completed");
    expect(done.status).toBe("completed");
  });
});
