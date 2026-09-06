import { describe, expect, test } from "bun:test";
import { buildCodexModels, type CatalogEntry } from "./model-catalog.ts";

const levels = ["low", "medium", "high", "xhigh", "max"];
const base = () => ({
  slug: "gpt-5.4-mini", priority: 3, default_reasoning_level: "medium",
  supported_reasoning_levels: levels.slice(0, 4).map((effort) => ({ effort, description: effort })),
  model_messages: { instructions_template: "Fixture instructions", multi_agent: null },
  tool_mode: null,
});
const entry = (id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name: id, vendor: "OpenAI", endpoints: ["/responses"], efforts: levels,
  vision: true, ctx: 1000000, picker: true, toolCalls: true, ...overrides,
});
const options = { aliases: {}, extraPickerModels: ["gpt-6-astra"], pickerBaseSlug: "gpt-5.4-mini" };
const catalog = (...entries: CatalogEntry[]) => new Map(entries.map((model) => [model.id, model]));

describe("Codex harness catalog", () => {
  test("preserves template Ultra and harness metadata even when the API does not advertise Ultra", () => {
    const models = ["gpt-5.6-sol", "gpt-5.6-terra"].map((slug) => ({
      ...base(), slug, multi_agent_version: "v2", tool_mode: "code_mode_only",
      supported_reasoning_levels: [...levels, "ultra"].map((effort) => ({ effort, description: effort })),
    }));
    const template = { models };
    const snapshot = structuredClone(template);
    const result = buildCodexModels(template, catalog(...models.map((model) => entry(model.slug))), options);
    expect(result).toEqual(models);
    expect(template).toEqual(snapshot);
    expect(result[0]).not.toBe(models[0]);
  });

  test("Astra gets a distinct Ultra picker option, V2, and a valid API mapping without changing its default", () => {
    const upstream = catalog(entry("gpt-5.4-mini"), entry("gpt-6-astra"));
    const template = { models: [base()] };
    const snapshot = structuredClone(template);
    const result = buildCodexModels(template, upstream, options);
    const astra = result.find((model) => model.slug === "gpt-6-astra");
    expect(astra).toMatchObject({
      multi_agent_version: "v2", multi_agent_reasoning_effort: "max",
      default_reasoning_level: "medium", tool_mode: null, use_responses_lite: false,
      visibility: "list", context_window: 400000, max_context_window: 1000000,
    });
    expect(astra.supported_reasoning_levels.map((level: any) => level.effort)).toEqual([...levels, "ultra"]);
    expect(upstream.get("gpt-6-astra")?.efforts).toEqual(levels);
    expect(template).toEqual(snapshot);
    expect(result.filter((model) => model.slug === "gpt-6-astra")).toHaveLength(1);
  });

  test("Astra's API mapping follows available effort capabilities rather than assuming max", () => {
    const result = buildCodexModels({ models: [base()] }, catalog(entry("gpt-6-astra", { efforts: ["low", "high"] })), options);
    expect(result[0].multi_agent_reasoning_effort).toBe("high");
    expect(result[0].supported_reasoning_levels.map((level: any) => level.effort)).toEqual(["low", "high", "ultra"]);
  });

  test("does not invent Ultra for other generated models or models without supported inference efforts", () => {
    const result = buildCodexModels({ models: [base()] }, catalog(
      entry("claude-opus-5", { vendor: "Anthropic", endpoints: ["/chat/completions"] }),
      entry("gpt-6-astra", { efforts: [] }),
      entry("gpt-5.6-luna"),
    ), options);
    for (const model of result) {
      expect(model.supported_reasoning_levels.some((level: any) => level.effort === "ultra")).toBe(false);
      expect(model.multi_agent_reasoning_effort).toBeUndefined();
    }
    expect(result.find((model) => model.slug === "claude-opus-5").description).toContain("(chat bridge)");
  });

  test("keeps model ordering, aliases, eligibility filtering, and uniqueness", () => {
    const template = { models: [base(), { ...base(), slug: "gpt-reserve", visibility: "hide" }] };
    const result = buildCodexModels(template, catalog(
      entry("gpt-5.4-mini"), entry("gpt-5.6-sol"), entry("claude-opus-5"),
      entry("gpt-6-astra"), entry("disabled", { picker: false }),
      entry("no-tools", { toolCalls: false }), entry("embedding", { endpoints: ["/embeddings"] }),
    ), { ...options, aliases: { "gpt-reserve": "gpt-5.6-sol" }, extraPickerModels: ["gpt-6-astra", "gpt-6-astra", "claude-opus-5"] });
    expect(result.map((model) => model.slug)).toEqual([
      "gpt-5.4-mini", "gpt-reserve", "gpt-6-astra", "claude-opus-5", "gpt-5.6-sol",
    ]);
    expect(result[1].visibility).toBe("hide");
    expect(result.slice(2).map((model) => model.priority)).toEqual([4, 5, 6]);
  });

  test("retains the original template when catalog discovery is unavailable", () => {
    const template = { models: [base()] };
    expect(buildCodexModels(template, undefined, options)).toEqual(template.models);
    expect(buildCodexModels({}, undefined, options)).toEqual([]);
    expect(buildCodexModels({}, catalog(entry("gpt-6-astra")), options)).toEqual([]);
  });
});
