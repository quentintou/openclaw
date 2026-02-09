import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCircuitBreaker } from "./circuit-breaker.js";

describe("circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in closed state with zero failures", () => {
    const cb = createCircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.isOpen()).toBe(false);
    expect(cb.isHalfOpen()).toBe(false);
  });

  it("stays closed below threshold", () => {
    const cb = createCircuitBreaker({ threshold: 5 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(4);
  });

  it("opens after reaching threshold failures", () => {
    const cb = createCircuitBreaker({ threshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen()).toBe(true);
    expect(cb.consecutiveFailures).toBe(3);
  });

  it("stays open during cooldown period", () => {
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 10_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(cb.isOpen()).toBe(true);
    expect(cb.isHalfOpen()).toBe(false);
  });

  it("transitions to half-open after cooldown expires", () => {
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 10_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(cb.isHalfOpen()).toBe(true);
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe("half-open");
  });

  it("resets to closed on success from closed state", () => {
    const cb = createCircuitBreaker({ threshold: 5 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consecutiveFailures).toBe(2);

    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
  });

  it("resets to closed on success from half-open state", () => {
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 5_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(cb.isHalfOpen()).toBe(true);

    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.isOpen()).toBe(false);
    expect(cb.isHalfOpen()).toBe(false);
  });

  it("re-opens on failure during half-open with fresh cooldown", () => {
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 5_000 });
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(5_000);
    expect(cb.isHalfOpen()).toBe(true);

    // Probe fails — should re-open with fresh timestamp
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    // Still open right after
    vi.advanceTimersByTime(2_000);
    expect(cb.isOpen()).toBe(true);

    // Half-open again after another full cooldown
    vi.advanceTimersByTime(3_000);
    expect(cb.isHalfOpen()).toBe(true);
  });

  it("uses default threshold of 5", () => {
    const cb = createCircuitBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  it("uses default cooldown of 15s", () => {
    const cb = createCircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(14_999);
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(cb.isHalfOpen()).toBe(true);
  });

  it("accepts custom options", () => {
    const cb = createCircuitBreaker({ threshold: 10, cooldownMs: 60_000 });
    for (let i = 0; i < 9; i++) cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(59_999);
    expect(cb.isOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cb.isHalfOpen()).toBe(true);
  });
});
