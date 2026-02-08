import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateText, mockCreateAnthropic } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockCreateAnthropic: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));

import { executeDeepThink } from "./deep-think.js";

describe("deep-think", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreateAnthropic.mockReturnValue(() => ({ id: "claude-opus-4-6" }));
  });

  it("returns response text and usage", async () => {
    mockGenerateText.mockResolvedValue({
      text: "Strategic analysis: You should accept the deal.",
      usage: { inputTokens: 500, outputTokens: 1200 },
    });

    const result = await executeDeepThink({
      question: "Should I accept this partnership?",
    });

    expect(result.text).toBe("Strategic analysis: You should accept the deal.");
    expect(result.usage).toEqual({ input: 500, output: 1200 });
  });

  it("includes context in the prompt when provided", async () => {
    mockGenerateText.mockResolvedValue({
      text: "Analysis with context.",
      usage: { inputTokens: 100, outputTokens: 200 },
    });

    await executeDeepThink({
      question: "Pricing strategy?",
      context: "Current price is 47 EUR, competitor charges 99 EUR.",
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Contexte: Current price is 47 EUR"),
      }),
    );
  });

  it("enables extended thinking via provider options", async () => {
    mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });

    await executeDeepThink({ question: "test" });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 10000 },
          },
        },
      }),
    );
  });

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(executeDeepThink({ question: "test" })).rejects.toThrow(
      "ANTHROPIC_API_KEY is not set",
    );
  });

  it("wraps errors with descriptive message", async () => {
    mockGenerateText.mockRejectedValue(new Error("model overloaded"));

    await expect(executeDeepThink({ question: "test" })).rejects.toThrow(
      "Deep think failed: model overloaded",
    );
  });
});
