import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConfig, isEngineAgent } from "./config.js";

describe("resolveConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads agents from REDIS_BRIDGE_AGENTS env var", () => {
    vi.stubEnv("REDIS_BRIDGE_AGENTS", "agent1,agent2,agent3");
    const config = resolveConfig();
    expect(config.agents).toEqual(["agent1", "agent2", "agent3"]);
  });

  it("trims whitespace and filters empty entries", () => {
    vi.stubEnv("REDIS_BRIDGE_AGENTS", " agent1 , , agent2 ");
    const config = resolveConfig();
    expect(config.agents).toEqual(["agent1", "agent2"]);
  });

  it("falls back to plugin config agents array", () => {
    const config = resolveConfig({ agents: ["a", "b"] });
    expect(config.agents).toEqual(["a", "b"]);
  });

  it("env var takes precedence over plugin config", () => {
    vi.stubEnv("REDIS_BRIDGE_AGENTS", "env-agent");
    const config = resolveConfig({ agents: ["config-agent"] });
    expect(config.agents).toEqual(["env-agent"]);
  });

  it("returns empty agents when nothing is configured", () => {
    const config = resolveConfig();
    expect(config.agents).toEqual([]);
  });

  it("reads REDIS_URL from env", () => {
    vi.stubEnv("REDIS_URL", "redis://custom:6380");
    const config = resolveConfig();
    expect(config.redisUrl).toBe("redis://custom:6380");
  });

  it("defaults redis URL to localhost", () => {
    const config = resolveConfig();
    expect(config.redisUrl).toBe("redis://localhost:6379");
  });

  it("reads timeout from plugin config", () => {
    const config = resolveConfig({ timeoutSeconds: 60 });
    expect(config.timeoutSeconds).toBe(60);
  });

  it("defaults timeout to 120s", () => {
    const config = resolveConfig();
    expect(config.timeoutSeconds).toBe(120);
  });

  it("reads consumer group and name from plugin config", () => {
    const config = resolveConfig({
      consumerGroup: "my-group",
      consumerName: "my-consumer",
    });
    expect(config.consumerGroup).toBe("my-group");
    expect(config.consumerName).toBe("my-consumer");
  });
});

describe("isEngineAgent", () => {
  it("returns true for configured agent", () => {
    vi.stubEnv("REDIS_BRIDGE_AGENTS", "engine-1,engine-2");
    const config = resolveConfig();
    expect(isEngineAgent("engine-1", config)).toBe(true);
    expect(isEngineAgent("engine-2", config)).toBe(true);
  });

  it("returns false for unconfigured agent", () => {
    vi.stubEnv("REDIS_BRIDGE_AGENTS", "engine-1");
    const config = resolveConfig();
    expect(isEngineAgent("other-agent", config)).toBe(false);
  });
});
