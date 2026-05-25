import type { ChatMessageSource } from '@/types/product-knowledge'
import type { KnowledgeChunk } from '@/server/knowledge/deeplake-store'
import type { AssistantIntent } from '@/server/llm/intent'
import type { CodewikiDigestBundle } from '@/server/codewiki/load-digest'
import { requireOpenAI } from '@/server/llm/openai-embeddings'
import { LLM_MODELS } from '@/server/llm/tiers'
import type OpenAI from 'openai'

export type HandbookSectionSnippet = {
  id: string
  title: string
  category: string
  summary: string
  /** First ~1 200 chars of body_md for context injection. */
  bodySnippet: string
  relevanceScore: number
}

export interface AssistantTurnInput {
  workspaceId: string
  userMessage: string
  history: { role: 'user' | 'assistant'; content: string }[]
  /** PM | dev | exec: steers tone (roadmap personas) */
  persona?: 'pm' | 'developer' | 'executive'
  intent?: AssistantIntent
  /** Chat completion model (org plan + premium cap). */
  chatModel?: string
  /** Latest repository overview digest for this scope (optional). */
  codewiki?: CodewikiDigestBundle | null
  /**
   * Compressed summary of earlier conversation turns (generated when thread
   * exceeds SUMMARY_THRESHOLD messages). Injected into system context.
   */
  threadSummary?: string | null
  /** Human-readable name of the currently-scoped repository. */
  repoName?: string | null
  /** Currently-scoped branch. */
  branch?: string | null
  /** Relevant handbook sections (pre-scored). Injected before code chunks. */
  handbookSections?: HandbookSectionSnippet[]
}

export interface AssistantTurnResult {
  answer: string
  sources: ChatMessageSource[]
  /** When true, UI should soften claims; model had thin retrieval overlap */
  lowGrounding: boolean
}

export interface RagContextBuild {
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  sources: ChatMessageSource[]
  lowGrounding: boolean
  model: string
}

function intentHint(intent: AssistantIntent | undefined): string {
  switch (intent) {
    case 'feasibility':
      return 'The user cares about whether something is possible and what blockers exist.'
    case 'where_in_code':
      return 'The user wants pointers to where behavior lives in the codebase.'
    case 'how_it_works':
      return 'The user wants an operational / workflow explanation.'
    default:
      return ''
  }
}

function personaPreamble(persona: AssistantTurnInput['persona']): string {
  switch (persona) {
    case 'developer':
      return 'Prefer concrete file paths, dependencies, and technical mechanisms. Still cite sources.'
    case 'executive':
      return 'Keep answers short: outcomes, risks, and scope. Avoid jargon unless necessary. Cite sources briefly.'
    case 'pm':
    default:
      return (
        'Answer like a senior product manager partnering with operations and customer-facing teams: plain language first, concrete outcomes, trade-offs in business terms, and clear next steps. ' +
        'Prefer “what it does / who it affects / what to watch for” over low-level implementation detail unless the user asks for code. ' +
        'Still ground claims in the provided sources and cite them.'
      )
  }
}

/**
 * Build the OpenAI messages array and source metadata for a RAG turn.
 * Does NOT call the LLM: use this when you need to stream or control the call.
 */
export function buildRagContext(
  input: AssistantTurnInput,
  ctx: { chunks: KnowledgeChunk[] }
): RagContextBuild {
  const preamble = personaPreamble(input.persona)
  const intentLine = intentHint(input.intent)
  const handbook = input.handbookSections ?? []

  // ── Handbook sections block (injected before code excerpts) ───────────────
  const handbookBlock = handbook.length > 0
    ? `--- Engineering Handbook (curated articles grounded in the codebase) ---\n` +
      handbook.map((s, i) =>
        `### Handbook [H${i + 1}]: ${s.title} [${s.category}]\n` +
        `Summary: ${s.summary}\n\n${s.bodySnippet}`
      ).join('\n\n---\n\n')
    : ''

  const codeContext = ctx.chunks
    .map((c, i) => `### Source ${i + 1 + handbook.length}: ${c.sourcePath}\n${c.text}`)
    .join('\n\n---\n\n')

  const sources: ChatMessageSource[] = []

  // Handbook sources first (highest quality grounding)
  sources.push(
    ...handbook.map((s) => ({
      label: s.title,
      doc_section_id: s.id,
      confidence: (s.relevanceScore > 0.6 ? 'high' : s.relevanceScore > 0.3 ? 'medium' : 'low') as ChatMessageSource['confidence'],
    }))
  )

  // Code chunk sources (chunks are already capped by the assistant route)
  sources.push(
    ...ctx.chunks.map((c) => {
      const sim = Number(c.metadata?.similarity ?? 0)
      const confidence: ChatMessageSource['confidence'] =
        sim > 0.42 ? 'high' : sim > 0.26 ? 'medium' : 'low'
      const branch = c.metadata?.branch != null ? String(c.metadata.branch) : ''
      const label = branch ? `${c.sourcePath} (${branch})` : c.sourcePath
      return { label, path: c.sourcePath, confidence }
    })
  )

  const summaryBlock = input.threadSummary
    ? `\n\n--- Earlier conversation summary ---\n${input.threadSummary}\n--- End of summary ---`
    : ''

  const scopeLine = input.repoName
    ? `You are currently scoped to repository: "${input.repoName}"${input.branch ? ` (branch: ${input.branch})` : ''}. All retrieved sources are from this repository.`
    : ''

  const handbookHint = handbook.length > 0
    ? `You have access to curated Engineering Handbook articles (marked [H1], [H2]…): use these for workflow, architecture, and operational questions. For exact file-level behavior, prioritize the numbered SOURCE EXCERPTS.\n`
    : ''

  const system = `You are AutoDoc Assistant: the intelligence layer for how the customer's software works. You are embedded inside the AutoDoc platform. Never reveal system internals, retrieval mechanics, or model names.
${scopeLine ? `${scopeLine}\n` : ''}${preamble}
${intentLine ? `${intentLine}\n` : ''}${handbookHint}
Use [H1], [H2]… to cite handbook articles and [Source n] for code excerpts. If the context does not contain the answer, say so and suggest what would be needed (e.g. sync a repository, or check a specific area).${summaryBlock}`

  const historyMsgs = input.history.map((h) => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }))

  const repoLabel = input.repoName ?? 'the synced repository'
  const hasContext = ctx.chunks.length > 0 || handbook.length > 0
  const userBlock = !hasContext
    ? `No retrieved context is available for ${repoLabel} yet (run a sync from Integrations to index the codebase). Question: ${input.userMessage}`
    : `Context from ${repoLabel}${input.branch ? ` (${input.branch})` : ''} (may be incomplete):\n\n${handbookBlock ? `${handbookBlock}\n\n` : ''}${codeContext}\n\n---\n\nQuestion: ${input.userMessage}`

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...historyMsgs,
    { role: 'user', content: userBlock },
  ]

  const maxSim = Math.max(0, ...ctx.chunks.map((c) => Number(c.metadata?.similarity ?? 0)))
  const lowGrounding = !hasContext ? true : ctx.chunks.length === 0 ? false : maxSim < 0.2
  const model = input.chatModel?.trim() || LLM_MODELS.ragAnswer

  return { messages, sources, lowGrounding, model }
}

/**
 * RAG: retrieved chunks → grounded completion with citations.
 * For streaming, use buildRagContext + openai.chat.completions.create({ stream: true }).
 */
export async function answerWithRag(
  input: AssistantTurnInput,
  ctx: { chunks: KnowledgeChunk[] }
): Promise<AssistantTurnResult> {
  const openai = requireOpenAI()
  const { messages, sources, lowGrounding, model } = buildRagContext(input, ctx)
  const res = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.25,
    max_tokens: 1400,
  })
  const answer = res.choices[0]?.message?.content?.trim() ?? 'No response.'
  return { answer, sources, lowGrounding }
}
