import type { DocSectionCategory } from '@/types/product-knowledge'

/** Fixed "edition" slots the model must cover (titles may be refined but intent must remain). */
export type CanonicalHandbookSlot = {
  id: string
  category: DocSectionCategory
  titleStem: string
  /** What the section must answer: maps to the 9-area framework and 100-question bank. */
  intent: string
}

/**
 * 18 core handbook chapters covering all 9 framework areas:
 *   A. System Understanding · B. Functional Architecture · C. Feature Deep Dives
 *   D. Workflow Documentation · E. Configuration & Capabilities · F. Integration Layer
 *   G. Codebase Mapping · H. System Behavior & Side Effects · I. Operational Insights
 *
 * Each slot specifies what the 7-part answer format must cover for that chapter.
 */
export const HANDBOOK_CANONICAL_SLOTS: CanonicalHandbookSlot[] = [
  // ── A: System Understanding ────────────────────────────────────────────────
  {
    id: 'H01',
    category: 'system_overview',
    titleStem: 'What this system is: product purpose, users & mental model',
    intent:
      'Plain-language summary of what problem is solved and for whom (Layer 1: What exists). ' +
      'Cover: core capabilities the system provides end-to-end; primary user types and their relationship to the system; ' +
      'key domain concepts a new reader must know before anything else; system boundaries (what is in scope vs out of scope). ' +
      'Use the 7-part format: (1) Plain Language Summary, (2) Functional Explanation, (3) Structural Mapping, ' +
      '(4) Relationships, (5) Edge Cases/Constraints, (6) Example Scenario, (7) Code Reference if useful. ' +
      'Questions answered: What problem does this solve? What are the core capabilities? Who are the primary users? What are the system boundaries? What assumptions does the system make?',
  },
  {
    id: 'H02',
    category: 'system_overview',
    titleStem: 'Architecture & runtime: subsystems, data flow & layer boundaries',
    intent:
      'Full mental model of how the system is organised at runtime (Layer 2: How it works). ' +
      'Cover: major subsystems and services; how data, requests, and control flow between them; ' +
      'ownership boundaries and coupling risks; patterns used; key abstractions; where state is managed. ' +
      'Must include a table or numbered list naming each major component with its role. ' +
      'Questions answered: How is the codebase organised? What are the main services/modules? How do modules communicate? Where is business logic concentrated? What parts are tightly coupled?',
  },

  // ── B: Functional Architecture ─────────────────────────────────────────────
  {
    id: 'H03',
    category: 'system_overview',
    titleStem: 'Core files, entry points & codebase map',
    intent:
      'Ground the architecture in reality: where things actually live (Layer 3: How to act on it). ' +
      'Must include a markdown table | Area | Role | Key Path(s) | for every major subsystem: routers/controllers, ' +
      'domain models/entities, background jobs, config files, bootstrap/entry scripts, test harness, data migrations. ' +
      'Call out which parts are legacy vs active, safe vs fragile. ' +
      'Questions answered: How is the codebase organised? Where does feature X live? What files control workflow Y? What is the entry point for feature Z? What code is legacy? What code is fragile?',
  },
  {
    id: 'H04',
    category: 'capabilities',
    titleStem: 'Capabilities catalog: what the system enables operators & users to do',
    intent:
      'Comprehensive answer to "can we do X?" from an operator or product perspective (Layer 1: What exists). ' +
      'List every end-to-end capability: what outcome is achieved, who triggers it, what data is needed, ' +
      'and what the user/operator sees. Group by domain area. ' +
      'For each capability flag: (a) available today, (b) requires dev help, or (c) not possible. ' +
      'Questions answered: What are the major features? What does each feature do? Why does each feature exist? What can users configure? What requires dev help? What does NOT require dev help?',
  },

  // ── C: Feature Deep Dives ──────────────────────────────────────────────────
  {
    id: 'H05',
    category: 'features',
    titleStem: 'Primary domain features: how each feature works internally',
    intent:
      'Deep explanation of named features: entities, rules, lifecycles (Layer 2: How it works). ' +
      'For each primary feature cover: what it does and why it exists; how it works internally; ' +
      'key data structures or records involved; how it interacts with other features; edge cases; known limitations. ' +
      'CRITICAL: do NOT say "status field exists". Say "the status field controls X, Y, Z; changing it triggers notifications, affects reporting visibility, and alters participant eligibility." ' +
      'Questions answered: What are the major features? How does each feature work? What inputs does each feature require? What outputs does it produce? What systems does it interact with? What are edge cases?',
  },
  {
    id: 'H06',
    category: 'features',
    titleStem: 'Data model & persistence: schema, relationships & consistency',
    intent:
      'Explain how the data layer is organised (Layer 2: How it works). ' +
      'Cover: key entities and their relationships; schema conventions; how migrations work; ' +
      'what is transient vs persistent; what is cached vs real-time; data consistency guarantees or risks; ' +
      'what data is external, derived, or duplicated. ' +
      'Must reference specific migration files, model files, and key columns by path. ' +
      'Questions answered: What are the key data models? How are relationships stored? What is transient vs persistent? What triggers data updates? What data is critical? How is data validated?',
  },

  // ── D: Workflow Documentation ──────────────────────────────────────────────
  {
    id: 'H07',
    category: 'workflows',
    titleStem: 'Critical user & operator workflows: step-by-step with side effects',
    intent:
      'Most important chapter: explain real-world usage flows that non-developers must understand (Layer 3: How to act on it). ' +
      'For each workflow: numbered steps, preconditions, decision points, what happens on each branch, ' +
      'what is triggered automatically (notifications, state changes, jobs), failure paths, and workarounds. ' +
      'CRITICAL: explain SIDE EFFECTS. "Moving a program to past state clears active enrollments, suppresses outbound emails, and removes the record from live reporting dashboards." ' +
      'Questions answered: How does a user create X? What happens when X is triggered? What are the steps in workflow Y? What are decision points? What happens on failure? What triggers notifications? What workarounds exist?',
  },
  {
    id: 'H08',
    category: 'workflows',
    titleStem: 'Asynchronous processes, jobs & background system behavior',
    intent:
      'Explain everything that happens without direct user action (Layer 2: How it works). ' +
      'Cover: background jobs and their schedules; what triggers them; what they read and write; ' +
      'retry logic and failure handling; what happens if they fail silently; ' +
      'async vs sync operations the user would not expect. ' +
      'Questions answered: What is asynchronous vs synchronous? What happens silently? What happens asynchronously? What are race conditions? What can lead to inconsistent states? What behavior depends on timing?',
  },

  // ── E: Configuration & Capabilities ───────────────────────────────────────
  {
    id: 'H09',
    category: 'configurations',
    titleStem: 'Configuration, feature flags & environment differences',
    intent:
      'Answer "can we turn this on/off?" and "what changes between environments?" (Layer 3: How to act on it). ' +
      'Cover: every env var, feature flag, and configuration key found in excerpts; what each controls; ' +
      'per-environment differences (dev vs staging vs prod); what is safe to change without a deploy; ' +
      'what is dangerous to change; default behaviors and overrides. ' +
      'Questions answered: What can users configure? What settings exist? What affects behavior? What is hidden but possible? What requires dev help? What is unsafe to change? What is safe to change?',
  },

  // ── F: Integration Layer ───────────────────────────────────────────────────
  {
    id: 'H10',
    category: 'integration_surface',
    titleStem: 'External integrations: APIs, third-party services & contracts',
    intent:
      'Explain every external dependency and data contract (Layer 2: How it works). ' +
      'For each integration: what data flows in and out; authentication method; failure modes; ' +
      'retry and fallback behavior; what breaks if the integration goes down; what is cached vs live; ' +
      'any webhooks, queues, or file feeds involved. ' +
      'Questions answered: What external APIs are used? What data flows in? What data flows out? What failures can occur? How are retries handled? What breaks if integration fails? What is real-time?',
  },
  {
    id: 'H11',
    category: 'communications',
    titleStem: 'Notifications, outbound communications & messaging contracts',
    intent:
      'Explain every way the system communicates outward to users or external systems (Layer 1: What exists). ' +
      'Cover: email, SMS, in-app, and webhook notifications; what triggers each; templates used; ' +
      'throttling and deduplication rules; what suppresses notifications; ' +
      'what the recipient sees vs what the system records; how to turn off messaging for specific scenarios. ' +
      'Questions answered: What triggers notifications? What is mocked or simulated? What actions have side effects? What happens silently?',
  },

  // ── G: Codebase Mapping ────────────────────────────────────────────────────
  {
    id: 'H12',
    category: 'features',
    titleStem: 'Where logic lives: file-level map of critical functions & decision points',
    intent:
      'Ground documentation in specific paths so readers can navigate the codebase (Layer 3: How to act on it). ' +
      'This is NOT a file dump; map logic to purpose: ' +
      '"The enrollment validation logic lives in `app/models/enrollment.rb`; specifically the `can_enroll?` method at line X guards against duplicate enrollments." ' +
      'Cover: where each major feature\'s core logic lives; where business rules are enforced; ' +
      'where side effects are triggered; which files are fragile; which are safe to modify. ' +
      'Must include a markdown table | Feature/Workflow | File(s) | Key Function(s) | Notes |. ' +
      'Questions answered: Where does feature X live? What files control workflow Y? What functions are critical? What code is fragile? Where are side effects triggered?',
  },

  // ── H: System Behavior & Side Effects ─────────────────────────────────────
  {
    id: 'H13',
    category: 'workarounds',
    titleStem: 'System behavior, cascading effects & non-obvious outcomes',
    intent:
      'Explain hidden logic and unexpected consequences: the most valuable chapter for non-engineers (Layer 2: How it works). ' +
      'Cover: what triggers system-wide changes; cascading effects (action A causes B which causes C); ' +
      'what happens silently or asynchronously that users would not expect; ' +
      'non-obvious behavior and the business outcome of it; ' +
      'what causes inconsistent states; what is irreversible. ' +
      'CRITICAL FORMAT: "Changing status from active → past: (1) suppresses all pending outbound emails, (2) removes program from live reporting, (3) triggers a background reconciliation job that adjusts participant eligibility counts, visible 5–15 minutes later." ' +
      'Questions answered: What triggers system-wide changes? What are cascading effects? What happens silently? What is non-obvious behavior? What actions have side effects? What causes unexpected outcomes?',
  },
  {
    id: 'H14',
    category: 'workarounds',
    titleStem: 'Risks, sharp edges, known limitations & fragile coupling',
    intent:
      'Honest inventory of what can go wrong and where the system has known weaknesses (Layer 3: How to act on it). ' +
      'Cover: data-loss or corruption risks; race conditions; fragile coupling between modules; ' +
      'performance bottlenecks; security or auth boundary gaps found in excerpts; ' +
      'known technical debt; what the system explicitly does NOT handle. ' +
      'Must label inference clearly: "evidence from excerpts suggests…" vs "confirmed in code at path X". ' +
      'Questions answered: Where are the risks in architecture? What can go wrong? What are race conditions? What can lead to inconsistent states? What should never be done?',
  },

  // ── I: Operational Insights ────────────────────────────────────────────────
  {
    id: 'H15',
    category: 'reporting',
    titleStem: 'Reporting, exports, audit & what can be measured',
    intent:
      'What non-developers need to know about data visibility and compliance (Layer 1: What exists). ' +
      'Cover: what reports or exports are available; what data can be filtered, grouped, or exported; ' +
      'what is audited and logged; common pitfalls in interpreting reports; ' +
      'what affects report accuracy (e.g. status changes, timing); ' +
      'what operations require developer access to investigate in the database. ' +
      'Questions answered: What can be measured? What is audited? What improves performance? What tasks are expensive?',
  },
  {
    id: 'H16',
    category: 'workflows',
    titleStem: 'Operations & support playbooks: safe vs risky actions, runbooks',
    intent:
      'Operational decision guide for non-engineers and support staff (Layer 3: How to act on it). ' +
      'Cover: what tasks a non-developer can safely perform; what requires a developer; ' +
      'what is reversible vs irreversible; what slows the system; performance considerations; ' +
      'incident-response starting points; what to check first when something breaks; ' +
      'known workarounds for common failure patterns. ' +
      'Questions answered: When is a developer required? When is a workaround possible? What operations are risky? What operations are reversible? What requires coordination? What should never be done?',
  },
  {
    id: 'H17',
    category: 'configurations',
    titleStem: 'Testing, quality gates & deployment pipeline',
    intent:
      'Explain how changes are validated and shipped (Layer 2: How it works). ' +
      'Cover: test layout and naming conventions; what CI checks run and what they guard against; ' +
      'coverage hotspots; release process steps; how to verify a change is safe before shipping; ' +
      'what environments exist and their differences. ' +
      'Questions answered: How are retries handled? What operations are reversible? What requires coordination?',
  },
  {
    id: 'H18',
    category: 'system_overview',
    titleStem: 'Glossary: domain terms, naming conventions & abbreviations',
    intent:
      'Define every domain-specific term, abbreviation, and naming convention found in excerpts. ' +
      'Cover: business domain vocabulary (not generic programming terms); ' +
      'folder and file naming patterns; status/state values and their business meaning; ' +
      'any product-specific jargon used in the codebase. ' +
      'Format as a definition list or table: Term | Definition | Where used.',
  },
]

export const HANDBOOK_SLOT_BATCH_A = HANDBOOK_CANONICAL_SLOTS.slice(0, 9)
export const HANDBOOK_SLOT_BATCH_B = HANDBOOK_CANONICAL_SLOTS.slice(9, 18)

export function canonicalSlotsPromptBlock(slots: CanonicalHandbookSlot[]): string {
  const lines = slots.map(
    (s) =>
      `- **${s.id}** [${s.category}]: Title stem: "${s.titleStem}"\n  ${s.intent}`,
  )
  return [
    '### Canonical handbook edition (strict batch)',
    'You must produce **exactly one JSON section per slot below**, in slot order. Each array element aligns to one slot:',
    '- Use the **category** given for that slot.',
    "- **Title** must incorporate the slot's title stem (minor wording edits OK; meaning must remain).",
    '- If excerpts have **no** evidence for a slot, still emit the section with a "## Evidence gap" subsection explaining what to look for. Never invent APIs, paths, or behavior.',
    '- Each substantive section MUST follow the 7-part answer format (see system instructions).',
    '',
    ...lines,
  ].join('\n')
}

/** Optional third pass adds at most this many "depth" sections. */
export const HANDBOOK_DEPTH_EXTRA_MAX = 4

/** Maximum sections after optional depth pass. */
export const HANDBOOK_MAX_SECTIONS = 22

/** Chunk rows heuristic: allow optional depth pass. */
export const HANDBOOK_DEPTH_PASS_MIN_CHUNKS = 2_000
