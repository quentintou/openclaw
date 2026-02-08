/**
 * Alternative executor that uses the Vercel AI SDK (`generateText`) for
 * non-Anthropic models (OpenRouter, Google, etc.).
 *
 * This is intentionally simpler than the full Pi embedded runner: no sessions,
 * no auth-profile rotation, no compaction. It is designed for stateless,
 * single-turn LLM calls routed through OpenRouter or direct provider APIs.
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

type VercelProvider = "openrouter" | "vercel-anthropic" | "vercel-google";

const VERCEL_PROVIDERS = new Set<string>(["openrouter", "vercel-anthropic", "vercel-google"]);

export function isVercelProvider(provider: string): provider is VercelProvider {
  return VERCEL_PROVIDERS.has(provider);
}

function createVercelModel(provider: VercelProvider, modelId: string) {
  switch (provider) {
    case "openrouter": {
      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });
      return openrouter(modelId);
    }
    case "vercel-anthropic": {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return anthropic(modelId);
    }
    case "vercel-google": {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
      return google(modelId);
    }
  }
}

/**
 * Run a single-turn LLM query via the Vercel AI SDK.
 *
 * Accepts the same params as `runEmbeddedPiAgent` and returns a compatible
 * `EmbeddedPiRunResult` so callers don't need to branch on executor type.
 */
export async function runVercelExecutor(
  params: Pick<
    RunEmbeddedPiAgentParams,
    | "sessionId"
    | "prompt"
    | "provider"
    | "model"
    | "timeoutMs"
    | "runId"
    | "abortSignal"
    | "extraSystemPrompt"
    | "config"
  >,
): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const provider = (params.provider ?? "").trim() as VercelProvider;
  const modelId = (params.model ?? "").trim();

  if (!isVercelProvider(provider)) {
    throw new Error(`Unsupported Vercel AI provider: ${provider}`);
  }
  if (!modelId) {
    throw new Error("Model ID is required for Vercel AI executor");
  }

  const model = createVercelModel(provider, modelId);

  try {
    const result = await generateText({
      model,
      system: params.extraSystemPrompt || undefined,
      prompt: params.prompt,
      abortSignal: params.abortSignal,
    });

    const usage = {
      input: result.usage?.inputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
      total: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    };

    return {
      payloads: result.text ? [{ text: result.text }] : undefined,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: params.sessionId,
          provider,
          model: modelId,
          usage,
        },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("timeout") || message.includes("aborted");

    return {
      payloads: [
        {
          text: `⚠️ ${provider}/${modelId} failed: ${message}`,
          isError: true,
        },
      ],
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: params.sessionId,
          provider,
          model: modelId,
        },
        error: isTimeout
          ? undefined
          : { kind: "context_overflow" as const, message },
      },
    };
  }
}
