import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO 8601
  isIntervention?: boolean;
};

type Conversation = {
  id: string;
  title: string;
  createdAt: string; // ISO 8601
  messages: Message[];
};

const STORAGE_KEY = 'ui-experiment-conversations';
const SELECTED_KEY = 'ui-experiment-selected';
const THEME_KEY = 'ui-experiment-theme';
const SESSION_KEY = 'ui-experiment-session-id';
const SUBMISSION_KEY = 'ui-experiment-submission';
const SUBMITTED_KEY = 'ui-experiment-submitted';
const PROCEEDED_KEY = 'ui-experiment-proceeded';

const TASK_TITLE = 'Ideation task';
const TASK_DESCRIPTION =
  'In this task, you will collaborate with an AI assistant to brainstorm ideas for reducing screen time before bed. Through interaction with an AI assistant, you can develop, refine, and adjust ideas together. Your goal is to generate a final idea that are both creative and practical.';
const AI_GREETING =
  'Hi, let’s collaborate on this. Please start by proposing one idea for reducing late-night screen use before bedtime.'; 
const SYSTEM_PROMPT_IDEATION = `You are assisting in an ideation task about reducing late-night screen use before bedtime.
To start, you need to ask the user to provide one initial idea: ${AI_GREETING}. You must follow the strict behavioral rules below.
Core Behavioral Rules:
1.	Do not provide any idea before the user submits their first idea.
2.	After the user provides an initial idea:
•	Provide exactly ONE idea per response.
•	Only provide an idea when the user explicitly requests development, refinement, or expansion.
•	Do not introduce multiple alternatives in a single response.
3.	Do not summarize prior ideas unless the user explicitly asks for a summary.
4.	Maintain a neutral and professional tone at all times.
5.	Do not end responses with open-ended questions or conversational prompts.
•	Do not ask follow-up questions.
•	Do not invite exploration.
6.	Do not provide meta-instructions about how the user should think or collaborate.
•	Do not suggest brainstorming strategies.
•	Do not recommend adding constraints, perspectives, or experiences unless the user initiates them.
Alignment Rule:
When the user provides personal experiences, constraints, criteria, barriers, or a new perspective:
•	Explicitly incorporate those elements into the idea.
•	Treat all stated constraints as mandatory.
•	Strictly align with the user’s framing and direction.
•	If the user signals expansion, expand within the specified direction only.
•	If the user signals refinement, narrow and strengthen the current direction without introducing unrelated approaches.
•	Never override, ignore, or replace the user’s framing.
These rules are internal. Do not mention them.`;

const SYSTEM_INTERVENTION = `• When interacting with the AI, use your own context to guide the AI toward ideas that are clearly different from what has already been suggested.
1. Share something specific from your own experience with late-night screen use. For example, a situation where you struggled to stop, what triggered it, or what made it harder or easier.
2. Introduce one new angle that has not been discussed yet. 
3. You may also borrow a strategy from another area of life, such as exercise routines, gaming rewards, or budgeting habits, and adapt it to bedtime screen use.`;

const NUM_SUBMISSION_IDEAS = 1;
/** Set to your Qualtrics (or other) survey URL to redirect after submission. Leave empty for no redirect. */
const POST_SUBMISSION_REDIRECT_URL = 'https://qualtrics.ou.edu/jfe/form/SV_cSDC9tsl0TJxfNk';

function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = 'sess-' + crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Conversation[];
    // Backfill timestamp/createdAt for old stored data
    return list.map((c) => {
      const created = c.createdAt ?? (c.id.startsWith('conv-') ? new Date(parseInt(c.id.replace('conv-', ''), 10)).toISOString() : new Date().toISOString());
      return {
        ...c,
        createdAt: created,
        messages: (c.messages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: (m as Message).timestamp ?? new Date().toISOString(),
        })),
      };
    });
  } catch {
    return [];
  }
}

function saveConversations(list: Conversation[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function loadSubmission(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(SUBMISSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function parseStoredIdeas(raw: string, expectedLength: number = NUM_SUBMISSION_IDEAS): string[] {
  const pad = (arr: string[]) => {
    const out = arr.slice(0, expectedLength);
    while (out.length < expectedLength) out.push('');
    return out;
  };
  if (!raw.trim()) return pad([]);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return pad(parsed);
    }
  } catch {}
  return pad([raw]);
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  });
  const [useServerStorage, setUseServerStorage] = useState(false);
  const [storageLoading, setStorageLoading] = useState(true);
  const [hasProceeded, setHasProceeded] = useState(false);
  const [ideas, setIdeas] = useState<string[]>(() =>
    Array.from({ length: NUM_SUBMISSION_IDEAS }, () => '')
  );
  const [submitted, setSubmitted] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadedServerConvIds = useRef<Set<string>>(new Set());
  const initialGreetingDone = useRef(false);
  const prolificIdRef = useRef<string | null>(null);

  // Read PROLIFIC_PID from URL once on load (Prolific redirects with ?PROLIFIC_PID=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const pid = params.get('PROLIFIC_PID') || null;
    prolificIdRef.current = pid;
  }, []);

  const selected = conversations.find((c) => c.id === selectedId);

  // Load proceeded state from sessionStorage
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && sessionStorage.getItem(PROCEEDED_KEY) === 'true') {
        setHasProceeded(true);
      }
    } catch {}
  }, []);

  // Load Stage 1 submission: try API first, else localStorage: try API first, else localStorage
  useEffect(() => {
    const stored = loadSubmission();
    setIdeas(parseStoredIdeas(stored));
    const sessionId = getSessionId();
    const prolificQ = prolificIdRef.current ? `&prolific_id=${encodeURIComponent(prolificIdRef.current)}` : '';
    fetch(`/api/submissions?session_id=${encodeURIComponent(sessionId)}${prolificQ}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { submitted: boolean; content?: string }) => {
        if (data.submitted && typeof data.content === 'string') {
          setIdeas(parseStoredIdeas(data.content));
          setSubmitted(true);
          if (typeof window !== 'undefined') {
            localStorage.setItem(SUBMISSION_KEY, data.content);
            localStorage.setItem(SUBMITTED_KEY, 'true');
          }
        }
      })
      .catch(() => {
        try {
          if (typeof window !== 'undefined' && localStorage.getItem(SUBMITTED_KEY) === 'true') {
            setSubmitted(true);
          }
        } catch {}
      });
  }, []);

  // Save ideas to localStorage (draft)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const toStore = ideas.length === 1 && !ideas[0].trim() ? '' : JSON.stringify(ideas);
    localStorage.setItem(SUBMISSION_KEY, toStore);
  }, [ideas]);

  // Initial load: try server first, fallback to localStorage
  useEffect(() => {
    const savedTheme = typeof window !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
    const savedSelected = typeof window !== 'undefined' ? localStorage.getItem(SELECTED_KEY) : null;

    const sessionId = getSessionId();
    const prolificQ = prolificIdRef.current ? `&prolific_id=${encodeURIComponent(prolificIdRef.current)}` : '';
    fetch(`/api/conversations?session_id=${encodeURIComponent(sessionId)}${prolificQ}`)
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('Server storage not available');
      })
      .then((list: Conversation[]) => {
        setUseServerStorage(true);
        setConversations(Array.isArray(list) ? list : []);
        if (savedSelected) setSelectedId(savedSelected);
      })
      .catch(() => {
        setUseServerStorage(false);
        setConversations(loadConversations());
        if (savedSelected) setSelectedId(savedSelected);
      })
      .finally(() => setStorageLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
  }, [selectedId]);

  // With no sidebar: auto-select first conversation when we have conversations and no selection
  useEffect(() => {
    if (conversations.length > 0 && !selectedId) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  // On main page with no conversations: after showing welcome-cta, start with AI greeting and initial idea
  useEffect(() => {
    if (!hasProceeded || storageLoading || conversations.length > 0 || initialGreetingDone.current) return;
    initialGreetingDone.current = true;
    const now = new Date().toISOString();
    const greetingMessage: Message = { role: 'assistant', content: AI_GREETING, timestamp: now };

    if (useServerStorage) {
      const sessionId = getSessionId();
      fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          title: 'Chat',
          prolific_id: prolificIdRef.current ?? undefined,
          origin_url: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error('Failed to create')))
        .then(async (data: { id: string; title?: string; createdAt?: string }) => {
          const conv: Conversation = {
            id: data.id,
            title: data.title || 'Chat',
            createdAt: data.createdAt || now,
            messages: [greetingMessage],
          };
          const saveRes = await fetch(`/api/conversations/${conv.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              messages: [greetingMessage],
              ...(prolificIdRef.current ? { prolific_id: prolificIdRef.current } : {}),
            }),
          });
          if (!saveRes.ok) throw new Error('Failed to save greeting');
          setConversations([conv]);
          setSelectedId(conv.id);
        })
        .catch(() => {
          initialGreetingDone.current = false;
          const localConv: Conversation = {
            id: `conv-${Date.now()}`,
            title: 'Chat',
            createdAt: now,
            messages: [greetingMessage],
          };
          setConversations([localConv]);
          setSelectedId(localConv.id);
        });
    } else {
      const conv: Conversation = {
        id: `conv-${Date.now()}`,
        title: 'Chat',
        createdAt: now,
        messages: [greetingMessage],
      };
      setConversations([conv]);
      setSelectedId(conv.id);
    }
  }, [hasProceeded, storageLoading, conversations.length, useServerStorage]);

  useEffect(() => {
    if (!useServerStorage) saveConversations(conversations);
  }, [conversations, useServerStorage]);

  // When in server mode and user selects a conversation, fetch messages once
  useEffect(() => {
    if (!useServerStorage || !selectedId || storageLoading) return;
    if (loadedServerConvIds.current.has(selectedId)) return;
    loadedServerConvIds.current.add(selectedId);
    const sessionId = getSessionId();
    const prolificQ = prolificIdRef.current ? `&prolific_id=${encodeURIComponent(prolificIdRef.current)}` : '';
    fetch(`/api/conversations/${encodeURIComponent(selectedId)}?session_id=${encodeURIComponent(sessionId)}${prolificQ}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed to load'))))
      .then((data: Conversation) => {
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, messages: data.messages || [] } : c))
        );
      })
      .catch(() => {
        loadedServerConvIds.current.delete(selectedId);
      });
  }, [useServerStorage, selectedId, storageLoading]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selected?.messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    setInput('');

    let conv = selected;
    const now = new Date().toISOString();
    const sessionId = getSessionId();
    const greetingMessage: Message = { role: 'assistant', content: AI_GREETING, timestamp: now };
    const wasNewConversation = !conv;

    if (!conv) {
      if (useServerStorage) {
        try {
          const createRes = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              title: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
              prolific_id: prolificIdRef.current ?? undefined,
              origin_url: typeof window !== 'undefined' ? window.location.origin : undefined,
            }),
          });
          const createData = await createRes.json();
          if (!createRes.ok) throw new Error(createData.error || 'Failed to create');
          conv = {
            id: createData.id,
            title: createData.title || 'New chat',
            createdAt: createData.createdAt || now,
            messages: [greetingMessage],
          };
        } catch {
          conv = {
            id: `conv-${Date.now()}`,
            title: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
            createdAt: now,
            messages: [greetingMessage],
          };
        }
      } else {
        conv = {
          id: `conv-${Date.now()}`,
          title: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
          createdAt: now,
          messages: [greetingMessage],
        };
      }
      setConversations((prev) => [...prev, conv!]);
      setSelectedId(conv.id);
    }

    const userMessage: Message = { role: 'user', content: text, timestamp: now };
    const updatedMessages = [...conv.messages, userMessage];

    setConversations((prev) =>
      prev.map((c) =>
        c.id === conv!.id ? { ...c, messages: updatedMessages } : c
      )
    );
    setLoading(true);

    const assistantTimestamp = new Date().toISOString();

    try {
      const systemContent = SYSTEM_PROMPT_IDEATION;
      const apiMessages = [
        { role: 'system' as const, content: systemContent },
        ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
      }

      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('text/event-stream')) {
        const data = await res.json();
        throw new Error(data.error || 'Expected streaming response');
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response body');

      let streamedContent = '';
      let buffer = '';
      let loadingCleared = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as { content?: string };
              if (typeof parsed.content === 'string') {
                streamedContent += parsed.content;
                if (!loadingCleared) {
                  loadingCleared = true;
                  setLoading(false);
                }
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === conv!.id
                      ? {
                          ...c,
                          messages: [
                            ...updatedMessages,
                            {
                              role: 'assistant' as const,
                              content: streamedContent,
                              timestamp: assistantTimestamp,
                            },
                          ],
                        }
                      : c
                  )
                );
              }
            } catch {
              // ignore parse errors for incomplete chunks
            }
          }
        }
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: streamedContent,
        timestamp: assistantTimestamp,
      };
      const finalMessages: Message[] =
        streamedContent.length > 0
          ? [...updatedMessages, assistantMessage]
          : [...updatedMessages];

      const isFirstExchange = conv.messages.length === 1;
      const newTitle = isFirstExchange ? text.slice(0, 40) + (text.length > 40 ? '…' : '') : undefined;

      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv!.id
            ? { ...c, messages: finalMessages, title: newTitle ?? c.title }
            : c
        )
      );

      if (useServerStorage && streamedContent.length > 0) {
        const messagesToSave = wasNewConversation ? [greetingMessage, userMessage, assistantMessage] : [userMessage, assistantMessage];
        await fetch(`/api/conversations/${conv.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            messages: messagesToSave,
            ...(newTitle ? { title: newTitle } : {}),
            ...(prolificIdRef.current ? { prolific_id: prolificIdRef.current } : {}),
          }),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv!.id ? { ...c, messages: updatedMessages } : c
        )
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, selected, useServerStorage]);

  const selectConversation = useCallback((id: string) => {
    setSelectedId(id);
    setError(null);
  }, []);

  const proceedToMain = useCallback(() => {
    setHasProceeded(true);
    if (typeof window !== 'undefined') sessionStorage.setItem(PROCEEDED_KEY, 'true');
  }, []);

  const updateIdea = useCallback((index: number, value: string) => {
    setIdeas((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const addIdea = useCallback(() => {
    setIdeas((prev) => [...prev, '']);
  }, []);

  const removeIdea = useCallback((index: number) => {
    if (ideas.length <= 1) return;
    setIdeas((prev) => prev.filter((_, i) => i !== index));
  }, [ideas.length]);

  const handleSubmitStage1 = useCallback(async () => {
    const trimmed = ideas.slice(0, NUM_SUBMISSION_IDEAS).map((s) => s.trim());
    if (!trimmed.some(Boolean) || submitting) return;
    setSubmissionError(null);
    setSubmitting(true);
    const sessionId = getSessionId();
    const content = JSON.stringify(trimmed);
    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          content,
          prolific_id: prolificIdRef.current ?? undefined,
          origin_url: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSubmitted(true);
        if (typeof window !== 'undefined') {
          localStorage.setItem(SUBMISSION_KEY, content);
          localStorage.setItem(SUBMITTED_KEY, 'true');
          if (POST_SUBMISSION_REDIRECT_URL) {
            const url = prolificIdRef.current
              ? `${POST_SUBMISSION_REDIRECT_URL}?PROLIFIC_PID=${encodeURIComponent(prolificIdRef.current)}`
              : POST_SUBMISSION_REDIRECT_URL;
            window.location.href = url;
          }
        }
      } else if (res.status === 503) {
        setSubmissionError('Server storage unavailable. Saved locally only.');
        setSubmitted(true);
        if (typeof window !== 'undefined') {
          localStorage.setItem(SUBMISSION_KEY, content);
          localStorage.setItem(SUBMITTED_KEY, 'true');
          if (POST_SUBMISSION_REDIRECT_URL) {
            const url = prolificIdRef.current
              ? `${POST_SUBMISSION_REDIRECT_URL}?PROLIFIC_PID=${encodeURIComponent(prolificIdRef.current)}`
              : POST_SUBMISSION_REDIRECT_URL;
            window.location.href = url;
          }
        }
      } else {
        setSubmissionError(data.error || 'Failed to save submission. Please try again.');
      }
    } catch {
      setSubmissionError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [ideas, submitting]);

  // Intro page: task + instructions + Proceed
  if (!hasProceeded) {
    return (
      <>
        <Head>
          <title>Ideation Task — Reducing Screen Time</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <div className={`intro-page ${theme}`}>
          <div className="intro-card">
            <h1 className="intro-title">{TASK_TITLE}</h1>
            <section className="intro-section">
              <h2 className="intro-heading">Instructions</h2>
              <p className="intro-description">
                In this task, you will collaborate with an AI system to generate ideas that are both creative and practical for{' '}
                <span className="intro-highlight">reducing screen time before bed</span>.
              </p>
              <p className="intro-description">
                To begin, <strong>you will need to propose one initial idea to the chat</strong>. After that, you may interact with the AI tool freely. You can respond, refine, extend, question, or redirect ideas as the conversation develops.
              </p>
              <p className="intro-description">
                Your goal is to work with the AI to develop strong ideas through discussion. There is no required format for interaction.
              </p>
              <p className="intro-description">
                When you are ready, continue to the chat.
              </p>
            </section>
            <button type="button" className="proceed-btn" onClick={proceedToMain}>
              Proceed
            </button>
          </div>
        </div>
        <style jsx>{`
          .intro-page {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-main);
            color: var(--text);
            padding: 24px;
          }
          .intro-page.dark {
            --bg-main: #0d0d0d;
            --text: #ececec;
            --text-muted: #9ca3af;
            --border: #2a2a2a;
            --accent: #10a37f;
            --highlight-bg: rgba(16, 163, 127, 0.25);
          }
          .intro-page.light {
            --bg-main: #f5f5f5;
            --text: #171717;
            --text-muted: #737373;
            --border: #e5e5e5;
            --accent: #0d9488;
            --highlight-bg: rgba(13, 148, 136, 0.2);
          }
          .intro-card {
            max-width: 520px;
            width: 100%;
          }
          .intro-title {
            font-size: 28px;
            margin: 0 0 24px;
            color: var(--text);
          }
          .intro-section {
            margin-bottom: 24px;
          }
          .intro-heading {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--accent);
            margin: 0 0 8px;
          }
          .intro-description {
            font-size: 15px;
            line-height: 1.55;
            color: var(--text);
            margin: 0 0 8px;
          }
          .intro-highlight {
            font-weight: 700;
            background: var(--highlight-bg);
            padding: 2px 6px;
            border-radius: 4px;
          }
          .intro-stage-list {
            margin: 0;
            padding-left: 20px;
            font-size: 14px;
            line-height: 1.6;
            color: var(--text);
          }
          .intro-stage-list li { margin-bottom: 6px; }
          .proceed-btn {
            margin-top: 8px;
            padding: 14px 28px;
            background: var(--accent);
            border: none;
            border-radius: 10px;
            color: #fff;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
          }
          .proceed-btn:hover { filter: brightness(1.08); }
        `}</style>
      </>
    );
  }

  // Main area: chat (left) + submission (right)
  return (
    <>
      <Head>
        <title>Ideation Task — Reducing Screen Time</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={`layout ${theme}`}>
        {/* Chat with AI */}
        <main className="panel main-panel">
          <div className="messages" role="log">
            {(selected?.messages ?? [])
              .filter((m) => !m.isIntervention && m.content !== SYSTEM_INTERVENTION)
              .map((m, i) => (
                <div key={i} className={`message ${m.role}`}>
                  <div className="message-inner">
                    <span className="role">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                    <div className="content">{m.content}</div>
                  </div>
                </div>
              ))}
            {loading && (
              <div className="message assistant">
                <div className="message-inner">
                  <span className="role">Assistant</span>
                  <div className="content typing">Thinking…</div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {error && (
            <div className="error-banner">
              {error}
            </div>
          )}

          <div className="input-area">
            <div className="input-wrap">
              <textarea
                ref={inputRef}
                className="input"
                placeholder="Message the AI…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                rows={1}
                disabled={loading}
              />
              <button
                type="button"
                className="send"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </main>

        {/* Right: Idea Submission */}
        <aside className="panel submission-panel">
          <div className="panel-heading">Submission</div>
          <p className="submission-hint">Use the chat on the left to work with the AI. Submit your final idea in the panel below.</p>
          <div className="ideas-list">
            {ideas.map((idea, index) => (
              <div key={index} className="idea-row">
                <textarea
                  className="idea-input idea-textarea"
                  placeholder="Final idea"
                  value={idea}
                  onChange={(e) => updateIdea(index, e.target.value)}
                  disabled={submitted}
                  rows={3}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="submit-btn"
            onClick={handleSubmitStage1}
            disabled={!ideas.some((s) => s.trim()) || submitted || submitting}
          >
            {submitted ? 'Submitted' : submitting ? 'Saving…' : 'Submit idea'}
          </button>
          {submissionError && (
            <p className="submission-error">{submissionError}</p>
          )}
          {submitted && !submissionError && (
            <p className="submission-confirm">Thank you. Your idea has been recorded.</p>
          )}
        </aside>
      </div>

      <style jsx>{`
        .layout {
          display: flex;
          height: 100vh;
          width: 100%;
          max-width: 100vw;
          overflow: hidden;
          background: var(--bg-main);
          color: var(--text);
        }
        .layout.dark {
          --bg-main: #0d0d0d;
          --bg-panel: #171717;
          --bg-input: #262626;
          --border: #2a2a2a;
          --text: #ececec;
          --text-muted: #9ca3af;
          --accent: #10a37f;
          --error-bg: rgba(239, 68, 68, 0.15);
          --error-text: #f87171;
          --collab-tips-bg: rgba(16, 163, 127, 0.12);
          --collab-tips-shadow: rgba(0, 0, 0, 0.2);
        }
        .layout.light {
          --bg-main: #f9f9f9;
          --bg-panel: #fff;
          --bg-input: #fff;
          --border: #e5e5e5;
          --text: #171717;
          --text-muted: #737373;
          --accent: #0d9488;
          --error-bg: rgba(239, 68, 68, 0.12);
          --error-text: #dc2626;
          --collab-tips-bg: rgba(13, 148, 136, 0.08);
          --collab-tips-shadow: rgba(0, 0, 0, 0.06);
        }
        .panel {
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
          background: var(--bg-panel);
          border-right: 1px solid var(--border);
          overflow: hidden;
        }
        .panel:last-of-type {
          border-right: none;
          border-left: 1px solid var(--border);
        }
        .main-panel {
          flex: 1;
          min-width: 320px;
          display: flex;
          flex-direction: column;
        }
        .collab-tips-block {
          flex-shrink: 0;
          padding: 16px 24px;
          margin: 16px 24px 0;
          background: var(--collab-tips-bg);
          border: 1px solid var(--accent);
          border-left: 4px solid var(--accent);
          border-radius: 10px;
          box-shadow: 0 2px 12px var(--collab-tips-shadow);
        }
        .collab-tips-pop {
          animation: collab-tips-in 0.35s ease-out;
        }
        @keyframes collab-tips-in {
          from {
            opacity: 0;
            transform: translateY(-12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .collab-tips-label {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.02em;
          color: var(--accent);
          margin-bottom: 10px;
        }
        .collab-tips-content {
          font-size: 14px;
          line-height: 1.55;
          color: var(--text);
          white-space: pre-line;
          font-weight: 500;
        }
        .submission-panel {
          width: 400px;
          min-width: 360px;
          display: flex;
          flex-direction: column;
        }
        .panel-heading {
          font-size: 14px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--accent);
          margin: 0 0 8px;
          padding: 16px 16px 0;
        }
        .messages {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 24px;
        }
        .welcome {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 200px;
          color: var(--text-muted);
          text-align: center;
          max-width: 36rem;
          margin: 0 auto;
        }
        .welcome h1 {
          font-size: 24px;
          color: var(--text);
          margin: 0 0 12px;
        }
        .welcome-task-box {
          width: 100%;
          max-width: 36rem;
          margin: 0 0 20px;
          padding: 20px 24px;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 12px;
          text-align: left;
          box-sizing: border-box;
        }
        .welcome-task-box-title {
          font-size: 16px;
          font-weight: 700;
          color: var(--text);
          margin: 0 0 12px;
          letter-spacing: 0.02em;
        }
        .welcome-task {
          font-size: 15px;
          line-height: 1.5;
          color: var(--text);
          margin: 0;
        }
        .welcome-task-highlight {
          color: var(--accent);
          font-weight: 700;
        }
        .welcome-stages {
          font-size: 14px;
          text-align: left;
          margin: 0 0 16px;
          padding: 12px 16px;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 10px;
        }
        .welcome-cta {
          margin: 0;
          font-size: 14px;
        }
        .welcome p {
          margin: 0;
          font-size: 15px;
        }
        .submission-hint {
          margin: 0 20px 16px;
          font-size: 16px;
          line-height: 1.5;
          color: var(--text-muted);
        }
        .ideas-list {
          margin: 0 20px 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          min-height: 320px;
          overflow-y: auto;
        }
        .idea-row {
          display: flex;
          flex-direction: column;
        }
        .idea-input {
          flex: 1;
          min-width: 0;
          padding: 14px 16px;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text);
          font-size: 16px;
          font-family: inherit;
          box-sizing: border-box;
        }
        .idea-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .idea-input:disabled {
          opacity: 0.8;
          cursor: not-allowed;
        }
        .idea-textarea {
          min-height: 200px;
          resize: vertical;
        }
        .idea-remove {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          padding: 0;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: transparent;
          color: var(--text-muted);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        .idea-remove:hover {
          color: var(--error-text);
          border-color: var(--error-text);
        }
        .add-idea-btn {
          margin: 0 16px 12px;
          padding: 10px 14px;
          background: transparent;
          border: 1px dashed var(--border);
          border-radius: 8px;
          color: var(--text-muted);
          font-size: 13px;
          cursor: pointer;
          text-align: left;
        }
        .add-idea-btn:hover {
          color: var(--accent);
          border-color: var(--accent);
        }
        .submit-btn {
          margin: 0 16px 16px;
          padding: 12px 20px;
          background: var(--accent);
          border: none;
          border-radius: 10px;
          color: #fff;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
        }
        .submit-btn:hover:not(:disabled) {
          filter: brightness(1.08);
        }
        .submit-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .submission-error {
          margin: 0 16px 16px;
          font-size: 15px;
          color: var(--error-text);
        }
        .submission-confirm {
          margin: 0 16px 16px;
          font-size: 15px;
          color: var(--accent);
        }
        .message {
          max-width: 48rem;
          margin: 0 auto 20px;
        }
        .message.user {
          margin-left: auto;
          margin-right: 0;
        }
        .message-inner {
          padding: 12px 16px;
          border-radius: 12px;
          line-height: 1.6;
        }
        .message.user .message-inner {
          background: var(--accent);
          color: #fff;
        }
        .message.assistant .message-inner {
          background: var(--bg-input);
          border: 1px solid var(--border);
        }
        .message .role {
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          opacity: 0.85;
          margin-bottom: 6px;
        }
        .message .content {
          font-size: 14px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .message .content.typing {
          color: var(--text-muted);
        }
        .error-banner {
          padding: 10px 24px;
          background: var(--error-bg);
          border-top: 1px solid var(--border);
          color: var(--error-text);
          font-size: 13px;
        }
        .input-area {
          flex-shrink: 0;
          width: 100%;
          max-width: 100%;
          padding: 16px 24px 24px;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: center;
          box-sizing: border-box;
        }
        .input-wrap {
          display: flex;
          gap: 10px;
          align-items: flex-end;
          min-width: 0;
          max-width: 48rem;
          width: 100%;
        }
        .input {
          flex: 1;
          min-height: 48px;
          max-height: 200px;
          padding: 12px 16px;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
          font-size: 15px;
          font-family: inherit;
          resize: none;
          min-width: 0;
          box-sizing: border-box;
        }
        .input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .send {
          padding: 12px 20px;
          background: var(--accent);
          border: none;
          border-radius: 12px;
          color: #fff;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }
        .send:hover:not(:disabled) {
          filter: brightness(1.08);
        }
        .send:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </>
  );
}
