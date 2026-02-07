import { randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";
import type Redis from "ioredis";

import type { RedisBridgeConfig } from "./types.js";
import { STREAM_INBOUND, RESPONSE_KEY_PREFIX } from "./types.js";

/**
 * Create the redis_bridge agent tool.
 *
 * Publishes a message to the inbound Redis Stream and waits for a response
 * on a per-correlation key via BRPOP. Agent and channel are auto-filled from
 * the plugin context so the proxy LLM only needs to pass the message text.
 */
export function createRedisBridgeTool(
  redis: Redis,
  config: RedisBridgeConfig,
  ctx: { agentId?: string; messageChannel?: string },
) {
  return {
    name: "redis_bridge",
    description:
      "Forward the user message to the Effectual Engine for processing. " +
      "Always call this tool with the full user message.",
    parameters: Type.Object({
      message: Type.String({ description: "The full user message to forward to the engine." }),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const message = String(params.message ?? "");
      if (!message.trim()) throw new Error("message is required");

      const correlationId = randomUUID();
      const responseKey = `${RESPONSE_KEY_PREFIX}${correlationId}`;
      const agent = ctx.agentId ?? "unknown";
      const channel = ctx.messageChannel ?? "unknown";

      // Publish to inbound stream
      await redis.xadd(
        STREAM_INBOUND,
        "*",
        "correlationId", correlationId,
        "message", message,
        "from", "proxy", // Engine resolves actual sender from session context
        "agent", agent,
        "channel", channel,
        "timestamp", Date.now().toString(),
      );

      // Wait for response via BRPOP with configurable timeout
      const result = await redis.brpop(responseKey, config.timeoutSeconds);

      if (!result) {
        throw new Error(`Engine response timed out after ${config.timeoutSeconds}s`);
      }

      // result is [key, value] from BRPOP
      const [, raw] = result;
      let parsed: { text?: string; error?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { text: raw };
      }

      if (parsed.error) {
        throw new Error(`Engine error: ${parsed.error}`);
      }

      const text = parsed.text ?? raw;
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  };
}
