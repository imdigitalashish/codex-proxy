export type CatalogEntry = {
  id: string;
  name: string;
  vendor: string;
  endpoints: string[];
  efforts: string[];
  vision: boolean;
  ctx: number;
  picker: boolean;
  toolCalls: boolean;
};

type CatalogOptions = {
  aliases: Record<string, string>;
  extraPickerModels: string[];
  pickerBaseSlug: string;
};

export const supportsResponses = (entry?: CatalogEntry) => !entry || entry.endpoints.includes("/responses");
const supportsChatCompletions = (entry: CatalogEntry) => entry.endpoints.includes("/chat/completions");
export const isUsablePickerModel = (entry: CatalogEntry) =>
  entry.picker && entry.toolCalls && (supportsResponses(entry) || supportsChatCompletions(entry));

const inferenceEfforts = ["low", "medium", "high", "xhigh", "max"];
const harnessUltraModels = new Set(["gpt-6-astra", "gpt-5.6-sol-fast"]);
const effortLabels: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning with automatic task delegation (Codex harness)",
};

export function buildCodexModels(
  template: { models?: any[] },
  catalog: Map<string, CatalogEntry> | undefined,
  { aliases, extraPickerModels, pickerBaseSlug }: CatalogOptions,
): any[] {
  const has = (slug: string) => {
    if (!catalog) return true;
    const entry = catalog.get(aliases[slug] ?? slug);
    return !!entry && isUsablePickerModel(entry);
  };
  // Template efforts include Codex-only modes such as Ultra, not just upstream API values.
  const models = (template.models ?? [])
    .filter((model) => typeof model.slug === "string" && has(model.slug))
    .map((model) => structuredClone(model));
  const present = new Set(models.map((model) => model.slug));
  const base = (template.models ?? []).find((model) => model.slug === pickerBaseSlug) ?? models[0];
  if (!catalog || !base) return models;

  let priority = Math.max(0, ...models.map((model) => Number(model.priority) || 0)) + 1;
  for (const id of new Set([...extraPickerModels, ...catalog.keys()])) {
    const entry = catalog.get(id);
    if (!entry || !isUsablePickerModel(entry) || present.has(id)) continue;
    const native = supportsResponses(entry);
    const openai = /openai/i.test(entry.vendor);
    const efforts = entry.efforts.filter((effort) => inferenceEfforts.includes(effort));
    const clone = structuredClone(base);
    Object.assign(clone, {
      slug: id,
      display_name: `${entry.name}${openai ? "" : " \u00b7 " + entry.vendor}`,
      description: `${entry.vendor || "Model"} via GitHub Copilot${native ? "" : " (chat bridge)"}`,
      priority: priority++, visibility: "list", supported_in_api: true,
      additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
      default_reasoning_level: efforts.includes("medium") ? "medium" : efforts[0] ?? null,
      supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effortLabels[effort] })),
      input_modalities: entry.vision ? ["text", "image"] : ["text"],
      context_window: Math.min(entry.ctx, 400000), max_context_window: entry.ctx,
      tool_mode: null, use_responses_lite: false, supports_reasoning_summary_parameter: false,
      apply_patch_tool_type: "freeform", supports_search_tool: false, web_search_tool_type: "text",
    });
    if (harnessUltraModels.has(id) && openai && native && efforts.length) {
      // Ultra selects proactive V2 instructions locally; Codex sends this real effort to the API.
      clone.multi_agent_version = "v2";
      clone.multi_agent_reasoning_effort = inferenceEfforts.findLast((effort) => efforts.includes(effort));
      clone.supported_reasoning_levels.push({ effort: "ultra", description: effortLabels.ultra });
    }
    if (!openai && clone.model_messages?.instructions_template) {
      clone.model_messages.instructions_template = String(clone.model_messages.instructions_template)
        .replace("an agent based on GPT-5", "a coding agent");
    }
    models.push(clone);
    present.add(id);
  }
  return models;
}
