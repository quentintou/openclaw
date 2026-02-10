/** Redis stream entry fields for bridge messages. */
export type BridgeInboundEntry = {
  correlationId: string;
  message: string;
  from: string;
  agent: string;
  channel: string;
  accountId?: string; // Which bot/account received this message
  timestamp: string;
};

/** Outbound message from the external engine. */
export type BridgeOutboundEntry = {
  agent: string;
  channel: string;
  to: string;
  message: string;
  accountId?: string; // Telegram bot account (e.g. "eff", "default") — routes via the right bot
  timestamp?: string;
};

/** Response returned via the correlation key. */
export type BridgeResponse = {
  text: string;
  error?: string;
};

export type RedisBridgeConfig = {
  /** Comma-separated agent IDs routed to the engine, or array. */
  agents: string[];
  /** Redis connection URL. */
  redisUrl: string;
  /** Timeout in seconds for waiting on engine response. */
  timeoutSeconds: number;
  /** Consumer group name for outbound stream. */
  consumerGroup: string;
  /** Consumer name within the group. */
  consumerName: string;
  /** Content publisher base URL (e.g. http://localhost:3461). Empty = disabled. */
  contentPublisherUrl: string;
  /** Bearer token for content publisher API. */
  contentPublisherToken: string;
  /** Public base URL for published content links. */
  contentPublisherPublicUrl: string;
};

export const PROTOCOL_VERSION = "1";

export const STREAM_INBOUND = "bridge:inbound";
export const STREAM_OUTBOUND = "bridge:outbound";
export const RESPONSE_KEY_PREFIX = "bridge:response:";
