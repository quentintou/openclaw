import { describe, expect, it, vi, beforeEach } from "vitest";

import { createRedisBridgeTool } from "./tools.js";
import type { RedisBridgeConfig } from "./types.js";
import { STREAM_INBOUND, RESPONSE_KEY_PREFIX } from "./types.js";

function createMockRedis() {
  return {
    xadd: vi.fn().mockResolvedValue("1234567890-0"),
    brpop: vi.fn().mockResolvedValue(null),
  };
}

const defaultConfig: RedisBridgeConfig = {
  agents: ["test-agent"],
  redisUrl: "redis://localhost:6379",
  timeoutSeconds: 10,
  consumerGroup: "test-group",
  consumerName: "test-consumer",
};

const defaultCtx = { agentId: "test-agent", messageChannel: "telegram" };

describe("redis_bridge tool", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it("has correct name and description", () => {
    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    expect(tool.name).toBe("redis_bridge");
    expect(tool.description).toContain("Effectual Engine");
  });

  it("throws if message is empty", async () => {
    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    await expect(
      tool.execute("call-1", { message: "" }),
    ).rejects.toThrow("message is required");
  });

  it("publishes to inbound stream with correct fields", async () => {
    mockRedis.brpop.mockResolvedValue(["key", JSON.stringify({ text: "hello" })]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    await tool.execute("call-1", { message: "test message" });

    expect(mockRedis.xadd).toHaveBeenCalledOnce();
    const args = mockRedis.xadd.mock.calls[0];
    expect(args[0]).toBe(STREAM_INBOUND);
    expect(args[1]).toBe("*");
    // Fields are key-value pairs
    expect(args[2]).toBe("correlationId");
    expect(args[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(args[4]).toBe("message");
    expect(args[5]).toBe("test message");
    expect(args[6]).toBe("from");
    expect(args[7]).toBe("proxy");
    expect(args[8]).toBe("agent");
    expect(args[9]).toBe("test-agent");
    expect(args[10]).toBe("channel");
    expect(args[11]).toBe("telegram");
  });

  it("uses context agentId and messageChannel", async () => {
    mockRedis.brpop.mockResolvedValue(["key", JSON.stringify({ text: "ok" })]);

    const ctx = { agentId: "my-agent", messageChannel: "discord" };
    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, ctx);
    await tool.execute("call-1", { message: "hi" });

    const args = mockRedis.xadd.mock.calls[0];
    expect(args[9]).toBe("my-agent");
    expect(args[11]).toBe("discord");
  });

  it("falls back to 'unknown' when context fields are missing", async () => {
    mockRedis.brpop.mockResolvedValue(["key", JSON.stringify({ text: "ok" })]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, {});
    await tool.execute("call-1", { message: "hi" });

    const args = mockRedis.xadd.mock.calls[0];
    expect(args[9]).toBe("unknown");
    expect(args[11]).toBe("unknown");
  });

  it("calls BRPOP with correct key and timeout", async () => {
    mockRedis.brpop.mockResolvedValue(["key", JSON.stringify({ text: "response" })]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    await tool.execute("call-1", { message: "hi" });

    expect(mockRedis.brpop).toHaveBeenCalledOnce();
    const [key, timeout] = mockRedis.brpop.mock.calls[0];
    expect(key).toMatch(new RegExp(`^${RESPONSE_KEY_PREFIX.replace(/[:.]/g, "\\$&")}`));
    expect(timeout).toBe(10);
  });

  it("returns parsed JSON response text", async () => {
    mockRedis.brpop.mockResolvedValue(["key", JSON.stringify({ text: "Engine says hi" })]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    const result = await tool.execute("call-1", { message: "hi" });

    expect(result.content).toEqual([{ type: "text", text: "Engine says hi" }]);
  });

  it("handles plain text response (non-JSON)", async () => {
    mockRedis.brpop.mockResolvedValue(["key", "plain text response"]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    const result = await tool.execute("call-1", { message: "hi" });

    expect(result.content).toEqual([{ type: "text", text: "plain text response" }]);
  });

  it("throws on timeout (null BRPOP result)", async () => {
    mockRedis.brpop.mockResolvedValue(null);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    await expect(
      tool.execute("call-1", { message: "hi" }),
    ).rejects.toThrow("timed out after 10s");
  });

  it("throws on engine error response", async () => {
    mockRedis.brpop.mockResolvedValue([
      "key",
      JSON.stringify({ error: "processing failed" }),
    ]);

    const tool = createRedisBridgeTool(mockRedis as any, defaultConfig, defaultCtx);
    await expect(
      tool.execute("call-1", { message: "hi" }),
    ).rejects.toThrow("Engine error: processing failed");
  });
});
