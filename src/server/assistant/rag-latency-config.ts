/**
 * Tuning for assistant RAG time-to-first-token and total stream length.
 * Override via environment (e.g. Vercel → Project → Settings → Environment Variables).
 * Per-workspace model tier still comes from `org_ai_settings` (see resolveOrgAiSettings).
 */

function parseIntInRange(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw == null || String(raw).trim() === '') return def
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

export type AssistantRagLatencyConfig = {
  /** How many recent handbook rows to load from DB before keyword scoring. */
  handbookFetchLimit: number
  /** Max characters of body_md per handbook section injected into the prompt. */
  handbookBodyMaxChars: number
  /** Max handbook sections to inject after keyword ranking. */
  handbookSectionsMax: number
  /** `match_count` passed to `pk_match_knowledge_chunks` (higher = more DB work + context). */
  vectorTopK: number
  /** Max code chunks (after vendor filtering) given to the LLM. */
  contextChunksMax: number
  /** OpenAI `max_tokens` for the streaming completion. */
  maxOutputTokens: number
  /** Recent chat messages loaded from the thread (when client uses thread_id). */
  threadHistoryMax: number
}

/**
 * Defaults are tuned for lower latency: smaller prompt, fewer chunks, slightly shorter answers.
 * Increase limits if you need deeper grounding and can accept slower responses.
 */
export function getAssistantRagLatencyConfig(): AssistantRagLatencyConfig {
  return {
    handbookFetchLimit: parseIntInRange(process.env.PK_RAG_HANDBOOK_FETCH_LIMIT, 96, 24, 220),
    handbookBodyMaxChars: parseIntInRange(process.env.PK_RAG_HANDBOOK_BODY_CHARS, 720, 400, 4000),
    handbookSectionsMax: parseIntInRange(process.env.PK_RAG_HANDBOOK_MAX_SECTIONS, 8, 1, 16),
    vectorTopK: parseIntInRange(process.env.PK_RAG_VECTOR_TOP_K, 14, 8, 48),
    contextChunksMax: parseIntInRange(process.env.PK_RAG_CONTEXT_CHUNKS_MAX, 8, 4, 24),
    maxOutputTokens: parseIntInRange(process.env.PK_RAG_MAX_OUTPUT_TOKENS, 1200, 400, 4096),
    threadHistoryMax: parseIntInRange(process.env.PK_RAG_THREAD_HISTORY, 16, 4, 32),
  }
}
