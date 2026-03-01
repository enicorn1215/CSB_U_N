import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai/index.mjs';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });
  }

  const { messages, model = 'gpt-5.2' } = req.body as {
    messages?: Message[];
    model?: string;
  };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'OpenAI request failed';
    console.error('Chat API error:', err);
    return res.status(500).json({ error: message });
  }
}
