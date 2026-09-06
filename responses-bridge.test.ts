import { describe, expect, test } from "bun:test";
import { normalizeResponsesToolControls, responsesToChat, sanitizeResponsesRequest, trimReasoningItems } from "./responses-bridge.ts";

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
