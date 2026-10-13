import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { concatWavBuffers } from './wavConcat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// llama-3.1-8b-instant is enterprise-only now; gpt-oss-20b is Groq's recommended 8B-class replacement
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b';
const STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const TTS_MODEL = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const TTS_VOICE = process.env.GROQ_TTS_VOICE || 'austin';
const CHAT_MAX_TOKENS = Number(process.env.GROQ_CHAT_MAX_TOKENS || 300);
const CHAT_HISTORY_LIMIT = Number(process.env.GROQ_CHAT_HISTORY_LIMIT || 8);

const SYSTEM_PROMPT =
  process.env.GROQ_SYSTEM_PROMPT ||
  'You are a friendly phone assistant. Match reply length to the question: one short sentence for simple greetings or yes/no, a few clear spoken sentences when explaining something, and only go longer if the caller asks for detail. Speak naturally for voice—no markdown, lists, or URLs.';

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

function healthHandler(_req, res) {
  res.status(200).json({
    ok: true,
    status: 'up',
    ts: new Date().toISOString(),
  });
}

/** Lightweight keep-alive for cron-job.org / uptime pings */
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

function looksLikeMediaContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  // EBML / WebM
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  // RIFF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // ISO BMFF (mp4/m4a)
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return true;
  }
  // Ogg
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // Raw ADTS AAC
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) return true;
  return false;
}

app.post('/api/transcribe', requireGroq, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file' });
    }
    if (!req.file.buffer?.length || req.file.buffer.length < 200) {
      return res.status(400).json({ error: 'Audio too short or empty' });
    }
    if (!looksLikeMediaContainer(req.file.buffer)) {
      return res.status(400).json({
        error: 'Invalid media file (missing container header). Speak again.',
        code: 'invalid_media_file',
      });
    }

    const filename = req.file.originalname || 'audio.webm';
    const mime = req.file.mimetype || (filename.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm');
    const file = await toFile(req.file.buffer, filename, { type: mime });

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
    const code = err?.error?.error?.code || err?.code;
    const status = err?.status === 400 || code === 'invalid_media_file' ? 400 : 500;
    res.status(status).json({
      error: err.message || 'Transcription failed',
      code: code || 'transcribe_failed',
    });
  }
});

app.post('/api/chat', requireGroq, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  let safeMessages = messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: m.content }));

  // Keep only recent turns to limit token burn
  const systemMsgs = safeMessages.filter((m) => m.role === 'system');
  const turnMsgs = safeMessages.filter((m) => m.role !== 'system').slice(-CHAT_HISTORY_LIMIT);
  safeMessages = systemMsgs.length
    ? [...systemMsgs.slice(0, 1), ...turnMsgs]
    : [{ role: 'system', content: SYSTEM_PROMPT }, ...turnMsgs];

  if (!safeMessages.some((m) => m.role === 'system')) {
    safeMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const chatParams = {
      model: CHAT_MODEL,
      messages: safeMessages,
      stream: true,
      temperature: 0.6,
      max_tokens: CHAT_MAX_TOKENS,
    };
    // gpt-oss models support low reasoning to avoid burning tokens on hidden chain-of-thought
    if (CHAT_MODEL.includes('gpt-oss')) {
      chatParams.reasoning_effort = 'low';
    }

    const stream = await req.groq.chat.completions.create(chatParams);

    for await (const chunk of stream) {
      // Node 20+: req.aborted is deprecated; also watch response close
      if (req.destroyed || res.writableEnded || res.closed) break;
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

/** Orpheus hard-caps input at 200 chars; keep under to save daily token quota. */
const ORPHEUS_CHUNK = 180;

function cleanSpeakText(text) {
  return text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function chunkSpeakText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function isRateLimited(err) {
  const message = err?.message || '';
  const code = err?.error?.error?.code || err?.code || '';
  const statusNum = err?.status || err?.statusCode || err?.error?.status;
  return statusNum === 429 || code === 'rate_limit_exceeded' || /rate.?limit/i.test(message);
}

/** Keyless MPEG fallback so calls still have voice when Orpheus TPD is exhausted. */
async function fallbackMpegTts(text) {
  const chunks = chunkSpeakText(text, 180);
  const buffers = [];
  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(chunk)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Accept: '*/*',
        Referer: 'https://translate.google.com/',
      },
    });
    if (!r.ok) {
      throw new Error(`Fallback TTS failed (${r.status})`);
    }
    buffers.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(buffers);
}

app.post('/api/speak', requireGroq, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const cleaned = cleanSpeakText(text);
  if (!cleaned) {
    return res.status(400).json({ error: 'text is empty after cleanup' });
  }

  const sendAudio = (buffer, contentType, via) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Engine', via);
    res.send(buffer);
  };

  try {
    const chunks = chunkSpeakText(cleaned, ORPHEUS_CHUNK);
    const wavs = [];

    for (const chunk of chunks) {
      try {
        const response = await req.groq.audio.speech.create({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: chunk,
          response_format: 'wav',
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length) wavs.push(buffer);
      } catch (chunkErr) {
        if (isRateLimited(chunkErr)) {
          console.warn('Orpheus rate-limited — using fallback TTS for full text');
          // Never return a partial Orpheus concat mid-sentence; synthesize the whole reply
          const mpeg = await fallbackMpegTts(cleaned);
          return sendAudio(mpeg, 'audio/mpeg', 'fallback');
        }
        throw chunkErr;
      }
    }

    if (!wavs.length) {
      const mpeg = await fallbackMpegTts(cleaned);
      return sendAudio(mpeg, 'audio/mpeg', 'fallback');
    }

    return sendAudio(concatWavBuffers(wavs), 'audio/wav', 'orpheus');
  } catch (err) {
    console.error('speak error:', err);
    try {
      const mpeg = await fallbackMpegTts(cleaned);
      console.warn('Orpheus failed — served fallback TTS');
      return sendAudio(mpeg, 'audio/mpeg', 'fallback');
    } catch (fbErr) {
      console.error('fallback TTS error:', fbErr);
      const message = err?.message || 'TTS failed';
      const code = err?.error?.error?.code || err?.code || 'tts_failed';
      const statusNum = err?.status || err?.statusCode || err?.error?.status;
      let status = 500;
      if (message.includes('terms acceptance') || code === 'model_terms_required') status = 403;
      else if (isRateLimited(err)) status = 429;
      else if (statusNum >= 400 && statusNum < 600) status = statusNum;
      res.status(status).json({
        error: message,
        code: status === 403 ? 'model_terms_required' : code,
        acceptTermsUrl:
          'https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english',
      });
    }
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
