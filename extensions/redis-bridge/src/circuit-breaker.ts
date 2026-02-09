export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreakerOptions = {
  /** Number of consecutive failures before opening the circuit (default: 5). */
  threshold?: number;
  /** Milliseconds to keep circuit open before allowing a half-open probe (default: 15_000). */
  cooldownMs?: number;
};

export type CircuitBreaker = {
  /** Record a successful operation — resets the breaker to closed. */
  recordSuccess(): void;
  /** Record a failed operation — may trip the breaker open. */
  recordFailure(): void;
  /** True when the circuit is open (fast-fail all requests). */
  isOpen(): boolean;
  /** True when the circuit is half-open (allow one probe request). */
  isHalfOpen(): boolean;
  /** Current state label. */
  readonly state: CircuitState;
  /** Number of consecutive failures since last success. */
  readonly consecutiveFailures: number;
};

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 15_000;

/**
 * Create a circuit breaker that tracks consecutive failures and fast-fails
 * when a threshold is reached, with automatic half-open recovery probes.
 */
export function createCircuitBreaker(opts?: CircuitBreakerOptions): CircuitBreaker {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let failures = 0;
  let openedAt = 0;

  function getState(): CircuitState {
    if (failures < threshold) return "closed";
    const elapsed = Date.now() - openedAt;
    if (elapsed >= cooldownMs) return "half-open";
    return "open";
  }

  return {
    recordSuccess() {
      failures = 0;
      openedAt = 0;
    },

    recordFailure() {
      failures++;
      if (failures >= threshold) {
        // (Re-)open the circuit with a fresh timestamp so the cooldown restarts
        openedAt = Date.now();
      }
    },

    isOpen() {
      return getState() === "open";
    },

    isHalfOpen() {
      return getState() === "half-open";
    },

    get state() {
      return getState();
    },

    get consecutiveFailures() {
      return failures;
    },
  };
}
