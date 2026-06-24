/**
 * Shared JSON-handling helpers for AI responses.
 *
 * AI models in JSON mode usually return valid JSON, but in `text` mode or
 * when JSON mode falls through (some Together models reject the param),
 * the output can be:
 *   - Wrapped in ```json ... ``` fences (markdown-style)
 *   - Prefixed with a "Here is the JSON:" sentence
 *   - Followed by trailing commentary
 *
 * `cleanJSON` extracts the JSON payload heuristically. Originally lived
 * as a private helper inside remediate.ts (line 235); promoted here so
 * test-generator.ts and future AI flows reuse the same logic.
 */

export function cleanJSON(raw: string): string {
  // Prefer fenced code blocks when present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Otherwise grab the first complete-looking JSON object
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return raw;
}
