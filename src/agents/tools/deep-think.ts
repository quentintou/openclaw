import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

export async function executeDeepThink(params: {
  question: string;
  context?: string;
}): Promise<{ text: string; usage?: { input: number; output: number } }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Configure it in your environment to use deep-think.",
    );
  }

  const anthropic = createAnthropic({ apiKey });
  const model = anthropic("claude-opus-4-6");

  const systemPrompt =
    "Tu es un conseiller stratégique expert en effectuation et en business digital. " +
    "Analyse en profondeur la question posée, considère tous les angles, " +
    "et fournis une réponse nuancée avec des recommandations actionnables.";

  const userMessage = params.context
    ? `Question: ${params.question}\n\nContexte: ${params.context}`
    : params.question;

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userMessage,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 10000 },
        },
      },
    });

    return {
      text: result.text,
      usage: result.usage
        ? {
            input: result.usage.inputTokens ?? 0,
            output: result.usage.outputTokens ?? 0,
          }
        : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Deep think failed: ${message}`);
  }
}
