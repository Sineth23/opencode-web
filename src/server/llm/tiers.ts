/** Tiered models: cheap for bulk, stronger for final answers (roadmap §9). */
export const LLM_MODELS = {
  embedding: 'text-embedding-3-small',
  chunkTag: 'gpt-4o-mini',
  structure: 'gpt-4o-mini',
  ragAnswer: 'gpt-4o-mini',
  persona: 'gpt-4o-mini',
  /** Doc refresh uses OPENAI_DOC_GENERATION_MODEL when set; see `doc-generation.ts`. */
  docGeneration: 'gpt-4o',
} as const
