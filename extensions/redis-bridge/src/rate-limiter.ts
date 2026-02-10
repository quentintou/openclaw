import type { ClawdbotPluginServiceContext } from "clawdbot/plugin-sdk";

/**
 * Sliding-window rate limiter that tracks requests per hour globally
 * and per agent. When limits are exceeded, requests are rejected with
 * a user-friendly message instead of hitting the API.
 *
 * Also sends a Telegram alert (once per cooldown) when limits are breached.
 */

export type RateLimiterConfig = {
  /** Max requests per hour across all agents. Default: 60. */
  maxRequestsPerHour: number;
  /** Max requests per hour per single agent. Default: 20. */
  maxRequestsPerAgentPerHour: number;
  /** Telegram chat ID for cost alerts (empty = no alerts). */
  alertChatId: string;
  /** Minimum seconds between alert messages. Default: 300 (5 min). */
  alertCooldownSeconds: number;
};

type WindowEntry = { timestamp: number };

export function createRateLimiter(config: RateLimiterConfig) {
  const globalWindow: WindowEntry[] = [];
  const agentWindows = new Map<string, WindowEntry[]>();
  let lastAlertAt = 0;

  const WINDOW_MS = 3_600_000; // 1 hour

  function pruneWindow(window: WindowEntry[]): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (window.length > 0 && window[0]!.timestamp < cutoff) {
      window.shift();
    }
  }

  function getAgentWindow(agentId: string): WindowEntry[] {
    let w = agentWindows.get(agentId);
    if (!w) {
      w = [];
      agentWindows.set(agentId, w);
    }
    return w;
  }

  return {
    /**
     * Check if a request should be allowed. Returns null if OK,
     * or an error message string if rate-limited.
     */
    check(agentId: string): string | null {
      const now = Date.now();

      // Prune stale entries
      pruneWindow(globalWindow);
      const agentWindow = getAgentWindow(agentId);
      pruneWindow(agentWindow);

      // Check per-agent limit
      if (agentWindow.length >= config.maxRequestsPerAgentPerHour) {
        return `Rate limit: agent ${agentId} a atteint ${config.maxRequestsPerAgentPerHour} requetes/heure. Reessaie dans quelques minutes.`;
      }

      // Check global limit
      if (globalWindow.length >= config.maxRequestsPerHour) {
        return `Rate limit: le systeme a atteint ${config.maxRequestsPerHour} requetes/heure. Reessaie dans quelques minutes.`;
      }

      return null;
    },

    /** Record a request that was allowed through. */
    record(agentId: string): void {
      const entry = { timestamp: Date.now() };
      globalWindow.push(entry);
      getAgentWindow(agentId).push(entry);
    },

    /** Get current stats for logging. */
    stats(): { globalCount: number; byAgent: Record<string, number> } {
      pruneWindow(globalWindow);
      const byAgent: Record<string, number> = {};
      for (const [agent, window] of agentWindows) {
        pruneWindow(window);
        if (window.length > 0) byAgent[agent] = window.length;
      }
      return { globalCount: globalWindow.length, byAgent };
    },

    /** Send a Telegram alert if cooldown has elapsed. Fire-and-forget. */
    async sendAlert(
      reason: string,
      agentId: string,
      cliBinary: string | null,
      logger: ClawdbotPluginServiceContext["logger"],
    ): Promise<void> {
      if (!config.alertChatId) return;
      const now = Date.now();
      if (now - lastAlertAt < config.alertCooldownSeconds * 1000) return;
      lastAlertAt = now;

      const stats = this.stats();
      const message = `[Rate Limiter] ${reason}\n\nAgent: ${agentId}\nGlobal: ${stats.globalCount}/${config.maxRequestsPerHour} req/h\nPer-agent: ${JSON.stringify(stats.byAgent)}`;

      if (!cliBinary) return;

      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        await exec(cliBinary, [
          "message", "send",
          "--channel", "telegram",
          "--target", config.alertChatId,
          "--message", message,
        ], { timeout: 10_000 });
      } catch (err) {
        logger.warn(
          `[redis-bridge] Failed to send rate limit alert: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
