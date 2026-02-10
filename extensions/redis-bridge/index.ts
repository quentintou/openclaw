import { randomUUID } from "node:crypto";

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import Redis from "ioredis";

import { createCircuitBreaker } from "./src/circuit-breaker.js";
import { resolveConfig, isEngineAgent } from "./src/config.js";
import { createRateLimiter } from "./src/rate-limiter.js";
import { createRedisBridgeTool } from "./src/tools.js";
import { createOutboundListener } from "./src/listener.js";
import { STREAM_INBOUND, RESPONSE_KEY_PREFIX, PROTOCOL_VERSION } from "./src/types.js";

// Max time to wait for Redis reconnection before fast-failing (ms)
const REDIS_RECONNECT_WAIT_MS = 3_000;
const REDIS_RECONNECT_POLL_MS = 200;
// Max time to wait for Redis connections to be ready at startup (ms)
const REDIS_STARTUP_TIMEOUT_MS = 10_000;

/** Wait for an ioredis instance to emit "ready", with a timeout. */
function waitForReady(client: Redis, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.status === "ready") {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis connection not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    function onReady() {
      cleanup();
      resolve();
    }
    function onError(err: Error) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
    }
    client.once("ready", onReady);
    client.once("error", onError);
  });
}

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

    // Circuit breaker — instance scoped to this register() call, not module-level
    const breaker = createCircuitBreaker();

    // Rate limiter — prevents runaway API costs from bugs, loops, or misconfigured heartbeats
    const rateLimiter = createRateLimiter({
      maxRequestsPerHour: Number(process.env.RATE_LIMIT_GLOBAL_PER_HOUR) || 60,
      maxRequestsPerAgentPerHour: Number(process.env.RATE_LIMIT_AGENT_PER_HOUR) || 20,
      alertChatId: process.env.RATE_LIMIT_ALERT_CHAT_ID ?? "",
      alertCooldownSeconds: Number(process.env.RATE_LIMIT_ALERT_COOLDOWN) || 300,
    });

    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // required for blocking commands (BRPOP/XREADGROUP)
      lazyConnect: true,
    });

    // Dedicated connection for blocking BRPOP (ioredis recommends separate connections for blocking commands)
    const redisBlocking = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    // Check Redis readiness by querying ioredis status directly.
    // This avoids desync between boolean flags and actual connection state
    // (e.g. when "close"/"end" events are missed or connection silently dies).
    function isRedisReady() {
      return redis.status === "ready" && redisBlocking.status === "ready";
    }

    // --- Auto-repair: force reconnect when connections die silently ---
    // ioredis with lazyConnect + maxRetriesPerRequest:null can end up in
    // "end"/"close" state without auto-reconnecting. This guard detects
    // dead connections and forces a reconnect.
    let reconnectInFlight = false;

    async function ensureConnected(): Promise<boolean> {
      if (isRedisReady()) return true;

      // Avoid concurrent reconnect attempts
      if (reconnectInFlight) {
        // Another call is already reconnecting — just wait for it
        const deadline = Date.now() + REDIS_RECONNECT_WAIT_MS;
        while (!isRedisReady() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, REDIS_RECONNECT_POLL_MS));
        }
        return isRedisReady();
      }

      reconnectInFlight = true;
      try {
        api.logger.warn(
          `[redis-bridge] Auto-repair: connections not ready (status=${redis.status}/${redisBlocking.status}), forcing reconnect`,
        );

        // Force reconnect on each client that isn't ready.
        // ioredis .connect() is safe to call — it no-ops if already connecting/ready.
        const reconnects: Promise<void>[] = [];
        if (redis.status !== "ready" && redis.status !== "connecting" && redis.status !== "reconnecting") {
          reconnects.push(
            redis.connect().catch((err) => {
              api.logger.error(`[redis-bridge] Auto-repair: redis.connect() failed: ${err instanceof Error ? err.message : String(err)}`);
            }),
          );
        }
        if (redisBlocking.status !== "ready" && redisBlocking.status !== "connecting" && redisBlocking.status !== "reconnecting") {
          reconnects.push(
            redisBlocking.connect().catch((err) => {
              api.logger.error(`[redis-bridge] Auto-repair: redisBlocking.connect() failed: ${err instanceof Error ? err.message : String(err)}`);
            }),
          );
        }

        if (reconnects.length > 0) {
          await Promise.all(reconnects);
        }

        // Wait for both to become ready (up to REDIS_RECONNECT_WAIT_MS)
        const deadline = Date.now() + REDIS_RECONNECT_WAIT_MS;
        while (!isRedisReady() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, REDIS_RECONNECT_POLL_MS));
        }

        if (isRedisReady()) {
          api.logger.info(
            `[redis-bridge] Auto-repair: reconnected successfully (status=${redis.status}/${redisBlocking.status})`,
          );
          return true;
        }

        api.logger.error(
          `[redis-bridge] Auto-repair: still not ready after ${REDIS_RECONNECT_WAIT_MS}ms (status=${redis.status}/${redisBlocking.status})`,
        );
        return false;
      } finally {
        reconnectInFlight = false;
      }
    }

    redis.on("error", (err) => {
      api.logger.error(`[redis-bridge] Redis error: ${err.message}`);
    });

    redis.on("ready", () => {
      api.logger.info("[redis-bridge] Redis connection ready");
    });

    redis.on("close", () => {
      api.logger.warn("[redis-bridge] Redis connection closed");
    });

    redis.on("end", () => {
      api.logger.warn("[redis-bridge] Redis connection ended");
    });

    redis.on("reconnecting", () => {
      api.logger.info("[redis-bridge] Redis reconnecting...");
    });

    redisBlocking.on("error", (err) => {
      api.logger.error(`[redis-bridge] Redis (blocking) error: ${err.message}`);
    });

    redisBlocking.on("ready", () => {
      api.logger.info("[redis-bridge] Redis (blocking) connection ready");
    });

    redisBlocking.on("close", () => {
      api.logger.warn("[redis-bridge] Redis (blocking) connection closed");
    });

    redisBlocking.on("end", () => {
      api.logger.warn("[redis-bridge] Redis (blocking) connection ended");
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

      // Skip gateway heartbeats — these are designed for the local gateway LLM,
      // not the external Engine. Forwarding them causes ~$100+/day in wasted API calls.
      // Return HEARTBEAT_OK so the gateway's heartbeat system treats it as idle.
      const body = event.commandBody ?? "";
      if (body.includes("HEARTBEAT_OK") || body.includes("Read HEARTBEAT.md")) {
        return { reply: { text: "HEARTBEAT_OK" } };
      }

      // Rate limiter — prevent runaway costs
      const rateLimitMsg = rateLimiter.check(ctx.agentId);
      if (rateLimitMsg) {
        api.logger.warn(`[redis-bridge] Rate limited: ${ctx.agentId} (${JSON.stringify(rateLimiter.stats())})`);
        rateLimiter.sendAlert(rateLimitMsg, ctx.agentId, null, { info: api.logger.info, warn: api.logger.warn, error: api.logger.error } as any).catch(() => {});
        return { reply: { text: rateLimitMsg, isError: true } };
      }
      rateLimiter.record(ctx.agentId);

      // Circuit breaker — fast-fail if Engine is repeatedly failing
      if (breaker.isOpen()) {
        api.logger.warn(
          `[redis-bridge] Circuit OPEN (${breaker.consecutiveFailures} failures), fast-failing`,
        );
        return {
          reply: {
            text: "Le moteur Effectual est temporairement indisponible. Reessaie dans quelques secondes.",
            isError: true,
          },
        };
      }

      if (breaker.isHalfOpen()) {
        // Allow one request through to test recovery
        api.logger.info("[redis-bridge] Circuit half-open, testing Engine availability");
      }

      const correlationId = randomUUID();
      const responseKey = `${RESPONSE_KEY_PREFIX}${correlationId}`;

      try {
        // Auto-repair: if Redis is down, actively reconnect instead of just waiting
        if (!isRedisReady()) {
          const recovered = await ensureConnected();
          if (!recovered) {
            breaker.recordFailure();
            api.logger.error(
              `[redis-bridge] before_reply: Redis auto-repair failed ` +
              `(agent=${ctx.agentId}, correlationId=${correlationId}, status=${redis.status}/${redisBlocking.status}, consecutiveFailures=${breaker.consecutiveFailures})`,
            );
            return {
              reply: {
                text: "Le moteur Effectual est temporairement indisponible (connexion Redis perdue). Reessaie dans quelques secondes.",
                isError: true,
              },
            };
          }
          api.logger.info(
            `[redis-bridge] before_reply: Redis auto-repaired, proceeding (agent=${ctx.agentId})`,
          );
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
        if ((event as Record<string, unknown>).transcript) {
          xaddArgs.push("transcript", String((event as Record<string, unknown>).transcript));
        }
        await redis.xadd(STREAM_INBOUND, "*", ...xaddArgs);

        const result = await redisBlocking.brpop(responseKey, config.timeoutSeconds);

        if (!result) {
          breaker.recordFailure();
          api.logger.warn(
            `[redis-bridge] before_reply: engine timeout after ${config.timeoutSeconds}s ` +
            `(correlationId=${correlationId}, consecutiveFailures=${breaker.consecutiveFailures})`,
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
        breaker.recordSuccess();
        api.logger.info(
          `[redis-bridge] before_reply: response received (correlationId=${correlationId})`,
        );
        return { reply: { text: parsed.text ?? raw } };
      } catch (err) {
        breaker.recordFailure();
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
        // Wait for both connections to be ready before proceeding —
        // prevents before_reply from firing before Redis is connected
        await Promise.all([
          waitForReady(redis, REDIS_STARTUP_TIMEOUT_MS),
          waitForReady(redisBlocking, REDIS_STARTUP_TIMEOUT_MS),
        ]);
        ctx.logger.info("[redis-bridge] Both Redis connections ready");
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
