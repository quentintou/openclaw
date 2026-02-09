import { randomUUID } from "node:crypto";

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import Redis from "ioredis";

import { resolveConfig, isEngineAgent } from "./src/config.js";
import { createRedisBridgeTool } from "./src/tools.js";
import { createOutboundListener } from "./src/listener.js";
import { STREAM_INBOUND, RESPONSE_KEY_PREFIX, PROTOCOL_VERSION } from "./src/types.js";

// Circuit-breaker state for engine availability
let consecutiveFailures = 0;
let circuitOpenedAt = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

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

    // Dedicated connection for blocking BRPOP (ioredis recommends separate connections for blocking commands)
    const redisBlocking = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    let redisReady = false;
    let redisBlockingReady = false;

    redis.on("error", (err) => {
      api.logger.error(`[redis-bridge] Redis error: ${err.message}`);
    });

    redis.on("ready", () => {
      redisReady = true;
      api.logger.info("[redis-bridge] Redis connection ready");
    });

    redis.on("close", () => {
      redisReady = false;
      api.logger.warn("[redis-bridge] Redis connection closed");
    });

    redis.on("reconnecting", () => {
      api.logger.info("[redis-bridge] Redis reconnecting...");
    });

    redisBlocking.on("error", (err) => {
      api.logger.error(`[redis-bridge] Redis (blocking) error: ${err.message}`);
    });

    redisBlocking.on("ready", () => {
      redisBlockingReady = true;
      api.logger.info("[redis-bridge] Redis (blocking) connection ready");
    });

    redisBlocking.on("close", () => {
      redisBlockingReady = false;
      api.logger.warn("[redis-bridge] Redis (blocking) connection closed");
    });

    redisBlocking.on("reconnecting", () => {
      api.logger.info("[redis-bridge] Redis (blocking) reconnecting...");
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
    //
    // CRITICAL: This hook MUST catch all errors. If an exception propagates,
    // ClawdBot falls through to the native LLM which has no Engine skills,
    // causing "sandbox" behavior and hallucinated tool results.
    api.on("before_reply", async (event, ctx) => {
      if (!ctx.agentId || !isEngineAgent(ctx.agentId, config)) return;

      // Circuit breaker — fast-fail if Engine is repeatedly failing
      if (consecutiveFailures >= CIRCUIT_THRESHOLD) {
        const elapsed = Date.now() - circuitOpenedAt;
        if (elapsed < CIRCUIT_COOLDOWN_MS) {
          api.logger.warn(
            `[redis-bridge] Circuit OPEN (${consecutiveFailures} failures), fast-failing`,
          );
          return {
            reply: {
              text: "Le moteur Effectual est temporairement indisponible. Reessaie dans quelques secondes.",
              isError: true,
            },
          };
        }
        // Half-open: allow one request through to test recovery
        api.logger.info("[redis-bridge] Circuit half-open, testing Engine availability");
      }

      const correlationId = randomUUID();
      const responseKey = `${RESPONSE_KEY_PREFIX}${correlationId}`;

      try {
        // Fast-fail if Redis is disconnected — don't wait for a command timeout
        if (!redisReady || !redisBlockingReady) {
          api.logger.error(
            `[redis-bridge] before_reply: Redis not connected, cannot forward ` +
            `(agent=${ctx.agentId}, correlationId=${correlationId})`,
          );
          return {
            reply: {
              text: "Le moteur Effectual est temporairement indisponible (connexion Redis perdue). Reessaie dans quelques secondes.",
              isError: true,
            },
          };
        }

        api.logger.info(
          `[redis-bridge] before_reply: forwarding to engine ` +
          `(agent=${ctx.agentId}, correlationId=${correlationId})`,
        );

        const xaddArgs: string[] = [
          "correlationId", correlationId,
          "message", event.commandBody,
          "from", event.from ?? "proxy",
          "agent", ctx.agentId,
          "channel", event.channel ?? "unknown",
          "accountId", event.accountId ?? ctx.agentId,
          "timestamp", Date.now().toString(),
          "sessionKey", event.sessionKey ?? `${event.channel ?? "unknown"}:${event.accountId ?? ctx.agentId}:${event.from ?? "anon"}`,
          "protocolVersion", PROTOCOL_VERSION,
        ];
        if (event.senderName) xaddArgs.push("senderName", event.senderName);
        if (event.senderUsername) xaddArgs.push("senderUsername", event.senderUsername);
        if (event.senderId) xaddArgs.push("senderId", event.senderId);
        await redis.xadd(STREAM_INBOUND, "*", ...xaddArgs);

        const result = await redisBlocking.brpop(responseKey, config.timeoutSeconds);

        if (!result) {
          consecutiveFailures++;
          if (consecutiveFailures >= CIRCUIT_THRESHOLD) circuitOpenedAt = Date.now();
          api.logger.warn(
            `[redis-bridge] before_reply: engine timeout after ${config.timeoutSeconds}s ` +
            `(correlationId=${correlationId}, consecutiveFailures=${consecutiveFailures})`,
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

        // Success — reset circuit breaker
        consecutiveFailures = 0;
        api.logger.info(
          `[redis-bridge] before_reply: response received (correlationId=${correlationId})`,
        );
        return { reply: { text: parsed.text ?? raw } };
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures >= CIRCUIT_THRESHOLD) circuitOpenedAt = Date.now();
        // NEVER let an exception propagate — that causes silent fallback to native LLM
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(
          `[redis-bridge] before_reply: CAUGHT error, returning explicit failure ` +
          `(agent=${ctx.agentId}, correlationId=${correlationId}, err=${msg})`,
        );
        return {
          reply: {
            text: `Le moteur Effectual a rencontre une erreur: ${msg}. Reessaie dans quelques secondes.`,
            isError: true,
          },
        };
      }
    }, { priority: 100 });

    // Register the outbound listener as a background service
    const listener = createOutboundListener(redis, config);
    api.registerService({
      id: "redis-bridge-outbound",
      start: async (ctx) => {
        await redis.connect();
        await redisBlocking.connect();
        await listener.start(ctx);
      },
      stop: async (ctx) => {
        await listener.stop(ctx);
        await redisBlocking.quit().catch(() => {});
        await redis.quit().catch(() => {});
      },
    });
  },
};

export default plugin;
