import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version TEXT,
      prolific_id TEXT,
      origin_url TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version TEXT,
      prolific_id TEXT,
      origin_url TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_prolific ON conversations(prolific_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_session ON submissions(session_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_prolific ON submissions(prolific_id);
  `);
  // Add version column to existing DBs (ignore if already present)
  try {
    await p.query('ALTER TABLE conversations ADD COLUMN version TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('ALTER TABLE submissions ADD COLUMN version TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('ALTER TABLE conversations ADD COLUMN prolific_id TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('ALTER TABLE conversations ADD COLUMN origin_url TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('ALTER TABLE submissions ADD COLUMN prolific_id TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('ALTER TABLE submissions ADD COLUMN origin_url TEXT');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '42701') throw e;
  }
  try {
    await p.query('CREATE INDEX IF NOT EXISTS idx_conversations_prolific ON conversations(prolific_id)');
  } catch (_) {}
  try {
    await p.query('CREATE INDEX IF NOT EXISTS idx_submissions_prolific ON submissions(prolific_id)');
  } catch (_) {}
}

export type DbConversation = { id: string; title: string; created_at: Date; version?: string | null };
export type DbMessage = { role: string; content: string; timestamp: Date };

/** List conversations by participant: by prolific_id when provided, else by session_id. */
export async function listConversations(
  sessionId: string,
  prolificId?: string | null
): Promise<DbConversation[]> {
  const p = getPool();
  if (!p) return [];
  const byProlific = prolificId && prolificId.trim() !== '';
  const r = await p.query<DbConversation & { version?: string | null }>(
    byProlific
      ? 'SELECT id, title, created_at, version FROM conversations WHERE prolific_id = $1 ORDER BY created_at DESC'
      : 'SELECT id, title, created_at, version FROM conversations WHERE session_id = $1 ORDER BY created_at DESC',
    [byProlific ? prolificId!.trim() : sessionId]
  );
  return r.rows.map((row) => ({
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    version: row.version ?? null,
  }));
}

export async function createConversation(
  sessionId: string,
  title: string,
  version?: string | null,
  prolificId?: string | null,
  originUrl?: string | null
): Promise<{ id: string; title: string; created_at: Date } | null> {
  const p = getPool();
  if (!p) return null;
  const r = await p.query<{ id: string; title: string; created_at: Date }>(
    'INSERT INTO conversations (session_id, title, version, prolific_id, origin_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, created_at',
    [sessionId, title, version ?? null, prolificId ?? null, originUrl ?? null]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

/** Get one conversation by id, scoped by participant: prolific_id when provided, else session_id. */
export async function getConversation(
  conversationId: string,
  sessionId: string,
  prolificId?: string | null
): Promise<{ id: string; title: string; created_at: Date; messages: DbMessage[] } | null> {
  const p = getPool();
  if (!p) return null;
  const byProlific = prolificId && prolificId.trim() !== '';
  const conv = await p.query<{ id: string; title: string; created_at: Date }>(
    byProlific
      ? 'SELECT id, title, created_at FROM conversations WHERE id = $1 AND prolific_id = $2'
      : 'SELECT id, title, created_at FROM conversations WHERE id = $1 AND session_id = $2',
    [conversationId, byProlific ? prolificId!.trim() : sessionId]
  );
  if (conv.rows.length === 0) return null;
  const msgs = await p.query<DbMessage>(
    'SELECT role, content, timestamp FROM messages WHERE conversation_id = $1 ORDER BY id',
    [conversationId]
  );
  return {
    ...conv.rows[0],
    messages: msgs.rows,
  };
}

/** Append messages; conversation ownership by prolific_id when provided, else session_id. */
export async function appendMessages(
  conversationId: string,
  sessionId: string,
  messages: { role: string; content: string; timestamp: string }[],
  prolificId?: string | null
): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const byProlific = prolificId && prolificId.trim() !== '';
  const check = await p.query(
    byProlific
      ? 'SELECT 1 FROM conversations WHERE id = $1 AND prolific_id = $2'
      : 'SELECT 1 FROM conversations WHERE id = $1 AND session_id = $2',
    [conversationId, byProlific ? prolificId!.trim() : sessionId]
  );
  if (check.rows.length === 0) return false;
  for (const m of messages) {
    await p.query(
      'INSERT INTO messages (conversation_id, role, content, timestamp) VALUES ($1, $2, $3, $4::timestamptz)',
      [conversationId, m.role, m.content, m.timestamp]
    );
  }
  return true;
}

/** Update title; conversation ownership by prolific_id when provided, else session_id. */
export async function updateConversationTitle(
  conversationId: string,
  sessionId: string,
  title: string,
  prolificId?: string | null
): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const byProlific = prolificId && prolificId.trim() !== '';
  const r = await p.query(
    byProlific
      ? 'UPDATE conversations SET title = $1 WHERE id = $2 AND prolific_id = $3'
      : 'UPDATE conversations SET title = $1 WHERE id = $2 AND session_id = $3',
    [title, conversationId, byProlific ? prolificId!.trim() : sessionId]
  );
  return (r.rowCount ?? 0) > 0;
}

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

export async function createSubmission(
  sessionId: string,
  content: string,
  version?: string | null,
  prolificId?: string | null,
  originUrl?: string | null
): Promise<{ id: string; submitted_at: Date } | null> {
  const p = getPool();
  if (!p) return null;
  const r = await p.query<{ id: string; submitted_at: Date }>(
    'INSERT INTO submissions (session_id, content, version, prolific_id, origin_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, submitted_at',
    [sessionId, content, version ?? null, prolificId ?? null, originUrl ?? null]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

/** Get latest submission by participant: by prolific_id when provided, else by session_id. */
export async function getSubmissionBySession(
  sessionId: string,
  prolificId?: string | null
): Promise<{ id: string; content: string; submitted_at: Date; version: string | null } | null> {
  const p = getPool();
  if (!p) return null;
  const byProlific = prolificId && prolificId.trim() !== '';
  const r = await p.query<{ id: string; content: string; submitted_at: Date; version: string | null }>(
    byProlific
      ? 'SELECT id, content, submitted_at, version FROM submissions WHERE prolific_id = $1 ORDER BY submitted_at DESC LIMIT 1'
      : 'SELECT id, content, submitted_at, version FROM submissions WHERE session_id = $1 ORDER BY submitted_at DESC LIMIT 1',
    [byProlific ? prolificId!.trim() : sessionId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}
