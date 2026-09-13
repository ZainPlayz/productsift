import Groq from "groq-sdk";
import { z } from "zod";

// Switched from Gemini to Groq: Groq's LPU inference is dramatically faster
// (the actual complaint that motivated this switch - analysis runs were
// regularly taking 60+ seconds under Gemini free-tier load).
// Get a free key (no credit card) at https://console.groq.com/keys.
export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Llama chat models were the original plan, but a live check against
// groq.models.list() with a real key (not web search, which turned out to be
// describing a lineup that's since changed) showed no Llama completion model
// currently available - only GPT-OSS, Qwen, and a few non-chat models. Of
// what's actually available, openai/gpt-oss-120b is both the largest
// general-purpose option AND one of only two models on Groq that support
// "strict" JSON schema mode (see toGroqResponseFormat below) - a genuine
// reliability upgrade over what Llama would have given us, not just a
// fallback. Overridable via env so a future availability change - which has
// now happened twice across two different providers in this project's
// history - doesn't require a code change.
export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// With no API key yet, MOCK_MODE lets every route return realistic canned data
// instead of calling Groq, so the full pipeline can be built and tested
// end-to-end without a key. Flip it off in .env once a key is set.
export const MOCK_MODE = process.env.MOCK_MODE === "true";

// Groq's structured-output config wraps a JSON Schema in a response_format
// envelope, not a Zod schema directly - Zod v4's built-in toJSONSchema() does
// that conversion. strict:true enables constrained decoding - the model is
// structurally incapable of returning JSON that doesn't match the schema -
// currently supported by GPT-OSS and Qwen models on Groq (not Llama, had it
// been available). It requires every field to be required and
// additionalProperties:false, which every schema in schemas.js already
// satisfies (no .optional() fields), so this is a real reliability upgrade
// over the Gemini/Llama-era best-effort schema following, not a formality -
// the Zod .parse() calls in each route remain as defense in depth regardless.
export function toGroqResponseFormat(zodSchema, name) {
  const jsonSchema = z.toJSONSchema(zodSchema);
  const { $schema, ...rest } = jsonSchema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: rest } };
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

// Free-tier rate limits vary by model and shift over time (check the actual
// current numbers at https://console.groq.com/docs/rate-limits or in the
// x-ratelimit-* response headers) - a burst of retries can itself trigger a
// 429, so retrying only 429/5xx, with backoff, and only a bounded number of
// times, turns a transient blip into a reliable response without masking a
// real outage.
// Found live, not assumed: with no max_completion_tokens set, a 52-item
// discovery call (see cluster.js) generated all 52 primary_issue entries
// completely, then hit the API's default output cap before generating the
// required "themes" field - strict mode correctly rejected the resulting
// incomplete JSON as a 400 rather than silently returning bad data.
//
// The fix has two parts, both found by testing against the real API rather
// than picking one number and hoping: the free tier's tokens-per-minute
// limit for this model is a tight 8,000 TPM, checked as input tokens PLUS
// reserved max_completion_tokens BEFORE generation even starts - so a single
// uniform "just set it high" default backfires as a 413 on exactly the
// large-batch requests it's meant to help, especially for a call like
// classification whose *input* (primary issues + theme definitions) is
// already substantial. Each cluster.js call therefore passes its own tuned
// max_completion_tokens sized to what that specific call actually needs
// (see cluster.js); this default only covers the smaller calls
// (prioritize, PRD) that don't scale with batch size.
export async function createChatCompletionWithRetry(params, { retries = 3, baseDelayMs = 1000 } = {}) {
  const requestParams = { max_completion_tokens: 2000, ...params };
  for (let attempt = 0; ; attempt++) {
    try {
      return await groq.chat.completions.create(requestParams);
    } catch (err) {
      if (!isRetryableStatus(err.status) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
