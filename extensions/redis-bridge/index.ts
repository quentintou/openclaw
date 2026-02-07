import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import Redis from "ioredis";

import { resolveConfig, isEngineAgent } from "./src/config.js";
import { createRedisBridgeTool } from "./src/tools.js";
import { createOutboundListener } from "./src/listener.js";

const plugin = {
  id: "redis-bridge",
  name: "Redis Bridge",
  description: "Bridge agent messages to an external Effectual Engine via Redis Streams",
  configSchema: emptyPluginConfigSchema(),

  register(api: ClawdbotPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    if (config.agents.length === 0) {
      api.logger.warn("[redis-bridge] No agents configured; plugin inactive");
      return;
    }

    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // required for blocking commands (BRPOP/XREADGROUP)
      lazyConnect: true,
    });

    redis.on("error", (err) => {
      api.logger.error(`[redis-bridge] Redis error: ${err.message}`);
    });

    // Register the tool with a factory so it's only available for engine-routed agents
    // The factory injects ctx so the tool auto-fills agent/channel metadata
    api.registerTool(
      (ctx) => {
        if (!ctx.agentId || !isEngineAgent(ctx.agentId, config)) return null;
        return createRedisBridgeTool(redis, config, ctx);
      },
      { optional: true, names: ["redis_bridge"] },
    );

    // Register the outbound listener as a background service
    const listener = createOutboundListener(redis, config);
    api.registerService({
      id: "redis-bridge-outbound",
      start: async (ctx) => {
        await redis.connect();
        await listener.start(ctx);
      },
      stop: async (ctx) => {
        await listener.stop(ctx);
        await redis.quit().catch(() => {});
      },
    });
  },
};

export default plugin;
