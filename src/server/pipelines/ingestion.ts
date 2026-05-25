import type { KnowledgeChunk } from '@/server/knowledge/deeplake-store'

export type IngestionStage = 'clone' | 'parse' | 'chunk' | 'embed' | 'index'

export interface IngestionJobPayload {
  workspaceId: string
  repositoryId?: string | null
  bitbucketWorkspace: string
  repoSlug: string
  branch: string
}

/**
 * Orchestrates: fetch files from Bitbucket → parse supported types → chunk → embeddings → Deep Lake + Supabase metadata.
 * MVP: export shape for a background worker (queue, Step Functions, or separate Node/Python service).
 */
export async function runIngestionPipeline(
  _payload: IngestionJobPayload,
  _handlers: {
    onStage: (stage: IngestionStage, detail?: string) => void
    storeChunks: (chunks: KnowledgeChunk[]) => Promise<void>
  }
): Promise<{ chunkCount: number }> {
  throw new Error(
    'runIngestionPipeline is not executed in the Next.js runtime yet; run from worker with Bitbucket + parser + embedder'
  )
}

export function describeIngestionPlan(payload: IngestionJobPayload): IngestionStage[] {
  void payload
  return ['clone', 'parse', 'chunk', 'embed', 'index']
}
