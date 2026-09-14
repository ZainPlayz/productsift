import Groq from "groq-sdk";
import { z } from "zod";

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

// v1.7: this app started with ONE shared server-side key, meaning every
// visitor to a public deployment burned the deployer's own free-tier quota -
// the whole reason MOCK_MODE defaults to true on Render (see render.yaml).
// A visitor can now supply their OWN key instead (stored client-side only,
// sent per-request on the X-Groq-Api-Key header - see routes and app.js).
// The server's own key becomes optional: it's the fallback for someone
// without their own key, not a requirement to run the app at all.
const serverApiKey = process.env.GROQ_API_KEY || null;
const serverGroq = serverApiKey ? new Groq({ apiKey: serverApiKey }) : null;

// Governs ONLY what happens for a request that did NOT bring its own key -
// MOCK_MODE exists to protect a shared SERVER key from public traffic, which
// simply doesn't apply once a visitor is spending their own quota. A
// visitor's key always means "call the real API for real", regardless of
// this setting.
export const SERVER_MOCK_MODE = process.env.MOCK_MODE === "true";

// Called once per incoming request with whatever came in on the
// X-Groq-Api-Key header (or null). Never logged, never persisted anywhere -
// used only to build a client for the lifetime of this one request.
export function resolveGroqRequest(userApiKey) {
  if (userApiKey) {
    return { mock: false, client: new Groq({ apiKey: userApiKey }) };
  }
  if (SERVER_MOCK_MODE || !serverGroq) {
    return { mock: true, client: null };
  }
  return { mock: false, client: serverGroq };
}

// A 401 is now a routine, expected failure mode (anyone can paste a typo'd
// or expired key), not just a deployer misconfiguration - worth a message
// that actually says what to do about it, not just "request failed".
export function friendlyGroqError(err) {
  if (err.status === 401) {
    return "Groq rejected the API key used for this request - check it's correct, or remove it (top right) to fall back to this server's default mode.";
  }
  return null;
}

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
//
// Found live, not assumed: with the default reasoning_effort ("medium" for
// gpt-oss models), the model was spending a large, variable chunk of
// max_completion_tokens on hidden reasoning before emitting any visible
// JSON - not just the visible output this app actually needs. That caused
// real symptoms: discovery/classification calls truncating mid-array on
// larger batches (leaving items to silently fall through to unclassified,
// no error thrown), and prioritize sometimes returning fewer estimates than
// themes given, or occasionally emitting nothing at all (failed_generation:
// "" - the entire budget spent reasoning). None of our tasks here are the
// kind of multi-step problem reasoning effort is for - they're
// well-specified extraction/classification/scoring jobs - so
// reasoning_effort: "low" is the actual fix: less of the token budget goes
// to invisible thinking, more goes to the JSON output this app depends on,
// and it's faster too. Tightening max_completion_tokens without this first
// was fighting the wrong variable.
export async function createChatCompletionWithRetry(client, params, { retries = 3, baseDelayMs = 1000 } = {}) {
  const requestParams = { max_completion_tokens: 2000, reasoning_effort: "low", ...params };
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create(requestParams);
    } catch (err) {
      if (!isRetryableStatus(err.status) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
