/**
 * Dev-only: displays the SQL for migration 019.
 * Visit http://localhost:3000/api/internal/apply-migration-019
 * Copy the SQL → paste in Supabase SQL Editor → Run.
 * DELETE THIS FILE after applying.
 */
import { NextResponse } from 'next/server'

const MIGRATION_SQL = `create or replace function public.pk_match_knowledge_chunks(
  p_workspace_id uuid,
  p_query_embedding text,
  p_match_count int default 10,
  p_repository_id uuid default null,
  p_sync_branch text default null
)
returns table (
  id text,
  repository_id uuid,
  source_path text,
  body text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security definer
set search_path = public, extensions
set statement_timeout = 0
as $$
  select
    k.id,
    k.repository_id,
    k.source_path,
    k.body,
    k.metadata,
    (1 - (k.embedding <=> (p_query_embedding::extensions.vector(1536))))::double precision as similarity
  from public.pk_knowledge_chunks k
  where k.workspace_id = p_workspace_id
    and (
      auth.uid() is null
      or public.pk_can_access_workspace(p_workspace_id)
    )
    and (p_repository_id is null or k.repository_id = p_repository_id)
    and (
      p_sync_branch is null
      or btrim(p_sync_branch) = ''
      or k.sync_branch = btrim(p_sync_branch)
    )
  order by k.embedding <=> (p_query_embedding::extensions.vector(1536))
  limit least(coalesce(p_match_count, 10), 50);
$$;

revoke all on function public.pk_match_knowledge_chunks(uuid, text, int, uuid, text) from public;
grant execute on function public.pk_match_knowledge_chunks(uuid, text, int, uuid, text) to authenticated;
grant execute on function public.pk_match_knowledge_chunks(uuid, text, int, uuid, text) to service_role;`

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Dev only' }, { status: 403 })
  }

  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([^.]+)\./)?.[1] ?? 'your-project'
  const sqlEditorUrl = `https://supabase.com/dashboard/project/${projectRef}/sql/new`

  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Migration 019</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#0f0f13;color:#e2e8f0;max-width:860px;margin:auto}
  h1{font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:.5rem}
  p{color:#94a3b8;margin:.5rem 0 1rem}
  a{color:#818cf8;text-decoration:none}
  a:hover{text-decoration:underline}
  pre{background:#1e1e2e;border:1px solid #313244;border-radius:10px;padding:1.5rem;overflow:auto;font-size:13px;line-height:1.6;color:#cdd6f4;white-space:pre}
  .badge{display:inline-block;background:#312e81;color:#a5b4fc;font-size:11px;font-weight:600;border-radius:4px;padding:2px 8px;margin-bottom:1rem}
  button{margin-top:1rem;background:#4f46e5;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:6px;cursor:pointer;font-size:.875rem;font-weight:600}
  button:hover{background:#4338ca}
</style></head><body>
<div class="badge">Migration 019 – RAG vector timeout fix</div>
<h1>Apply this SQL in Supabase SQL Editor</h1>
<p>The assistant couldn't access 175K indexed chunks because the vector scan hit an 8-second statement timeout.<br>
This SQL adds <code>set statement_timeout = 0</code> inside the RPC function, fixing it permanently.</p>
<p>1. Open your <a href="${sqlEditorUrl}" target="_blank">Supabase SQL Editor →</a><br>
2. Paste the SQL below and click <strong>Run</strong>.<br>
3. Done: the assistant will immediately start citing real code chunks.</p>
<pre id="sql">${MIGRATION_SQL}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('sql').textContent).then(()=>this.textContent='Copied!')">Copy SQL</button>
</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}
