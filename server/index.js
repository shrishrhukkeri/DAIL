import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// llama-3.1-8b-instant is deprecated for free/developer tiers (shutdown Aug 2026)
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'qwen/qwen3.8-27b';
const STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const TTS_MODEL = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const TTS_VOICE = process.env.GROQ_TTS_VOICE || 'austin';

const SYSTEM_PROMPT =
  process.env.GROQ_SYSTEM_PROMPT ||
  'You are a friendly phone assistant. Keep replies short and conversational—1 to 3 sentences—so they sound natural when spoken aloud. Avoid markdown, lists, and URLs.';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function requireGroq(req, res, next) {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
  }
  req.groq = new Groq({ apiKey: GROQ_API_KEY });
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(GROQ_API_KEY) });
});

app.post('/api/transcribe', requireGroq, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file' });
    }

    const filename = req.file.originalname || 'audio.webm';
    const file = await toFile(req.file.buffer, filename, {
      type: req.file.mimetype || 'audio/webm',
    });

    const transcription = await req.groq.audio.transcriptions.create({
      file,
      model: STT_MODEL,
      language: 'en',
      response_format: 'json',
      temperature: 0,
    });

    res.json({ text: (transcription.text || '').trim() });
  } catch (err) {
    console.error('transcribe error:', err);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

app.post('/api/chat', requireGroq, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const safeMessages = messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: m.content }));

  if (!safeMessages.some((m) => m.role === 'system')) {
    safeMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const stream = await req.groq.chat.completions.create({
      model: CHAT_MODEL,
      messages: safeMessages,
      stream: true,
      temperature: 0.7,
      max_tokens: 300,
    });

    for await (const chunk of stream) {
      if (req.aborted) break;
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Chat failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Chat failed' })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/speak', requireGroq, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const response = await req.groq.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text.slice(0, 2000),
      response_format: 'wav',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('speak error:', err);
    const message = err?.message || 'TTS failed';
    const code = err?.error?.error?.code || err?.code || 'tts_failed';
    const status = message.includes('terms acceptance') || code === 'model_terms_required' ? 403 : 500;
    res.status(status).json({
      error: message,
      code: status === 403 ? 'model_terms_required' : code,
      acceptTermsUrl:
        'https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english',
    });
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get('/{*path}', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Caller server listening on http://localhost:${PORT}`);
  if (!GROQ_API_KEY) {
    console.warn('Warning: GROQ_API_KEY is not set');
  }
});
