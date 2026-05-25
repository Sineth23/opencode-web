/**
 * Vector store contract (chunks + similarity search).
 *
 * Production default in this repo: Postgres pgvector via `PostgresKnowledgeStore` + `pk_knowledge_chunks`.
 * Deep Lake (`DeepLakeKnowledgeStore`) remains an optional alternate backend using the same interface.
 *
 * Env (Deep Lake only): DEEPLAKE_TOKEN, DEEPLAKE_DATASET_PATH
 */

export type KnowledgeChunk = {
  id: string
  workspaceId: string
  repositoryId: string
  sourcePath: string
  text: string
  embedding?: number[]
  metadata: Record<string, string | number | boolean>
}

export type KnowledgeSimilarityOptions = {
  topK: number
  minScore?: number
  /** When set, restrict retrieval to this linked repository. */
  repositoryId?: string | null
  /** When set (and repositoryId set or alone), restrict to this branch label from sync metadata. */
  syncBranch?: string | null
}

export interface KnowledgeVectorStore {
  /** Upsert chunks after ingestion (idempotent by chunk id). */
  upsertChunks(chunks: KnowledgeChunk[]): Promise<{ inserted: number }>
  /** Semantic search for RAG. */
  querySimilar(
    workspaceId: string,
    embedding: number[],
    options: KnowledgeSimilarityOptions
  ): Promise<KnowledgeChunk[]>
  /** Remove vectors for one repository and branch (multi-branch safe). */
  deleteByRepositoryBranch(workspaceId: string, repositoryId: string, syncBranch: string): Promise<void>
  /** Remove all vectors for a repository across branches. */
  deleteByRepository(workspaceId: string, repositoryId: string): Promise<void>
}

export class DeepLakeKnowledgeStore implements KnowledgeVectorStore {
  constructor(
    private readonly datasetPath: string,
    private readonly token: string
  ) {
    if (!datasetPath || !token) {
      throw new Error('DeepLakeKnowledgeStore: DEEPLAKE_DATASET_PATH and DEEPLAKE_TOKEN are required')
    }
  }

  async upsertChunks(_chunks: KnowledgeChunk[]): Promise<{ inserted: number }> {
    // Wire to Activeloop REST / embedded worker. Keep API stable for production rollout.
    throw new Error('DeepLakeKnowledgeStore.upsertChunks not implemented; connect worker or Activeloop client')
  }

  async querySimilar(
    _workspaceId: string,
    _embedding: number[],
    _options: KnowledgeSimilarityOptions
  ): Promise<KnowledgeChunk[]> {
    throw new Error('DeepLakeKnowledgeStore.querySimilar not implemented')
  }

  async deleteByRepositoryBranch(_workspaceId: string, _repositoryId: string, _syncBranch: string): Promise<void> {
    throw new Error('DeepLakeKnowledgeStore.deleteByRepositoryBranch not implemented')
  }

  async deleteByRepository(_workspaceId: string, _repositoryId: string): Promise<void> {
    throw new Error('DeepLakeKnowledgeStore.deleteByRepository not implemented')
  }
}

export function getDeepLakeStoreFromEnv(): KnowledgeVectorStore | null {
  const path = process.env.DEEPLAKE_DATASET_PATH
  const token = process.env.DEEPLAKE_TOKEN
  if (!path || !token) return null
  return new DeepLakeKnowledgeStore(path, token)
}
