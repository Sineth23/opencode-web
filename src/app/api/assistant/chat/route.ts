import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { createPostgresKnowledgeStore } from '@/server/knowledge/postgres-vector-store'
import { classifyAssistantIntent, retrievalQueryForIntent } from '@/server/llm/intent'
import { embedQuery, requireOpenAI } from '@/server/llm/openai-embeddings'
import { buildRagContext, type HandbookSectionSnippet } from '@/server/pipelines/rag-assistant'
import { parseBillingPlanForAi, resolveOrgAiSettings } from '@/server/plans/org-ai-settings'
import { getAssistantRagLatencyConfig } from '@/server/assistant/rag-latency-config'
import { withSupportContact } from '@/lib/support-copy'
import { LLM_MODELS } from '@/server/llm/tiers'
import type { KnowledgeChunk } from '@/server/knowledge/deeplake-store'

function utcMonthPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const encoder = new TextEncoder()

type ChatSSEEvent =
  | { type: 'meta'; sources: { label: string; path?: string; confidence: string }[]; lowGrounding: boolean }
  | { type: 'phase'; key: 'routing' | 'retrieval' | 'reasoning' | 'grounded' | 'power'; label: string }
  | { type: 'token'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

type AssistantResponseMode = 'grounded' | 'power'

function sseChunk(event: ChatSSEEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  thread_id: z.string().uuid().optional().nullable(),
  message: z.string().min(1).max(8000),
  repository_id: z.string().uuid().optional().nullable(),
  branch: z.string().max(200).optional().nullable(),
  persona: z.enum(['pm', 'developer', 'executive']).optional(),
  mode: z.enum(['grounded', 'power']).optional().default('grounded'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(8000),
      })
    )
    .max(24)
    .optional()
    .default([]),
})

const SUMMARY_THRESHOLD = 500
const SUMMARY_INPUT_MAX_CHARS = 120_000

/**
 * Load recent messages + thread summary, with backward-compat fallback for pre-017 schema.
 */
async function loadThreadContext(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  threadId: string,
  userId: string,
  historyLimit: number
) {
  if (!supabase) return null

  type ThreadRow = { id: string; user_id: string; summary?: string | null; summary_at_count?: number; title?: string | null; persona?: string | null }
  let thread: ThreadRow | null = null

  // Try with migration-017 columns first; fall back to base if schema is older
  const { data: fullData, error: fullErr } = await supabase
    .from('pk_chat_threads')
    .select('id, user_id, summary, summary_at_count, title, persona')
    .eq('id', threadId)
    .eq('user_id', userId)
    .single()

  if (fullErr) {
    const { data: baseData, error: baseErr } = await supabase
      .from('pk_chat_threads')
      .select('id, user_id, title')
      .eq('id', threadId)
      .eq('user_id', userId)
      .single()
    if (baseErr || !baseData) return null
    thread = { ...baseData, summary: null, summary_at_count: 0, persona: null }
  } else {
    thread = fullData as ThreadRow
  }

  if (!thread) return null

  const { data: msgs } = await supabase
    .from('pk_chat_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(historyLimit)

  const history = (msgs ?? [])
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  return { thread, history }
}

async function countThreadMessages(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  threadId: string
): Promise<number> {
  if (!supabase) return 0
  const { count } = await supabase
    .from('pk_chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)
  return count ?? 0
}

async function generateAndStoreSummary(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  threadId: string,
  messageCount: number
) {
  if (!supabase) return
  try {
    const { data: msgs } = await supabase
      .from('pk_chat_messages')
      .select('role, content')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .limit(SUMMARY_THRESHOLD)

    if (!msgs || msgs.length < 2) return

    let rawTranscript = msgs
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    if (rawTranscript.length > SUMMARY_INPUT_MAX_CHARS) {
      rawTranscript = rawTranscript.slice(-SUMMARY_INPUT_MAX_CHARS)
    }

    const openai = requireOpenAI()
    const res = await openai.chat.completions.create({
      model: LLM_MODELS.ragAnswer,
      messages: [
        {
          role: 'system',
          content:
            'You summarize technical engineering conversations. Capture: the repository topics discussed, key questions asked, answers given, files or features mentioned, and any conclusions reached. Be detailed enough that a future AI can use this as context for follow-up questions. Write in past tense, 300–500 words.',
        },
        { role: 'user', content: rawTranscript },
      ],
      temperature: 0.2,
      max_tokens: 800,
    })

    const summary = res.choices[0]?.message?.content?.trim()
    if (!summary) return

    await supabase
      .from('pk_chat_threads')
      .update({ summary, summary_at_count: messageCount })
      .eq('id', threadId)
  } catch (e) {
    console.error('[chat] summary generation failed', e)
  }
}

async function persistMessages(
  supabase: ReturnType<typeof createRouteHandlerClient>,
  threadId: string,
  userMessage: string,
  assistantAnswer: string,
  lowGrounding: boolean,
  sources: { label: string; path?: string; confidence: string }[]
) {
  if (!supabase) return
  const fullInsert = await supabase.from('pk_chat_messages').insert([
    { thread_id: threadId, role: 'user', content: userMessage, low_grounding: false, sources: [] },
    { thread_id: threadId, role: 'assistant', content: assistantAnswer, low_grounding: lowGrounding, sources },
  ])
  if (fullInsert.error) {
    await supabase.from('pk_chat_messages').insert([
      { thread_id: threadId, role: 'user', content: userMessage, low_grounding: false },
      { thread_id: threadId, role: 'assistant', content: assistantAnswer, low_grounding: lowGrounding },
    ])
  }
}

/**
 * Grounded assistant: streams tokens via SSE.
 * Falls back gracefully: if vector search fails, answers from CodeWiki or history only.
 */
export async function POST(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      answer: withSupportContact(
        'Set OPENAI_API_KEY in your environment to enable grounded answers. Until then, browse the Documentation tab.'
      ),
      sources: [],
      lowGrounding: true,
      mode: 'placeholder',
    })
  }

  const threadId = parsed.data.thread_id ?? null
  const mode: AssistantResponseMode = parsed.data.mode ?? 'grounded'
  const baseLimits = getAssistantRagLatencyConfig()
  const ragLimits =
    mode === 'power'
      ? {
          ...baseLimits,
          handbookFetchLimit: Math.min(220, Math.max(baseLimits.handbookFetchLimit, 120)),
          handbookBodyMaxChars: Math.min(4000, Math.max(baseLimits.handbookBodyMaxChars, 1600)),
          handbookSectionsMax: Math.min(16, Math.max(baseLimits.handbookSectionsMax, 10)),
          vectorTopK: Math.min(48, Math.max(baseLimits.vectorTopK, 24)),
          contextChunksMax: Math.min(24, Math.max(baseLimits.contextChunksMax, 12)),
          maxOutputTokens: Math.min(4096, Math.max(baseLimits.maxOutputTokens, 1800)),
          threadHistoryMax: Math.min(32, Math.max(baseLimits.threadHistoryMax, 24)),
        }
      : baseLimits

  // Load thread context before entering stream (can return non-stream 404)
  let threadHistory: { role: 'user' | 'assistant'; content: string }[] = parsed.data.history
  let threadSummary: string | null = null
  let isFirstMessage = false
  let threadPersona: 'pm' | 'developer' | 'executive' | null = null

  if (threadId) {
    const ctx = await loadThreadContext(supabase, threadId, userData.user.id, ragLimits.threadHistoryMax)
    if (!ctx) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }
    threadHistory = ctx.history
    threadSummary = ctx.thread.summary ?? null
    isFirstMessage = threadHistory.length === 0
    const rawP = ctx.thread.persona
    if (rawP === 'pm' || rawP === 'developer' || rawP === 'executive') {
      threadPersona = rawP
    }
  }

  const effectivePersona: 'pm' | 'developer' | 'executive' =
    parsed.data.persona ?? threadPersona ?? 'pm'

  // Workspace + billing settings
  const { data: wsRow, error: wsErr } = await supabase
    .from('pk_workspaces')
    .select('billing_plan, org_ai_settings')
    .eq('id', parsed.data.workspace_id)
    .single()

  if (wsErr || !wsRow) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  const orgAi = resolveOrgAiSettings(parseBillingPlanForAi(wsRow.billing_plan as string), wsRow.org_ai_settings)

  // Model selection (premium cap): do this before stream so tier is known
  let chatModel = orgAi.rag_standard_model
  let ragTier: 'standard' | 'premium' = 'standard'
  const period = utcMonthPeriod()
  let premiumUsedBefore = 0

  const svc = createServiceRoleClient()
  if (svc && !orgAi.force_standard_rag_only && orgAi.premium_rag_monthly_cap > 0) {
    const { data: useRow } = await svc
      .from('pk_workspace_usage_counters')
      .select('value')
      .eq('workspace_id', parsed.data.workspace_id)
      .eq('metric', 'premium_rag_turn')
      .eq('period', period)
      .maybeSingle()
    premiumUsedBefore = typeof useRow?.value === 'number' ? useRow.value : 0
    if (premiumUsedBefore < orgAi.premium_rag_monthly_cap) {
      chatModel = orgAi.rag_premium_model
      ragTier = 'premium'
    }
  }

  const forceStandardEnv = process.env.PK_RAG_FORCE_STANDARD_MODEL
  if (forceStandardEnv === '1' || forceStandardEnv === 'true') {
    chatModel = orgAi.rag_standard_model
    ragTier = 'standard'
  }

  // Return SSE stream
  const readable = new ReadableStream({
    async start(controller) {
      const send = (event: ChatSSEEvent) => {
        try { controller.enqueue(sseChunk(event)) } catch { /* stream closed */ }
      }

      try {
        const repoId = parsed.data.repository_id ?? null
        const branchFilter =
          repoId && parsed.data.branch && parsed.data.branch.trim().length > 0
            ? parsed.data.branch.trim()
            : null
        send({
          type: 'phase',
          key: 'routing',
          label: mode === 'power' ? 'Understanding your question and planning a deep answer…' : 'Routing your question and checking scope…',
        })

        const intent = classifyAssistantIntent(parsed.data.message)
        const retrievalQuery = retrievalQueryForIntent(parsed.data.message, intent)
        send({
          type: 'phase',
          key: 'retrieval',
          label: mode === 'power' ? 'Pulling broader context from handbook and code…' : 'Searching handbook and indexed code…',
        })

        // ── Fan-out: embed + repo metadata + handbook sections all in parallel ──
        type RepoMeta = { name: string; slug: string } | null
        type HandbookRow = {
          id: string
          title: string
          category: string
          summary: string
          body_md: string
          doc_archetype: string | null
        }

        const [embedding, repoRow, rawHandbookRows] = await Promise.all([
          embedQuery(retrievalQuery, { model: orgAi.embedding_model }).catch(() => null),
          (async (): Promise<RepoMeta> => {
            if (!repoId) return null
            try {
              const { data } = await supabase
                .from('pk_linked_repositories')
                .select('name, slug')
                .eq('id', repoId)
                .single()
              return (data as RepoMeta) ?? null
            } catch {
              return null
            }
          })(),
          // Load handbook sections for this workspace (small table, no vector needed)
          (async (): Promise<HandbookRow[]> => {
            try {
              const { data } = await supabase
                .from('pk_doc_sections')
                .select('id, title, category, summary, body_md, doc_archetype')
                .eq('workspace_id', parsed.data.workspace_id)
                .order('updated_at', { ascending: false })
                .limit(ragLimits.handbookFetchLimit)
              return (data ?? []) as HandbookRow[]
            } catch {
              return []
            }
          })(),
        ])

        const repoName = repoRow?.name ?? repoRow?.slug ?? null

        // ── Score handbook sections by keyword overlap ────────────────────
        const queryWords = new Set(
          parsed.data.message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
        )
        const handbookSections: HandbookSectionSnippet[] = rawHandbookRows
          .map((row) => {
            const arch = row.doc_archetype ?? 'handbook'
            const text = `${row.title} ${row.summary} ${row.category} ${arch}`.toLowerCase()
            let score = 0
            for (const w of queryWords) {
              if (text.includes(w)) score += 1
              // Boost exact title matches heavily
              if (row.title.toLowerCase().includes(w)) score += 1.5
            }
            const normalised = queryWords.size > 0 ? score / (queryWords.size * 2.5) : 0
            return {
              id: row.id,
              title: row.title,
              category: row.category,
              summary: row.summary ?? '',
              bodySnippet: (row.body_md ?? '').slice(0, ragLimits.handbookBodyMaxChars),
              relevanceScore: Math.min(1, normalised),
            }
          })
          .filter((s) => s.relevanceScore > 0.08)
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, ragLimits.handbookSectionsMax)

        // ── RAG vector search (needs embedding from above) ────────────────
        let chunks: KnowledgeChunk[] = []
        if (embedding) {
          try {
            const store = createPostgresKnowledgeStore(supabase, 'read')
            const maxC = ragLimits.contextChunksMax
            const raw = await store.querySimilar(parsed.data.workspace_id, embedding, {
              topK: ragLimits.vectorTopK,
              minScore: 0,
              repositoryId: repoId,
              syncBranch: branchFilter,
            })

            // Deprioritise vendor / library files bundled in the repo
            const isVendorPath = (p: string) =>
              /node_modules|\/vendor\/|javalib\/|\/lib\/|\/dist\/|\/build\/|\.min\.|\/plugins\/[\w.-]+\d+|\/bower_components\//i.test(p)

            const appChunks = raw.filter((c) => !isVendorPath(c.sourcePath))
            const vendorChunks = raw.filter((c) => isVendorPath(c.sourcePath))
            const highSim = (c: KnowledgeChunk) => Number(c.metadata?.similarity ?? 0) >= 0.15
            const preferred = appChunks.filter(highSim).slice(0, maxC)
            const fallback = preferred.length < 6
              ? [...appChunks.filter((c) => !highSim(c)), ...vendorChunks.filter(highSim)].slice(0, maxC - preferred.length)
              : []
            chunks = [...preferred, ...fallback].slice(0, maxC)
          } catch (ragErr) {
            console.error('[assistant] vector retrieval failed (continuing without chunks):', ragErr)
          }
        }

        // ── Build context + sources ──────────────────────────────────────
        const { messages, sources, lowGrounding } = buildRagContext(
          {
            workspaceId: parsed.data.workspace_id,
            userMessage: parsed.data.message,
            history: threadHistory,
            persona: effectivePersona,
            chatModel,
            codewiki: null,
            threadSummary,
            repoName,
            branch: branchFilter,
            handbookSections,
          },
          { chunks }
        )

        if (mode === 'power') {
          const systemPrimer =
            effectivePersona === 'pm'
              ? 'Answer with strong product awareness: lead with a clear recommendation or decision, then explain trade-offs, who is affected, and what to do next—in plain language first, technical detail only when it helps. Be specific and practical; avoid generic filler.'
              : 'Answer with strong product awareness and confident technical depth. Start with a direct recommendation/answer, then explain reasoning, trade-offs, and implementation implications. Be specific and practical; avoid generic filler.'
          messages.unshift({ role: 'system', content: systemPrimer })
        }

        // Send sources + grounding info immediately: client shows them while tokens arrive
        send({ type: 'meta', sources, lowGrounding })
        send({
          type: 'phase',
          key: mode === 'power' ? 'power' : 'grounded',
          label: mode === 'power' ? 'Composing a deeper answer with product-aware recommendations…' : 'Composing a grounded answer with citations…',
        })

        // ── Stream LLM completion ────────────────────────────────────────
        const openai = requireOpenAI()
        const stream = await openai.chat.completions.create({
          model: chatModel,
          messages,
          temperature: 0.25,
          max_tokens: ragLimits.maxOutputTokens,
          stream: true,
        })

        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content ?? ''
          if (token) {
            fullText += token
            send({ type: 'token', content: token })
          }
        }

        // ── Persist messages ─────────────────────────────────────────────
        if (threadId && fullText) {
          try {
            await persistMessages(supabase, threadId, parsed.data.message, fullText, lowGrounding, sources)
          } catch (persistErr) {
            console.error('[assistant] message persistence failed:', persistErr)
          }

          // Auto-title first message
          if (isFirstMessage) {
            const autoTitle = parsed.data.message.slice(0, 80).replace(/\n/g, ' ').trim()
            try {
              await supabase
                .from('pk_chat_threads')
                .update({ title: autoTitle })
                .eq('id', threadId)
            } catch { /* non-critical */ }
          }

          // Fire-and-forget: summary refresh
          ;(async () => {
            try {
              const total = await countThreadMessages(supabase, threadId)
              if (total >= SUMMARY_THRESHOLD && total % SUMMARY_THRESHOLD < 2) {
                await generateAndStoreSummary(supabase, threadId, total)
              }
            } catch {}
          })().catch(() => {})
        }

        // ── Premium usage tracking ───────────────────────────────────────
        if (ragTier === 'premium' && svc) {
          void (async () => {
            const { error: rpcErr } = await svc.rpc('pk_increment_premium_rag_turn', {
              p_workspace_id: parsed.data.workspace_id,
            })
            if (rpcErr) console.error('pk_increment_premium_rag_turn', rpcErr)
          })()
        }

        send({ type: 'done' })
        controller.close()
      } catch (e) {
        console.error('[assistant chat] fatal error:', e)
        const msg = e instanceof Error ? e.message : String(e)
        // Never expose internal details: sanitize before sending
        const userMsg = /openai|api.key|unauthorized/i.test(msg)
          ? 'AI service unavailable. Please check your configuration.'
          : /match_knowledge|rpc|function|does not exist/i.test(msg)
          ? 'Knowledge search is temporarily unavailable. Try again in a moment.'
          : 'Something went wrong. Please try again in a moment.'
        send({ type: 'error', message: withSupportContact(userMsg) })
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  })
}
