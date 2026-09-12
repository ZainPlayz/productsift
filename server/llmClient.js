import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

// Google AI Studio's free tier needs no credit card and no billing account -
// the reason this project defaults to Gemini instead of a paid API. Get a key
// at https://aistudio.google.com/apikey and set GEMINI_API_KEY in .env.
export const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Free-tier model availability and quotas shift over time (this project has
// already hit one 404-for-deprecated-model and one exhausted-daily-quota
// during development) - overridable via env so a future swap doesn't require
// a code change, only a .env edit.
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// With no API key yet, MOCK_MODE lets every route return realistic canned data
// instead of calling Gemini, so the full pipeline can be built and tested
// end-to-end without a key. Flip it off in .env once a key is set.
export const MOCK_MODE = process.env.MOCK_MODE === "true";

// Gemini's structured-output config takes a JSON Schema (responseJsonSchema),
// not a Zod schema directly - Zod v4's built-in toJSONSchema() does that
// conversion, so the same schemas in schemas.js drive both validation-on-read
// (if ever needed) and the model's output shape, with no schema duplicated
// by hand. The "$schema" meta key isn't one of Gemini's supported JSON Schema
// keywords, so it's stripped before sending.
export function toGeminiSchema(zodSchema) {
  const jsonSchema = z.toJSONSchema(zodSchema);
  const { $schema, ...rest } = jsonSchema;
  return rest;
}

// The free tier's newer/high-demand models (this project defaults to one)
// regularly return transient 503 (overloaded) or 429 (rate limited) errors
// that succeed a few seconds later - a real reliability concern specific to
// running on a free, shared quota. Retrying those with backoff, and only
// those (a 400 for a bad request should fail immediately, not retry), turns
// a flaky demo into a reliable one without changing what any route looks like.
const RETRYABLE_STATUS = new Set([429, 503]);

export async function generateContentWithRetry(params, { retries = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await genai.models.generateContent(params);
    } catch (err) {
      if (!RETRYABLE_STATUS.has(err.status) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
