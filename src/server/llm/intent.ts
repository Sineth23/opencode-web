/**
 * Tier-1 intent routing (cheap heuristics; swap for classifier model later).
 */
export type AssistantIntent = 'feasibility' | 'how_it_works' | 'where_in_code' | 'general'

export function classifyAssistantIntent(message: string): AssistantIntent {
  const m = message.toLowerCase()
  if (/\b(can we|is it possible|could we|are we able|feasible)\b/.test(m)) return 'feasibility'
  if (/\b(where|which file|which repo|in the code|handled in)\b/.test(m)) return 'where_in_code'
  if (/\b(how does|how do|workflow|step|process|flow)\b/.test(m)) return 'how_it_works'
  return 'general'
}

/** Bias retrieval query toward intent (concatenated with user message for embedding). */
export function retrievalQueryForIntent(message: string, intent: AssistantIntent): string {
  // Anchor to application code so very generic questions don't surface vendor/library chunks
  const appAnchor = 'application code business logic service controller model'
  switch (intent) {
    case 'feasibility':
      return `${message}\n\nFocus: ${appAnchor}, constraints, configuration, risks, and whether behavior is supported.`
    case 'where_in_code':
      return `${message}\n\nFocus: ${appAnchor}, file paths, modules, and implementation locations.`
    case 'how_it_works':
      return `${message}\n\nFocus: ${appAnchor}, workflows, triggers, data flow, and dependencies.`
    default:
      return `${message}\n\nFocus: ${appAnchor}.`
  }
}
