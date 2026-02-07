import type { RedisBridgeConfig } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_CONSUMER_GROUP = "clawdbot-bridge";
const DEFAULT_CONSUMER_NAME = `clawdbot-${process.pid}`;
const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** Parse config from env vars and optional plugin config. */
export function resolveConfig(
  pluginConfig?: Record<string, unknown>,
): RedisBridgeConfig {
  const agentsEnv = process.env.REDIS_BRIDGE_AGENTS;
  const agentsFromConfig = pluginConfig?.agents;

  let agents: string[] = [];
  if (typeof agentsEnv === "string" && agentsEnv.trim()) {
    agents = agentsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(agentsFromConfig)) {
    agents = agentsFromConfig.filter((a): a is string => typeof a === "string");
  }

  const redisUrl =
    (typeof process.env.REDIS_URL === "string" && process.env.REDIS_URL.trim()) ||
    (typeof pluginConfig?.redisUrl === "string" && pluginConfig.redisUrl) ||
    DEFAULT_REDIS_URL;

  const timeoutSeconds =
    (typeof pluginConfig?.timeoutSeconds === "number" && pluginConfig.timeoutSeconds > 0
      ? pluginConfig.timeoutSeconds
      : undefined) ?? DEFAULT_TIMEOUT_SECONDS;

  const consumerGroup =
    (typeof pluginConfig?.consumerGroup === "string" && pluginConfig.consumerGroup.trim()) ||
    DEFAULT_CONSUMER_GROUP;

  const consumerName =
    (typeof pluginConfig?.consumerName === "string" && pluginConfig.consumerName.trim()) ||
    DEFAULT_CONSUMER_NAME;

  return { agents, redisUrl, timeoutSeconds, consumerGroup, consumerName };
}

/** Check whether a given agent ID is routed through the engine. */
export function isEngineAgent(agentId: string, config: RedisBridgeConfig): boolean {
  return config.agents.includes(agentId);
}
