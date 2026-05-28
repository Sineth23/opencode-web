-- RAG conversation history
-- Run once in Supabase SQL editor: https://supabase.com/dashboard/project/_/sql

CREATE TABLE IF NOT EXISTS pk_rag_conversations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES pk_workspaces(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL,
  dataset_id   TEXT        NOT NULL,
  dataset_name TEXT        NOT NULL,
  model        TEXT        NOT NULL DEFAULT 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  title        TEXT,
  messages     JSONB       NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pk_rag_conversations_workspace_user
  ON pk_rag_conversations (workspace_id, user_id, updated_at DESC);

ALTER TABLE pk_rag_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rag_conv_owner" ON pk_rag_conversations;
CREATE POLICY "rag_conv_owner"
  ON pk_rag_conversations FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
