#!/usr/bin/env node
/**
 * End-to-end API + static smoke for Caller.
 * Usage: node scripts/smoke-e2e.mjs [baseUrl]
 * Default baseUrl: https://call.run.place
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const BASE = (process.argv[2] || 'https://call.run.place').replace(/\/$/, '');

const results = [];

function record(name, ok, detail = '', severity = ok ? 'pass' : 'fail') {
  results.push({ name, ok, detail: String(detail).slice(0, 500), severity });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchRetry(url, opts = {}, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 90000) });
      return res;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

async function testHealth() {
  try {
    const res = await fetchRetry(`${BASE}/health`, { timeoutMs: 20000 });
    const body = await res.json();
    record('GET /health', res.ok && body.ok === true, `http=${res.status} status=${body.status}`);
  } catch (e) {
    record('GET /health', false, e.message);
  }
}

async function testStatic() {
  for (const p of ['/', '/hangup.mp3', '/wrongnumber.mp3', '/favicon.svg']) {
    try {
      const res = await fetchRetry(`${BASE}${p}`, { method: 'GET', timeoutMs: 30000 });
      const ok = res.ok && Number(res.headers.get('content-length') || 1) > 0;
      record(`GET ${p}`, ok, `http=${res.status} type=${res.headers.get('content-type')}`);
    } catch (e) {
      record(`GET ${p}`, false, e.message);
    }
  }
}

async function testChat() {
  try {
    const res = await fetchRetry(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Reply with exactly: Hello caller.' }],
      }),
      timeoutMs: 90000,
    });
    const text = await res.text();
    const hasToken = text.includes('"token"');
    const hasDone = text.includes('[DONE]');
    record('POST /api/chat SSE', res.ok && hasToken && hasDone, `http=${res.status} bytes=${text.length}`);
  } catch (e) {
    record('POST /api/chat SSE', false, e.message);
  }
}

async function testSpeak() {
  let okCount = 0;
  let failCount = 0;
  let engine = '';
  let lastType = '';
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetchRetry(
        `${BASE}/api/speak`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Hi, thanks for calling. How can I help?' }),
          timeoutMs: 120000,
        },
        2,
      );
      const buf = Buffer.from(await res.arrayBuffer());
      const isWav = buf[0] === 0x52 && buf[1] === 0x49;
      const isMpeg = buf[0] === 0xff || buf.slice(0, 3).toString() === 'ID3';
      const good = res.ok && buf.length > 1000 && (isWav || isMpeg);
      if (good) {
        okCount++;
        engine = res.headers.get('x-tts-engine') || engine;
        lastType = res.headers.get('content-type') || lastType;
      } else failCount++;
    } catch {
      failCount++;
    }
  }
  const ok = okCount >= 3;
  record(
    'POST /api/speak reliability (5 tries)',
    ok,
    `ok=${okCount} fail=${failCount} engine=${engine || '?'} type=${lastType || '?'}`,
    ok ? 'pass' : okCount > 0 ? 'warn' : 'fail',
  );
}

async function testTranscribe() {
  const wavPath = '/tmp/smoke_tone.wav';
  if (!fs.existsSync(wavPath)) {
    record('POST /api/transcribe', false, 'missing /tmp/smoke_tone.wav');
    return;
  }
  try {
    const blob = new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' });
    const form = new FormData();
    form.append('audio', blob, 'smoke.wav');
    const res = await fetchRetry(`${BASE}/api/transcribe`, {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
    });
    const body = await res.json().catch(() => ({}));
    // Tone may yield empty text — acceptance is HTTP 200 without invalid_media_file
    const ok = res.ok && body.code !== 'invalid_media_file';
    record(
      'POST /api/transcribe WAV',
      ok,
      `http=${res.status} text=${JSON.stringify(body.text || body.error || '').slice(0, 80)}`,
    );
  } catch (e) {
    record('POST /api/transcribe WAV', false, e.message);
  }
}

async function testClientBundle() {
  try {
    const html = await (await fetchRetry(BASE + '/', { timeoutMs: 30000 })).text();
    const m = html.match(/\/assets\/(index-[^"]+\.js)/);
    if (!m) {
      record('Client bundle present', false, 'no asset script in index.html');
      return;
    }
    const jsUrl = `${BASE}/assets/${m[1]}`;
    const res = await fetchRetry(jsUrl, { timeoutMs: 60000 });
    const js = await res.text();
    const checks = [
      ['voice pipeline symbols', /getUserMedia|MediaRecorder|createObjectURL|speechSynthesis/.test(js)],
      ['dial number 1400', /1400/.test(js)],
      ['audio element / playsinline', /playsinline|playsInline|webkit-playsinline/i.test(js)],
    ];
    for (const [name, pass] of checks) {
      record(`Bundle: ${name}`, pass, m[1]);
    }
  } catch (e) {
    record('Client bundle present', false, e.message);
  }
}

async function testLocalSourceGuards() {
  const voice = fs.readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
  record(
    'Source: no playingRef=true before playNext in playViaWebAudio',
    !/audioQueueRef\.current\.push\(audioBuf\);\s*playingRef\.current = true/.test(voice),
  );
  record('Source: ADTS AAC accepted', /0xff.*0xf0/.test(voice));
  record('Source: mic off while speaking (setMicCapture)', /setMicCapture\(false\)/.test(voice));
  record('Source: TTS speak retry/prefetch', /restPrefetch|attempt < 3/.test(voice));
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  record(
    'Source: SSE watches res.close only (not req.close/destroyed)',
    /res\.on\('close'/.test(server) && !/req\.on\('close'/.test(server),
  );
  record('Source: no partial WAV on 429 mid-chunk', /full fallback|fallbackMpegTts\(cleaned\)/.test(server));
}

async function main() {
  console.log(`Smoke base: ${BASE}\n`);
  await testLocalSourceGuards();
  await testHealth();
  await testStatic();
  await testChat();
  await testSpeak();
  await testTranscribe();
  await testClientBundle();

  const fail = results.filter((r) => !r.ok);
  const warn = results.filter((r) => r.severity === 'warn');
  console.log('\n=== SUMMARY ===');
  console.log(`pass=${results.filter((r) => r.ok).length} fail=${fail.length} warn=${warn.length}`);
  const out = path.join(root, 'smoke-results.json');
  fs.writeFileSync(out, JSON.stringify({ base: BASE, ts: new Date().toISOString(), results }, null, 2));
  console.log(`Wrote ${out}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
