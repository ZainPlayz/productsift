import Groq from "groq-sdk";
import { z } from "zod";

// Switched from Gemini to Groq: Groq's LPU inference is dramatically faster
// (the actual complaint that motivated this switch - analysis runs were
// regularly taking 60+ seconds under Gemini free-tier load), and Groq's free
// tier for llama-3.3-70b-versatile allows 1,000 requests/day vs Gemini's 20 -
// about 200 full analyses/day at this app's 5-calls-per-run cost, vs ~4.
// Get a free key (no credit card) at https://console.groq.com/keys.
export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Overridable via env so a future model swap/deprecation - which has already
// happened once with Gemini during this project - doesn't require a code
// change. llama-3.1-8b-instant trades reasoning quality for an even higher
// daily quota (14,400/day) if that tradeoff is ever worth making.
export const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// With no API key yet, MOCK_MODE lets every route return realistic canned data
// instead of calling Groq, so the full pipeline can be built and tested
// end-to-end without a key. Flip it off in .env once a key is set.
export const MOCK_MODE = process.env.MOCK_MODE === "true";

// Groq's structured-output config wraps a JSON Schema in a response_format
// envelope, not a Zod schema directly - Zod v4's built-in toJSONSchema() does
// that conversion. Note: Llama models don't support Groq's "strict" mode
// (100%-guaranteed schema adherence via constrained decoding) - that's
// currently limited to GPT-OSS/Qwen models on Groq - so this is best-effort
// schema following, the same reliability profile the app already had with
// Gemini, with the same Zod .parse() validation as the safety net on the way
// back in (see each route's use of <Schema>.parse(...)).
export function toGroqResponseFormat(zodSchema, name) {
  const jsonSchema = z.toJSONSchema(zodSchema);
  const { $schema, ...rest } = jsonSchema;
  return { type: "json_schema", json_schema: { name, schema: rest } };
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

// The free tier's rate limits (30 req/min, 1,000 req/day for the default
// model) mean a burst of retries can itself trigger a 429 - retrying only
// 429/5xx, with backoff, and only a bounded number of times, turns a
// transient blip into a reliable response without masking a real outage.
export async function createChatCompletionWithRetry(params, { retries = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await groq.chat.completions.create(params);
    } catch (err) {
      if (!isRetryableStatus(err.status) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
