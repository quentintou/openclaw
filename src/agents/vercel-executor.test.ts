import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to avoid the factory-closure limitation
const { mockGenerateText, mockCreateOpenAI, mockCreateAnthropic, mockCreateGoogle } = vi.hoisted(
  () => ({
    mockGenerateText: vi.fn(),
    mockCreateOpenAI: vi.fn(),
    mockCreateAnthropic: vi.fn(),
    mockCreateGoogle: vi.fn(),
  }),
);

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: mockCreateGoogle }));

import { isVercelProvider, runVercelExecutor } from "./vercel-executor.js";

describe("vercel-executor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const mockModel = { id: "test-model" };
    for (const factory of [mockCreateOpenAI, mockCreateAnthropic, mockCreateGoogle]) {
      factory.mockReturnValue(() => mockModel);
    }
  });

  describe("isVercelProvider", () => {
    it("identifies openrouter as vercel provider", () => {
      expect(isVercelProvider("openrouter")).toBe(true);
    });

    it("identifies vercel-anthropic as vercel provider", () => {
      expect(isVercelProvider("vercel-anthropic")).toBe(true);
    });

    it("identifies vercel-google as vercel provider", () => {
      expect(isVercelProvider("vercel-google")).toBe(true);
    });

    it("rejects non-vercel providers", () => {
      expect(isVercelProvider("anthropic")).toBe(false);
      expect(isVercelProvider("google")).toBe(false);
      expect(isVercelProvider("")).toBe(false);
    });
  });

  describe("runVercelExecutor", () => {
    it("returns text payload from generateText", async () => {
      mockGenerateText.mockResolvedValue({
        text: "Hello from Grok!",
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await runVercelExecutor({
        sessionId: "test-session",
        prompt: "Say hello",
        provider: "openrouter",
        model: "xai/grok-4-1-fast-reasoning",
        timeoutMs: 30_000,
        runId: "run-1",
      });

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads![0].text).toBe("Hello from Grok!");
      expect(result.meta.agentMeta?.provider).toBe("openrouter");
      expect(result.meta.agentMeta?.model).toBe("xai/grok-4-1-fast-reasoning");
      expect(result.meta.agentMeta?.usage?.input).toBe(100);
      expect(result.meta.agentMeta?.usage?.output).toBe(50);
      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("creates OpenRouter model with correct baseURL", async () => {
      mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });

      await runVercelExecutor({
        sessionId: "s",
        prompt: "test",
        provider: "openrouter",
        model: "test/model",
        timeoutMs: 10_000,
        runId: "r",
      });

      expect(mockCreateOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://openrouter.ai/api/v1" }),
      );
    });

    it("creates Anthropic model for vercel-anthropic provider", async () => {
      mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });

      await runVercelExecutor({
        sessionId: "s",
        prompt: "test",
        provider: "vercel-anthropic",
        model: "claude-sonnet-4-5-20250929",
        timeoutMs: 10_000,
        runId: "r",
      });

      expect(mockCreateAnthropic).toHaveBeenCalled();
    });

    it("creates Google model for vercel-google provider", async () => {
      mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });

      await runVercelExecutor({
        sessionId: "s",
        prompt: "test",
        provider: "vercel-google",
        model: "gemini-2.5-pro",
        timeoutMs: 10_000,
        runId: "r",
      });

      expect(mockCreateGoogle).toHaveBeenCalled();
    });

    it("returns error payload on failure", async () => {
      mockGenerateText.mockRejectedValue(new Error("rate limited"));

      const result = await runVercelExecutor({
        sessionId: "s",
        prompt: "test",
        provider: "openrouter",
        model: "test/model",
        timeoutMs: 10_000,
        runId: "r",
      });

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads![0].isError).toBe(true);
      expect(result.payloads![0].text).toContain("rate limited");
    });

    it("throws for unsupported provider", async () => {
      await expect(
        runVercelExecutor({
          sessionId: "s",
          prompt: "test",
          provider: "unknown-provider",
          model: "m",
          timeoutMs: 10_000,
          runId: "r",
        }),
      ).rejects.toThrow("Unsupported Vercel AI provider");
    });

    it("throws when model ID is empty", async () => {
      await expect(
        runVercelExecutor({
          sessionId: "s",
          prompt: "test",
          provider: "openrouter",
          model: "",
          timeoutMs: 10_000,
          runId: "r",
        }),
      ).rejects.toThrow("Model ID is required");
    });

    it("passes system prompt and abort signal", async () => {
      mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });
      const controller = new AbortController();

      await runVercelExecutor({
        sessionId: "s",
        prompt: "test prompt",
        provider: "openrouter",
        model: "test/model",
        timeoutMs: 10_000,
        runId: "r",
        extraSystemPrompt: "You are a helpful assistant.",
        abortSignal: controller.signal,
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are a helpful assistant.",
          prompt: "test prompt",
          abortSignal: controller.signal,
        }),
      );
    });
  });
});
