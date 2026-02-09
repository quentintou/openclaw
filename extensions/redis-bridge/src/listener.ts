import type Redis from "ioredis";

import type { ClawdbotPluginServiceContext } from "clawdbot/plugin-sdk";

import type { BridgeOutboundEntry, RedisBridgeConfig } from "./types.js";
import { STREAM_OUTBOUND } from "./types.js";

/** Resolve the gateway CLI binary name (openclaw on VPS, clawdbot elsewhere). */
async function resolveCliBinary(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    await exec("openclaw", ["--version"], { timeout: 5_000 });
    return "openclaw";
  } catch {
    return "clawdbot";
  }
}

/**
 * Background listener that reads proactive messages from the engine via
 * Redis Stream `bridge:outbound` using XREADGROUP for reliable delivery.
 *
 * Delivers messages back through the gateway CLI.
 */
export function createOutboundListener(
  redis: Redis,
  config: RedisBridgeConfig,
) {
  let running = false;
  let abortController: AbortController | null = null;
  let cliBinary: string | null = null;

  async function ensureConsumerGroup() {
    try {
      await redis.xgroup("CREATE", STREAM_OUTBOUND, config.consumerGroup, "0", "MKSTREAM");
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && err.message.includes("BUSYGROUP")) return;
      throw err;
    }
  }

  const DEAD_LETTER_MAX_RETRIES = 5;

  async function processEntry(
    entryId: string,
    fields: string[],
    logger: ClawdbotPluginServiceContext["logger"],
  ) {
    // Parse field pairs into an object
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]!] = fields[i + 1] ?? "";
    }

    const entry = data as unknown as BridgeOutboundEntry;
    if (!entry.message || !entry.to || !entry.channel) {
      logger.warn(`[redis-bridge] Skipping malformed outbound entry ${entryId}`);
      await redis.xack(STREAM_OUTBOUND, config.consumerGroup, entryId);
      return;
    }

    // Dead-letter check: if this entry has been retried too many times, ACK and drop it
    try {
      const pending = await redis.xpending(
        STREAM_OUTBOUND, config.consumerGroup, entryId, entryId, 1,
      ) as unknown[];
      if (Array.isArray(pending) && pending.length > 0) {
        const detail = pending[0] as unknown[];
        // XPENDING detail format: [entryId, consumer, idleTime, deliveryCount]
        const deliveryCount = Number(detail?.[3] ?? 0);
        if (deliveryCount > DEAD_LETTER_MAX_RETRIES) {
          logger.error(
            `[redis-bridge] Dead-lettering outbound entry ${entryId} after ${deliveryCount} retries`,
          );
          await redis.xack(STREAM_OUTBOUND, config.consumerGroup, entryId);
          return;
        }
      }
    } catch {
      // XPENDING check is best-effort; proceed with delivery
    }

    logger.info(
      `[redis-bridge] Delivering outbound message to ${entry.to} on ${entry.channel}`,
    );

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      if (!cliBinary) cliBinary = await resolveCliBinary();

      const args = [
        "message", "send",
        "--channel", entry.channel,
        "--target", entry.to,
        "--message", entry.message,
      ];
      // Route via the correct bot account (e.g. "eff" for @effectual_agent_bot)
      if (entry.accountId) args.push("--account", entry.accountId);

      await execFileAsync(cliBinary, args, { timeout: 30_000 });

      // ACK after successful delivery
      await redis.xack(STREAM_OUTBOUND, config.consumerGroup, entryId);
    } catch (err) {
      logger.error(
        `[redis-bridge] Failed to deliver outbound message ${entryId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Don't ACK so it gets redelivered on next read
    }
  }

  async function pollLoop(logger: ClawdbotPluginServiceContext["logger"]) {
    while (running) {
      try {
        // XREADGROUP with 5s block timeout
        const results = await redis.xreadgroup(
          "GROUP", config.consumerGroup, config.consumerName,
          "COUNT", "10",
          "BLOCK", "5000",
          "STREAMS", STREAM_OUTBOUND, ">",
        );

        if (!results) continue;

        for (const [, entries] of results) {
          for (const [entryId, fields] of entries) {
            if (abortController?.signal.aborted) return;
            await processEntry(entryId, fields, logger);
          }
        }
      } catch (err) {
        if (!running) return;
        logger.error(
          `[redis-bridge] Listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Back off with jitter before retrying (avoid thundering herd)
        const jitteredDelay = 3000 * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, jitteredDelay));
      }
    }
  }

  async function resilientPollLoop(logger: ClawdbotPluginServiceContext["logger"]) {
    let backoff = 1000;
    const MAX_BACKOFF = 60_000;

    while (running) {
      try {
        await pollLoop(logger);
        // pollLoop exits normally when running = false
        break;
      } catch (err) {
        if (!running) break;
        logger.error(
          `[redis-bridge] Poll loop crashed, restarting in ${backoff}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        // Jittered exponential backoff to avoid thundering herd on reconnect
        backoff = Math.min(backoff * 2, MAX_BACKOFF) * (0.5 + Math.random() * 0.5);
      }
    }
  }

  return {
    async start(ctx: ClawdbotPluginServiceContext) {
      running = true;
      abortController = new AbortController();
      ctx.logger.info("[redis-bridge] Starting outbound listener");
      await ensureConsumerGroup();
      // Resolve CLI binary at startup
      cliBinary = await resolveCliBinary();
      ctx.logger.info(`[redis-bridge] Using CLI binary: ${cliBinary}`);
      // Fire-and-forget the resilient poll loop (auto-restarts on crash)
      resilientPollLoop(ctx.logger).catch((err) => {
        ctx.logger.error(
          `[redis-bridge] Resilient poll loop exited unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },

    async stop(ctx: ClawdbotPluginServiceContext) {
      running = false;
      abortController?.abort();
      abortController = null;
      ctx.logger.info("[redis-bridge] Outbound listener stopped");
    },
  };
}
