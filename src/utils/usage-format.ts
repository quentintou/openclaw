import type { NormalizedUsage } from "../agents/usage.js";
import type { ClawdbotConfig } from "../config/config.js";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "0";
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}m`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(safe));
}

export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

// Fallback cost rates (per 1M tokens) for well-known models when not configured.
// These are approximate and may change; configure exact rates in clawdbot.json
// under models.providers.<provider>.models[].cost for production use.
const FALLBACK_MODEL_COSTS: Record<string, ModelCostConfig> = {
  // OpenRouter models
  "openrouter/xai/grok-4-1-fast-reasoning": { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  "openrouter/moonshot/kimi-k2.5": { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 },
  "openrouter/deepseek/deepseek-r1": { input: 0.55, output: 2.19, cacheRead: 0, cacheWrite: 0 },
  "openrouter/deepseek/deepseek-chat-v3-0324": {
    input: 0.27,
    output: 1.1,
    cacheRead: 0,
    cacheWrite: 0,
  },
};

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: ClawdbotConfig;
}): ModelCostConfig | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) return undefined;
  const providers = params.config?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  if (entry?.cost) return entry.cost;
  // Fall back to built-in rates for well-known models
  return FALLBACK_MODEL_COSTS[`${provider}/${model}`];
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) return undefined;
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);
  const total =
    input * cost.input +
    output * cost.output +
    cacheRead * cost.cacheRead +
    cacheWrite * cost.cacheWrite;
  if (!Number.isFinite(total)) return undefined;
  return total / 1_000_000;
}
