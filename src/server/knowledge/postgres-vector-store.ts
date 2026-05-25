import type { SupabaseClient } from '@supabase/supabase-js'
import type { KnowledgeChunk, KnowledgeSimilarityOptions, KnowledgeVectorStore } from '@/server/knowledge/deeplake-store'
import { EMBEDDING_DIMENSIONS, vectorToPgString } from '@/server/llm/openai-embeddings'

type Row = {
  id: string
  workspace_id: string
  repository_id: string
  source_path: string
  body: string
  embedding: string
  metadata: Record<string, string | number | boolean>
  sync_branch: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withBackoff<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      const retryable =
        /rate limit|429|503|502|500|timeout|ETIMEDOUT|ECONNRESET|fetch failed|too many requests/i.test(msg)
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`${label}: ${msg}`)
      }
      const delay = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200)
      console.warn(`[${label}] retry ${attempt}/${maxAttempts - 1} in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw last
}

/**
 * pgvector-backed store (Supabase). Service role = writes; user JWT = read via RPC only.
 */
export class PostgresKnowledgeStore implements KnowledgeVectorStore {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly options: { allowWrite: boolean }
  ) {}

  async upsertChunks(chunks: KnowledgeChunk[]): Promise<{ inserted: number }> {
    if (!this.options.allowWrite) {
      throw new Error('PostgresKnowledgeStore: writes require service role client')
    }
    if (chunks.length === 0) return { inserted: 0 }
    const rows: Row[] = chunks.map((c) => {
      const emb = c.embedding
      if (!emb?.length) {
        throw new Error(`Chunk ${c.id} missing embedding`)
      }
      if (emb.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Chunk ${c.id}: expected ${EMBEDDING_DIMENSIONS} dims, got ${emb.length}`)
      }
      const syncBranch = String(c.metadata?.branch ?? 'legacy').trim() || 'legacy'
      return {
        id: c.id,
        workspace_id: c.workspaceId,
        repository_id: c.repositoryId,
        source_path: c.sourcePath,
        body: c.text,
        embedding: vectorToPgString(emb),
        metadata: c.metadata ?? {},
        sync_branch: syncBranch,
      }
    })

    let i = 0
    while (i < rows.length) {
      let batchSize = Math.min(40, rows.length - i)
      let uploaded = false
      while (!uploaded) {
        const slice = rows.slice(i, i + batchSize)
        try {
          await withBackoff('pk_knowledge_chunks upsert', async () => {
            const { error } = await this.supabase.from('pk_knowledge_chunks').upsert(slice, { onConflict: 'id' })
            if (error) {
              throw new Error(error.message)
            }
          })
          i += slice.length
          if (i < rows.length) await sleep(40)
          uploaded = true
        } catch (e) {
          if (batchSize <= 4) {
            throw e
          }
          batchSize = Math.max(4, Math.floor(batchSize / 2))
          console.warn('[pk_knowledge_chunks upsert] reducing batch size to', batchSize)
        }
      }
    }
    return { inserted: rows.length }
  }

  async querySimilar(
    workspaceId: string,
    embedding: number[],
    options: KnowledgeSimilarityOptions
  ): Promise<KnowledgeChunk[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`query embedding must have ${EMBEDDING_DIMENSIONS} dimensions`)
    }
    const { data, error } = await this.supabase.rpc('pk_match_knowledge_chunks', {
      p_workspace_id: workspaceId,
      p_query_embedding: vectorToPgString(embedding),
      p_match_count: options.topK,
      p_repository_id: options.repositoryId ?? null,
      p_sync_branch: options.syncBranch?.trim() ? options.syncBranch.trim() : null,
    })
    if (error) {
      throw new Error(`pk_match_knowledge_chunks: ${error.message}`)
    }
    const min = options.minScore ?? 0
    const rows = (data ?? []) as Array<{
      id: string
      repository_id: string
      source_path: string
      body: string
      metadata: Record<string, unknown>
      similarity: number
    }>
    return rows
      .filter((r) => r.similarity >= min)
      .map((r) => ({
        id: r.id,
        workspaceId,
        repositoryId: r.repository_id,
        sourcePath: r.source_path,
        text: r.body,
        metadata: {
          ...(r.metadata as Record<string, string | number | boolean>),
          similarity: r.similarity,
        },
      }))
  }

  /**
   * One huge DELETE hits Postgres statement_timeout on large branches; delete by id batches instead.
   */
  private async deleteChunkRowsBatched(
    label: string,
    buildSelect: () => any
  ): Promise<void> {
    const batchIds = 400
    for (;;) {
      const { data: rows, error: selErr } = await buildSelect().select('id').limit(batchIds)
      if (selErr) {
        throw new Error(`${label} (select ids): ${selErr.message}`)
      }
      if (!rows?.length) return

      const ids = (rows as { id: string }[]).map((r) => r.id)
      await withBackoff(`${label} batch`, async () => {
        const { error: delErr } = await this.supabase.from('pk_knowledge_chunks').delete().in('id', ids)
        if (delErr) {
          throw new Error(delErr.message)
        }
      })
      if (rows.length < batchIds) return
      await sleep(30)
    }
  }

  async deleteByRepositoryBranch(workspaceId: string, repositoryId: string, syncBranch: string): Promise<void> {
    if (!this.options.allowWrite) {
      throw new Error('PostgresKnowledgeStore: writes require service role client')
    }
    const b = syncBranch.trim() || 'legacy'
    await this.deleteChunkRowsBatched('pk_knowledge_chunks delete branch', () =>
      this.supabase
        .from('pk_knowledge_chunks')
        .select()
        .eq('workspace_id', workspaceId)
        .eq('repository_id', repositoryId)
        .eq('sync_branch', b)
    )
  }

  async deleteByRepository(workspaceId: string, repositoryId: string): Promise<void> {
    if (!this.options.allowWrite) {
      throw new Error('PostgresKnowledgeStore: writes require service role client')
    }
    await this.deleteChunkRowsBatched('pk_knowledge_chunks delete repo', () =>
      this.supabase.from('pk_knowledge_chunks').select().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
    )
  }
}

export function createPostgresKnowledgeStore(
  supabase: SupabaseClient,
  mode: 'read' | 'readwrite'
): PostgresKnowledgeStore {
  return new PostgresKnowledgeStore(supabase, { allowWrite: mode === 'readwrite' })
}
