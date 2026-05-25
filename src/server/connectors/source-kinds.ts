/** Reserved source kinds for multi-connector ingestion (Layer 5). */
export const SOURCE_KINDS = ['bitbucket', 'github', 'confluence', 'ticket', 'manual', 'unknown'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
