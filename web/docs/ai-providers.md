# AI Providers

InariWatch is BYOK (Bring Your Own Key). You choose which AI provider to use. Add your API key in **Settings > AI Analysis**.

## Supported Providers

| Provider | Key Prefix | Vision | Default Model (remediation) |
|----------|-----------|--------|----------------------------|
| Claude (Anthropic) | `sk-ant-` | Yes | claude-sonnet-4-6 |
| OpenAI | `sk-` | Yes | gpt-4o |
| Grok (xAI) | `xai-` | Yes | grok-2-1212 |
| Gemini (Google) | `AIza` | Yes | gemini-1.5-pro |
| Groq | `gsk_` | No | llama-3.1-70b-versatile |
| DeepSeek | `sk-` (set provider explicitly) | No | deepseek-reasoner |

## What Each Task Uses

| Task | Default Tier | Notes |
|------|-------------|-------|
| Auto-analysis (free) | gpt-4o-mini | Platform key, no user key needed |
| Diagnosis | Remediation model | Uses your configured provider |
| Fix generation | Remediation model | Most expensive — generates full file contents |
| Self-review | Remediation model | Reviews the generated fix |
| Security review | Remediation model | AI layer of 3-layer scan |
| Visual analysis | Remediation model | Screenshot analysis (vision-capable providers only) |

## Model Defaults by Provider

| Provider | Analysis | Chat | Remediation | Postmortem |
|----------|----------|------|-------------|-----------|
| Claude | claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-4-6 | claude-sonnet-4-6 |
| OpenAI | gpt-4o-mini | gpt-4o | gpt-4o | gpt-4o |
| Grok | grok-2-mini | grok-2 | grok-2 | grok-2 |
| DeepSeek | deepseek-chat | deepseek-chat | deepseek-reasoner | deepseek-chat |
| Gemini | gemini-1.5-flash | gemini-1.5-flash | gemini-1.5-pro | gemini-1.5-pro |
| Groq | llama-3.1-70b | llama-3.1-70b | llama-3.1-70b | llama-3.1-70b |

You can override models per task in **Settings > AI Analysis > Model Preferences**.

## Vision Support

Providers with vision support can analyze screenshots during staging verification. The bot sends the final screenshot (and optionally a "before" screenshot from the error recording) to your AI provider.

If your provider doesn't support vision (Groq, DeepSeek), the bot falls back to text-only analysis with a DOM content check instead.

## Priority Order

If you have multiple AI keys configured, InariWatch uses this priority:
1. Your preferred provider (if set in Model Preferences)
2. Claude > OpenAI > Groq > Grok > DeepSeek > Gemini
