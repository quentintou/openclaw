import { randomUUID } from "node:crypto";

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import Redis from "ioredis";

import { resolveConfig, isEngineAgent } from "./src/config.js";
import { createRedisBridgeTool } from "./src/tools.js";
import { createOutboundListener } from "./src/listener.js";
import { STREAM_INBOUND, RESPONSE_KEY_PREFIX } from "./src/types.js";

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

    // Register before_reply hook to bypass gateway LLM for engine agents.
    // Messages are forwarded directly to the Effectual Engine via Redis,
    // eliminating the double LLM call (gateway LLM + engine LLM).
    api.on("before_reply", async (event, ctx) => {
      if (!ctx.agentId || !isEngineAgent(ctx.agentId, config)) return;

      const correlationId = randomUUID();
      const responseKey = `${RESPONSE_KEY_PREFIX}${correlationId}`;

      api.logger.info(
        `[redis-bridge] before_reply: forwarding to engine ` +
        `(agent=${ctx.agentId}, correlationId=${correlationId})`,
      );

      await redis.xadd(
        STREAM_INBOUND,
        "*",
        "correlationId", correlationId,
        "message", event.commandBody,
        "from", event.from ?? "proxy",
        "agent", ctx.agentId,
        "channel", event.channel ?? "unknown",
        "accountId", event.accountId ?? ctx.agentId,
        "timestamp", Date.now().toString(),
      );

      const result = await redis.brpop(responseKey, config.timeoutSeconds);

      if (!result) {
        api.logger.warn(
          `[redis-bridge] before_reply: engine timeout after ${config.timeoutSeconds}s ` +
          `(correlationId=${correlationId})`,
        );
        return {
          reply: { text: "The engine did not respond in time. Please try again.", isError: true },
        };
      }

      const [, raw] = result;
      let parsed: { text?: string; error?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { text: raw };
      }

      if (parsed.error) {
        api.logger.error(`[redis-bridge] before_reply: engine error: ${parsed.error}`);
        return { reply: { text: `Engine error: ${parsed.error}`, isError: true } };
      }

      api.logger.info(
        `[redis-bridge] before_reply: response received (correlationId=${correlationId})`,
      );
      return { reply: { text: parsed.text ?? raw } };
    }, { priority: 100 });

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
