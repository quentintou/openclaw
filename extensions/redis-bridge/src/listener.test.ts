import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createOutboundListener } from "./listener.js";
import type { RedisBridgeConfig } from "./types.js";
import { STREAM_OUTBOUND } from "./types.js";

function createMockRedis() {
  return {
    xgroup: vi.fn().mockResolvedValue("OK"),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
  };
}

function createMockCtx() {
  return {
    config: {} as any,
    workspaceDir: "/tmp",
    stateDir: "/tmp/state",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

const defaultConfig: RedisBridgeConfig = {
  agents: ["test-agent"],
  redisUrl: "redis://localhost:6379",
  timeoutSeconds: 10,
  consumerGroup: "test-group",
  consumerName: "test-consumer",
};

describe("outbound listener", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    ctx = createMockCtx();
  });

  it("creates consumer group on start", async () => {
    // Stop immediately after start to prevent infinite loop
    mockRedis.xreadgroup.mockImplementation(async () => {
      // Small delay then stop
      await new Promise((r) => setTimeout(r, 10));
      return null;
    });

    const listener = createOutboundListener(mockRedis as any, defaultConfig);
    await listener.start(ctx);
    // Give it a tick to call ensureConsumerGroup
    await new Promise((r) => setTimeout(r, 20));
    await listener.stop(ctx);

    expect(mockRedis.xgroup).toHaveBeenCalledWith(
      "CREATE",
      STREAM_OUTBOUND,
      "test-group",
      "0",
      "MKSTREAM",
    );
  });

  it("ignores BUSYGROUP error (group already exists)", async () => {
    mockRedis.xgroup.mockRejectedValue(new Error("BUSYGROUP Consumer Group already exists"));
    mockRedis.xreadgroup.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return null;
    });

    const listener = createOutboundListener(mockRedis as any, defaultConfig);
    // Should not throw
    await listener.start(ctx);
    await new Promise((r) => setTimeout(r, 20));
    await listener.stop(ctx);
  });

  it("ACKs malformed entries (missing required fields)", async () => {
    let callCount = 0;
    mockRedis.xreadgroup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Return an entry missing the "to" field
        return [
          [
            STREAM_OUTBOUND,
            [["entry-1", ["message", "hello", "channel", "telegram"]]],
          ],
        ];
      }
      // Subsequent calls return null (empty)
      await new Promise((r) => setTimeout(r, 50));
      return null;
    });

    const listener = createOutboundListener(mockRedis as any, defaultConfig);
    await listener.start(ctx);
    await new Promise((r) => setTimeout(r, 100));
    await listener.stop(ctx);

    expect(mockRedis.xack).toHaveBeenCalledWith(
      STREAM_OUTBOUND,
      "test-group",
      "entry-1",
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("malformed"),
    );
  });

  it("stop sets running to false and logs", async () => {
    mockRedis.xreadgroup.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return null;
    });

    const listener = createOutboundListener(mockRedis as any, defaultConfig);
    await listener.start(ctx);
    await listener.stop(ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
    );
  });
});
