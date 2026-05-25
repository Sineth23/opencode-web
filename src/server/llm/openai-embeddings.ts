import OpenAI from 'openai'
import { LLM_MODELS } from '@/server/llm/tiers'

/** text-embedding-3-small output size */
export const EMBEDDING_DIMENSIONS = 1536

/** ~6 chars per token heuristic; stay under model context */
const MAX_CHARS_PER_EMBED_INPUT = 24000

export function requireOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set')
  }
  return new OpenAI({ apiKey: key })
}

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_CHARS_PER_EMBED_INPUT) return text
  return text.slice(0, MAX_CHARS_PER_EMBED_INPUT)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withEmbeddingRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      const retryable =
        /rate limit|429|503|502|500|timeout|ETIMEDOUT|ECONNRESET|fetch failed|too many requests|overloaded/i.test(
          msg
        )
      if (!retryable || attempt === maxAttempts) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      const delay = Math.min(12000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300)
      console.warn(`[embeddings] retry ${attempt}/${maxAttempts - 1} in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw last
}

export type EmbedTextsOptions = {
  /** Must output 1536 dimensions (matches pgvector column). */
  model?: string
}

export async function embedTexts(texts: string[], opts?: EmbedTextsOptions): Promise<number[][]> {
  if (texts.length === 0) return []
  const openai = requireOpenAI()
  const model = opts?.model?.trim() || LLM_MODELS.embedding
  const normalized = texts.map((t) => truncateForEmbedding(t))
  const out: number[][] = []
  let batchSize = 24
  let i = 0
  while (i < normalized.length) {
    const batch = normalized.slice(i, i + batchSize)
    try {
      const res = await withEmbeddingRetry(() =>
        openai.embeddings.create({
          model,
          input: batch,
        })
      )
      const sorted = [...res.data].sort((a, b) => a.index - b.index)
      for (const row of sorted) {
        if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding dimension mismatch for ${model}: got ${row.embedding.length} (expected ${EMBEDDING_DIMENSIONS}). Use a 1536-dim model or migrate pgvector.`
          )
        }
        out.push(row.embedding)
      }
      i += batch.length
    } catch (e) {
      if (batchSize <= 4) {
        throw e
      }
      batchSize = Math.max(4, Math.floor(batchSize / 2))
      console.warn('[embeddings] reducing batch size to', batchSize)
    }
  }
  return out
}

export async function embedQuery(text: string, opts?: EmbedTextsOptions): Promise<number[]> {
  const [v] = await embedTexts([text], opts)
  return v ?? []
}

/** pgvector text format for Supabase / PostgREST */
export function vectorToPgString(vec: number[]): string {
  return `[${vec.join(',')}]`
}
