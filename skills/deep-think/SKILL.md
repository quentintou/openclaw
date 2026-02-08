---
name: deep-think
description: Escalate complex questions to Claude Opus 4.6 for deep strategic analysis with extended thinking.
metadata: {"clawdbot":{"emoji":"🧠"}}
---

# Deep Think

Sends a question to Claude Opus 4.6 with extended thinking (10K budget tokens) for deep strategic analysis.

## Usage

Call the `deep_think` tool with:
- `question` (string, required) - The question or problem to analyze
- `context` (string, optional) - Additional context to inform the analysis

## When to use

- Strategic decisions involving >100 EUR
- Complex multi-factor analyses requiring nuance
- Negotiations or pricing strategy
- Critical questions where subtlety matters
- Situations where the primary model needs a second, deeper opinion

## Cost

Approximately $0.15-0.30 per call (Opus 4.6 with extended thinking).

## Example

```
deep_think(
  question: "Should I accept this partnership deal at 15% revenue share?",
  context: "Current monthly revenue is 8K EUR, partner brings 2K new users/month, similar deals in the market are 10-20%."
)
```
