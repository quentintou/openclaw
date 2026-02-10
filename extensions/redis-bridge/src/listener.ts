import type Redis from "ioredis";

import type { ClawdbotPluginServiceContext } from "clawdbot/plugin-sdk";

import type { BridgeOutboundEntry, RedisBridgeConfig } from "./types.js";
import { STREAM_OUTBOUND } from "./types.js";

/** Messages longer than this are auto-published to the content server. */
const PUBLISH_THRESHOLD = 3000;
/** Max chars of body to include in the Telegram summary. */
const SUMMARY_PREVIEW_LEN = 200;

/**
 * Split a message into chunks that fit within `maxLen` characters.
 * Prefers splitting on paragraph boundaries (\n\n), then line breaks (\n),
 * then hard-cuts at maxLen as a last resort.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try splitting on paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 2).trimStart();
      continue;
    }
    // Try splitting on line break
    splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 1).trimStart();
      continue;
    }
    // Hard cut at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

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
 * Extract a title from the message: first markdown heading, or first line,
 * or first 60 chars — whatever fits best.
 */
function extractTitle(text: string): string {
  // Try markdown heading
  const headingMatch = text.match(/^#{1,3}\s+(.+)/m);
  if (headingMatch) return headingMatch[1]!.trim().slice(0, 100);
  // First non-empty line
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (firstLine && firstLine.trim().length <= 100) return firstLine.trim();
  // Truncate
  return text.slice(0, 60).trim() + "...";
}

/**
 * Build a short Telegram-friendly summary with a link to the full content.
 */
function buildTelegramSummary(title: string, body: string, url: string): string {
  // Strip markdown headings and formatting for the preview
  const plain = body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .trim();
  const preview = plain.length > SUMMARY_PREVIEW_LEN
    ? plain.slice(0, SUMMARY_PREVIEW_LEN).trim() + "..."
    : plain;

  return `${title}\n\n${preview}\n\nLire la suite : ${url}`;
}

/**
 * Publish long content to the content server. Returns the public URL on success,
 * or null if publishing fails or is not configured.
 */
async function tryPublish(
  message: string,
  config: RedisBridgeConfig,
  logger: ClawdbotPluginServiceContext["logger"],
): Promise<{ title: string; url: string } | null> {
  if (!config.contentPublisherUrl || !config.contentPublisherToken) return null;

  const title = extractTitle(message);

  try {
    const resp = await fetch(`${config.contentPublisherUrl}/api/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.contentPublisherToken}`,
      },
      body: JSON.stringify({
        title,
        body: message,
        type: "markdown",
        summary: message.slice(0, 200),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      logger.warn(`[redis-bridge] Content publish failed: HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { id: string; url: string };
    // Use the public URL if configured, otherwise use the URL from the server
    const publicUrl = config.contentPublisherPublicUrl
      ? `${config.contentPublisherPublicUrl}/p/${data.id}`
      : data.url;

    logger.info(`[redis-bridge] Published content: ${publicUrl}`);
    return { title, url: publicUrl };
  } catch (err) {
    logger.warn(
      `[redis-bridge] Content publish error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
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

      let messageToSend = entry.message;

      // Auto-publish long messages to the content server
      if (messageToSend.length > PUBLISH_THRESHOLD) {
        const published = await tryPublish(messageToSend, config, logger);
        if (published) {
          messageToSend = buildTelegramSummary(published.title, messageToSend, published.url);
        }
        // If publish failed, fall through to chunked delivery
      }

      // Split long messages to respect Telegram's 4096-char limit.
      const MAX_MSG_LEN = 4000; // leave margin for Telegram's 4096 limit
      const chunks = splitMessage(messageToSend, MAX_MSG_LEN);

      for (const chunk of chunks) {
        const args = [
          "message", "send",
          "--channel", entry.channel,
          "--target", entry.to,
          "--message", chunk,
        ];
        // Route via the correct bot account (e.g. "eff" for @effectual_agent_bot)
        if (entry.accountId) args.push("--account", entry.accountId);

        await execFileAsync(cliBinary, args, { timeout: 30_000 });
      }

      // ACK after successful delivery of all chunks
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
