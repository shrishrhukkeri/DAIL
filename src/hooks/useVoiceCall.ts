import { useCallback, useEffect, useRef, useState } from 'react';

export type VoicePhase =
  | 'idle'
  | 'greeting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

type UseVoiceCallOptions = {
  onFatalError?: (message: string) => void;
};

const SPEECH_THRESHOLD_MIN = 0.012;
const SILENCE_MS = 700;
const MIN_SPEECH_MS = 250;
const MAX_SPEECH_MS = 12000;
const BARGE_IN_MS = 180;
const VAD_INTERVAL_MS = 40;
/** Ignore mic for a moment after we start listening so TTS echo doesn't get captured. */
const LISTEN_GRACE_MS = 350;
const MIN_AUDIO_BYTES = 200;

function getAudioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  // Safari: webm often unsupported — prefer mp4 there. Chrome prefers webm/opus.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function streamIsLive(stream: MediaStream | null) {
  return Boolean(stream?.getAudioTracks().some((t) => t.readyState === 'live'));
}

async function streamChat(
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<string> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Chat failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let carry = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });

    const parts = carry.split('\n\n');
    carry = parts.pop() || '';

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.token) {
          full += parsed.token;
          onToken(parsed.token);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  return full.trim();
}

export function useVoiceCall(_options: UseVoiceCallOptions = {}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  /** TTS / unlock AudioContext — never share with mic (Safari mutes page mic otherwise). */
  const playbackCtxRef = useRef<AudioContext | null>(null);
  /** Keeps playbackCtx running between dial gesture and delayed TTS (iOS suspends idle contexts). */
  const keepAliveOscRef = useRef<OscillatorNode | null>(null);
  const keepAliveGainRef = useRef<GainNode | null>(null);
  /** HTMLAudioElement path — reliable for Groq WAV on Safari. */
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const htmlAudioUrlRef = useRef<string | null>(null);
  /** VAD / analyser only — not connected to destination. */
  const micCtxRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(false);
  const activeRef = useRef(false);
  const phaseRef = useRef<VoicePhase>('idle');
  const mutedRef = useRef(false);
  const busyRef = useRef(false);
  const capturingRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const bargeStartedAtRef = useRef<number | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef('');
  const finalizeLockRef = useRef(false);
  /** Monotonic session id — ignores stale async work from a previous call/turn. */
  const sessionRef = useRef(0);
  /** Stick to one TTS engine per call so the voice doesn't flip mid-conversation. */
  const ttsModeRef = useRef<'unset' | 'groq' | 'browser'>('unset');
  const browserVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const noiseFloorRef = useRef(0.005);
  const listenArmedAtRef = useRef(0);

  const runAssistantTurnRef = useRef<(userText?: string) => Promise<void>>(async () => undefined);
  const finalizeSpeechRef = useRef<() => Promise<void>>(async () => undefined);
  const playNextRef = useRef<() => void>(() => undefined);

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
    if (next === 'listening') {
      listenArmedAtRef.current = Date.now() + LISTEN_GRACE_MS;
      capturingRef.current = false;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      bargeStartedAtRef.current = null;
    }
  }, []);

  const stopHtmlAudio = useCallback(() => {
    const el = htmlAudioRef.current;
    htmlAudioRef.current = null;
    if (el) {
      try {
        el.onended = null;
        el.onerror = null;
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* ignore */
      }
    }
    if (htmlAudioUrlRef.current) {
      URL.revokeObjectURL(htmlAudioUrlRef.current);
      htmlAudioUrlRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* ignore */
      }
    });
    activeSourcesRef.current = [];
    audioQueueRef.current = [];
    stopHtmlAudio();
    playingRef.current = false;
    if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) {
      window.speechSynthesis.cancel();
    }
  }, [stopHtmlAudio]);

  const stopKeepAlive = useCallback(() => {
    try {
      keepAliveOscRef.current?.stop();
    } catch {
      /* ignore */
    }
    try {
      keepAliveOscRef.current?.disconnect();
      keepAliveGainRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    keepAliveOscRef.current = null;
    keepAliveGainRef.current = null;
  }, []);

  /** Must run inside the dial button click (user gesture). */
  const unlockAudio = useCallback(() => {
    const AC = getAudioContextCtor();
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AC();
    }
    const ctx = playbackCtxRef.current;
    void ctx.resume();

    // Inaudible keep-alive so iOS does not suspend the context before greeting TTS
    stopKeepAlive();
    try {
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      const osc = ctx.createOscillator();
      osc.frequency.value = 20;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
      keepAliveOscRef.current = osc;
      keepAliveGainRef.current = gain;
    } catch {
      /* ignore */
    }

    // Also unlock HTMLMediaElement playback (Safari)
    try {
      const warm = new Audio(
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=',
      );
      warm.volume = 0.01;
      void warm.play().then(() => warm.pause()).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, [stopKeepAlive]);

  const stopRecorderAsync = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    bargeStartedAtRef.current = null;

    if (!recorder) {
      chunksRef.current = [];
      return null;
    }

    if (recorder.state === 'inactive') {
      const type = recorder.mimeType || mimeTypeRef.current || 'audio/webm';
      const leftover = chunksRef.current;
      chunksRef.current = [];
      return leftover.length ? new Blob(leftover, { type }) : null;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      const finish = () => {
        const type = recorder.mimeType || mimeTypeRef.current || 'audio/webm';
        const out = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        resolve(out.size > MIN_AUDIO_BYTES ? out : null);
      };
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = finish;
      try {
        recorder.requestData?.();
        recorder.stop();
      } catch {
        chunksRef.current = [];
        resolve(null);
      }
    });

    return blob;
  }, []);

  const startRecorder = useCallback(async () => {
    const stream = mediaStreamRef.current;
    if (!stream || !activeRef.current || mutedRef.current) return;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') return;

    // Ensure previous recorder fully stopped (Chrome rejects overlapping recorders)
    await stopRecorderAsync();
    if (!activeRef.current || !mediaStreamRef.current) return;

    chunksRef.current = [];
    const mimeType = mimeTypeRef.current;
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      console.error('MediaRecorder create failed', err);
      return;
    }

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    try {
      recorder.start(100);
    } catch (err) {
      console.error('MediaRecorder start failed', err);
      mediaRecorderRef.current = null;
      return;
    }
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
  }, [stopRecorderAsync]);

  const tearDownMic = useCallback(async () => {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    await stopRecorderAsync();
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    micSourceRef.current = null;
    analyserRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    if (micCtxRef.current && micCtxRef.current.state !== 'closed') {
      void micCtxRef.current.close().catch(() => undefined);
      micCtxRef.current = null;
    }
  }, [stopRecorderAsync]);

  const hangup = useCallback(() => {
    sessionRef.current += 1;
    activeRef.current = false;
    busyRef.current = false;
    finalizeLockRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    void tearDownMic();
    stopPlayback();
    stopKeepAlive();
    // Keep playback context alive (suspended) so the next dial can resume under a gesture
    if (playbackCtxRef.current && playbackCtxRef.current.state !== 'closed') {
      void playbackCtxRef.current.suspend().catch(() => undefined);
    }
    messagesRef.current = [];
    ttsModeRef.current = 'unset';
    mutedRef.current = false;
    setMuted(false);
    setPhaseSafe('idle');
    setError(null);
  }, [setPhaseSafe, stopKeepAlive, stopPlayback, tearDownMic]);

  const getRms = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }, []);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    const ctx = playbackCtxRef.current;
    if (!next || !ctx || ctx.state === 'closed') {
      if (activeRef.current && !busyRef.current && phaseRef.current === 'speaking') {
        void startRecorder();
        setPhaseSafe('listening');
      }
      return;
    }

    playingRef.current = true;
    setPhaseSafe('speaking');

    const startSource = () => {
      const source = ctx.createBufferSource();
      source.buffer = next;
      source.connect(ctx.destination);
      activeSourcesRef.current.push(source);

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
        playingRef.current = false;
        playNextRef.current();
      };
      source.onended = finish;
      try {
        source.start(0);
      } catch {
        finish();
      }
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(startSource).catch(() => {
        playingRef.current = false;
        playNextRef.current();
      });
    } else {
      startSource();
    }
  }, [setPhaseSafe, startRecorder]);

  playNextRef.current = playNext;

  const pickBrowserVoice = useCallback(() => {
    if (browserVoiceRef.current) return browserVoiceRef.current;
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const preferred =
      voices.find((v) => /en(-|_)US/i.test(v.lang) && /Samantha|Alex|Daniel|David|Fred|Google US English/i.test(v.name)) ||
      voices.find((v) => /en(-|_)US/i.test(v.lang)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      voices[0];
    browserVoiceRef.current = preferred;
    return preferred;
  }, []);

  const speakWithBrowser = useCallback(
    (text: string, signal: AbortSignal, session: number) =>
      new Promise<void>((resolve) => {
        if (!window.speechSynthesis || session !== sessionRef.current) {
          resolve();
          return;
        }

        // Strip Orpheus-style [direction] tags so fallback voice stays consistent
        const clean = text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
        const utter = new SpeechSynthesisUtterance(clean);
        utter.rate = 1.02;
        utter.pitch = 1;
        utter.lang = 'en-US';
        const voice = pickBrowserVoice();
        if (voice) utter.voice = voice;

        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          playingRef.current = false;
          resolve();
        };

        const onAbort = () => {
          window.speechSynthesis.cancel();
          finish();
        };

        signal.addEventListener('abort', onAbort);
        utter.onend = finish;
        utter.onerror = finish;

        playingRef.current = true;
        setPhaseSafe('speaking');
        window.speechSynthesis.speak(utter);
      }),
    [pickBrowserVoice, setPhaseSafe],
  );

  /** Prefer HTMLAudioElement — works after dial-gesture unlock on Safari where Web Audio stays silent. */
  const playGroqWav = useCallback(
    async (blob: Blob, signal: AbortSignal, session: number) => {
      if (signal.aborted || !activeRef.current || session !== sessionRef.current) {
        throw new Error('aborted');
      }
      if (!blob.size) throw new Error('Empty TTS audio');

      stopHtmlAudio();
      const url = URL.createObjectURL(blob);
      htmlAudioUrlRef.current = url;
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = url;
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('webkit-playsinline', 'true');
      htmlAudioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          playingRef.current = false;
          stopHtmlAudio();
          if (err) reject(err);
          else resolve();
        };
        const onAbort = () => {
          try {
            audio.pause();
          } catch {
            /* ignore */
          }
          finish(new Error('aborted'));
        };

        signal.addEventListener('abort', onAbort);
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('HTMLAudio playback failed'));

        playingRef.current = true;
        setPhaseSafe('speaking');
        void audio
          .play()
          .then(() => {
            // playing
          })
          .catch(async (err) => {
            // Fallback: Web Audio decode if element.play() blocked
            console.warn('HTMLAudio play blocked, trying Web Audio', err);
            try {
              let ctx = playbackCtxRef.current;
              if (!ctx || ctx.state === 'closed') {
                ctx = new (getAudioContextCtor())();
                playbackCtxRef.current = ctx;
              }
              if (ctx.state === 'suspended') await ctx.resume();
              const arrayBuf = await blob.arrayBuffer();
              const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
              if (signal.aborted || session !== sessionRef.current) {
                finish(new Error('aborted'));
                return;
              }
              stopHtmlAudio();
              audioQueueRef.current.push(audioBuf);
              playNextRef.current();
              const wait = () => {
                if (
                  signal.aborted ||
                  session !== sessionRef.current ||
                  (!playingRef.current && audioQueueRef.current.length === 0)
                ) {
                  finish(signal.aborted ? new Error('aborted') : undefined);
                  return;
                }
                setTimeout(wait, 40);
              };
              wait();
            } catch (fallbackErr) {
              finish(fallbackErr instanceof Error ? fallbackErr : new Error('playback failed'));
            }
          });
      });
    },
    [setPhaseSafe, stopHtmlAudio],
  );

  const fetchGroqSpeech = useCallback(async (text: string, signal: AbortSignal) => {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2000) }),
      signal,
    });
    return res;
  }, []);

  /**
   * One TTS request per assistant turn (Orpheus is ~10 RPM — sentence spam causes
   * mid-reply failures and a jarring switch to browser voice).
   */
  const speakFullReply = useCallback(
    async (text: string, signal: AbortSignal, session: number) => {
      const trimmed = text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!trimmed || signal.aborted || session !== sessionRef.current) return;

      if (ttsModeRef.current !== 'browser') {
        let lastStatus = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal.aborted || session !== sessionRef.current) return;
          try {
            if (attempt > 0) {
              await new Promise((r) => setTimeout(r, 800));
            }
            const res = await fetchGroqSpeech(trimmed, signal);
            lastStatus = res.status;
            if (res.ok) {
              const blob = await res.blob();
              try {
                await playGroqWav(blob, signal, session);
                ttsModeRef.current = 'groq';
                return;
              } catch (playErr) {
                if (signal.aborted || (playErr instanceof Error && playErr.message === 'aborted')) {
                  return;
                }
                console.warn('Groq audio play failed:', playErr);
                // Do not lock groq mode until playback actually worked
                if (attempt === 0) continue;
                break;
              }
            }
            const errBody = await res.json().catch(() => ({}));
            console.warn('Groq TTS failed:', errBody.error || res.status);
            // Retry once on rate limit / transient 5xx
            if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
            break;
          } catch (err) {
            if (signal.aborted) return;
            console.warn('Groq TTS error:', err);
            if (attempt === 0) continue;
            break;
          }
        }

        // Already used Orpheus successfully this call — never flip voice mid-conversation
        if (ttsModeRef.current === 'groq') {
          console.warn('Skipping browser fallback to keep voice consistent', lastStatus);
          return;
        }
        ttsModeRef.current = 'browser';
      }

      if (ttsModeRef.current === 'browser') {
        if (window.speechSynthesis && !window.speechSynthesis.getVoices().length) {
          await new Promise<void>((r) => {
            const done = () => {
              window.speechSynthesis.removeEventListener('voiceschanged', done);
              r();
            };
            window.speechSynthesis.addEventListener('voiceschanged', done);
            setTimeout(done, 300);
          });
        }
        pickBrowserVoice();
        await speakWithBrowser(trimmed, signal, session);
      }
    },
    [fetchGroqSpeech, pickBrowserVoice, playGroqWav, speakWithBrowser],
  );

  const waitForPlaybackIdle = useCallback(
    (session: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (
            session !== sessionRef.current ||
            !activeRef.current ||
            signal.aborted ||
            (!playingRef.current && audioQueueRef.current.length === 0)
          ) {
            resolve();
            return;
          }
          setTimeout(check, 40);
        };
        check();
      }),
    [],
  );

  const runAssistantTurn = useCallback(
    async (userText?: string) => {
      if (!activeRef.current) return;
      const session = sessionRef.current;

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      stopPlayback();
      busyRef.current = true;
      await stopRecorderAsync();

      if (session !== sessionRef.current || !activeRef.current) return;

      if (userText?.trim()) {
        messagesRef.current = [
          ...messagesRef.current,
          { role: 'user', content: userText.trim() },
        ];
      } else if (messagesRef.current.length === 0) {
        messagesRef.current = [
          {
            role: 'user',
            content: 'The caller just dialed in. Greet them briefly and ask how you can help.',
          },
        ];
      }

      setPhaseSafe(userText ? 'thinking' : 'greeting');
      setError(null);

      try {
        // Collect full reply first — one TTS call avoids Orpheus rate-limit voice flips
        const full = await streamChat(
          messagesRef.current,
          controller.signal,
          () => {
            /* tokens buffered until complete */
          },
        );

        if (session !== sessionRef.current || !activeRef.current) return;

        if (full) {
          if (!userText) {
            messagesRef.current = [{ role: 'assistant', content: full }];
          } else {
            messagesRef.current = [
              ...messagesRef.current,
              { role: 'assistant', content: full },
            ];
          }
        }

        // Keep busy=true through TTS so mic barge-in cannot abort the speak fetch
        if (full) {
          setPhaseSafe(userText ? 'speaking' : 'greeting');
          await speakFullReply(full, controller.signal, session);
        }
        await waitForPlaybackIdle(session, controller.signal);
        busyRef.current = false;

        if (
          session === sessionRef.current &&
          activeRef.current &&
          !controller.signal.aborted &&
          !mutedRef.current
        ) {
          await startRecorder();
          setPhaseSafe('listening');
        }
      } catch (err) {
        busyRef.current = false;
        if (controller.signal.aborted || !activeRef.current || session !== sessionRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Call failed';
        setError(message);
        await startRecorder();
        setPhaseSafe('listening');
      } finally {
        if (session === sessionRef.current) {
          busyRef.current = false;
          finalizeLockRef.current = false;
        }
      }
    },
    [
      setPhaseSafe,
      speakFullReply,
      startRecorder,
      stopPlayback,
      stopRecorderAsync,
      waitForPlaybackIdle,
    ],
  );

  runAssistantTurnRef.current = runAssistantTurn;

  const finalizeSpeech = useCallback(async () => {
    if (!activeRef.current || busyRef.current || mutedRef.current || finalizeLockRef.current) {
      return;
    }
    finalizeLockRef.current = true;
    const session = sessionRef.current;

    const started = speechStartedAtRef.current;
    if (!started || Date.now() - started < MIN_SPEECH_MS) {
      capturingRef.current = false;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      await startRecorder();
      finalizeLockRef.current = false;
      return;
    }

    const blob = await stopRecorderAsync();
    if (session !== sessionRef.current || !activeRef.current) {
      busyRef.current = false;
      finalizeLockRef.current = false;
      return;
    }

    if (!blob) {
      await startRecorder();
      setPhaseSafe('listening');
      finalizeLockRef.current = false;
      return;
    }

    busyRef.current = true;
    setPhaseSafe('thinking');

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      const form = new FormData();
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      form.append('audio', blob, `utterance.${ext}`);
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Transcription failed (${res.status})`);
      }
      const { text } = (await res.json()) as { text: string };
      const cleaned = (text || '').trim();

      if (session !== sessionRef.current || !activeRef.current) {
        busyRef.current = false;
        finalizeLockRef.current = false;
        return;
      }

      if (!cleaned || cleaned.length < 2) {
        setPhaseSafe('speaking');
        await speakFullReply(
          "Sorry, I didn't catch that. Please say it again.",
          controller.signal,
          session,
        );
        await waitForPlaybackIdle(session, controller.signal);
        busyRef.current = false;
        finalizeLockRef.current = false;
        if (session === sessionRef.current && activeRef.current) {
          await startRecorder();
          setPhaseSafe('listening');
        }
        return;
      }

      finalizeLockRef.current = false;
      await runAssistantTurnRef.current(cleaned);
    } catch (err) {
      busyRef.current = false;
      finalizeLockRef.current = false;
      if (controller.signal.aborted || !activeRef.current || session !== sessionRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Transcription failed');
      await startRecorder();
      setPhaseSafe('listening');
    }
  }, [setPhaseSafe, speakFullReply, startRecorder, stopRecorderAsync, waitForPlaybackIdle]);

  finalizeSpeechRef.current = finalizeSpeech;

  const onVadTick = useCallback(() => {
    if (!activeRef.current || mutedRef.current) return;

    const rms = getRms();
    const now = Date.now();
    const currentPhase = phaseRef.current;

    // Adaptive noise floor while idle-listening
    if (currentPhase === 'listening' && !capturingRef.current && !busyRef.current) {
      noiseFloorRef.current = noiseFloorRef.current * 0.95 + rms * 0.05;
    }
    const threshold = Math.max(SPEECH_THRESHOLD_MIN, noiseFloorRef.current * 3.2);
    const loud = rms >= threshold;

    // Only barge-in while audio is actually playing — not during chat/TTS fetch
    if (playingRef.current) {
      if (loud) {
        if (!bargeStartedAtRef.current) bargeStartedAtRef.current = now;
        if (now - (bargeStartedAtRef.current || now) >= BARGE_IN_MS) {
          abortRef.current?.abort();
          stopPlayback();
          busyRef.current = false;
          finalizeLockRef.current = false;
          playingRef.current = false;
          void (async () => {
            await stopRecorderAsync();
            if (!activeRef.current) return;
            await startRecorder();
            capturingRef.current = true;
            speechStartedAtRef.current = Date.now();
            silenceStartedAtRef.current = null;
            bargeStartedAtRef.current = null;
            setPhaseSafe('listening');
          })();
        }
      } else {
        bargeStartedAtRef.current = null;
      }
      return;
    }

    if (currentPhase === 'speaking' || currentPhase === 'greeting' || currentPhase === 'thinking') {
      return;
    }

    if (currentPhase !== 'listening' || busyRef.current || finalizeLockRef.current) return;
    if (now < listenArmedAtRef.current) return;

    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      void startRecorder();
    }

    if (loud) {
      silenceStartedAtRef.current = null;
      if (!capturingRef.current) {
        capturingRef.current = true;
        speechStartedAtRef.current = now;
      } else if (
        speechStartedAtRef.current &&
        now - speechStartedAtRef.current >= MAX_SPEECH_MS
      ) {
        void finalizeSpeechRef.current();
      }
      return;
    }

    if (capturingRef.current) {
      if (!silenceStartedAtRef.current) silenceStartedAtRef.current = now;
      const quietFor = now - silenceStartedAtRef.current;
      const spokenFor = speechStartedAtRef.current ? now - speechStartedAtRef.current : 0;
      if (quietFor >= SILENCE_MS && spokenFor >= MIN_SPEECH_MS) {
        void finalizeSpeechRef.current();
      }
    }
  }, [getRms, setPhaseSafe, startRecorder, stopPlayback, stopRecorderAsync]);

  const startVadLoop = useCallback(() => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    vadTimerRef.current = setInterval(onVadTick, VAD_INTERVAL_MS);
  }, [onVadTick]);

  const wireMicAnalyser = useCallback(async (stream: MediaStream) => {
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    micSourceRef.current = null;
    analyserRef.current = null;

    const AC = getAudioContextCtor();
    let ctx = micCtxRef.current;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AC();
      micCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') await ctx.resume();

    // Analyser only — never connect mic graph to destination (avoids Safari page-mute)
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    micSourceRef.current = source;
    analyserRef.current = analyser;
  }, []);

  /**
   * Safari requires getUserMedia during a user gesture.
   * Call this from the Call button click — before any setTimeout.
   */
  const prepareMic = useCallback(async () => {
    unlockAudio();

    // Reuse live tracks if still open (e.g. rapid redial)
    if (streamIsLive(mediaStreamRef.current)) {
      mediaStreamRef.current!.getAudioTracks().forEach((t) => {
        t.enabled = true;
      });
      await wireMicAnalyser(mediaStreamRef.current!);
      mimeTypeRef.current = pickMimeType();
      return;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Safari sometimes starts tracks muted — force enable
    stream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    mediaStreamRef.current = stream;
    mimeTypeRef.current = pickMimeType();
    await wireMicAnalyser(stream);
  }, [unlockAudio, wireMicAnalyser]);

  const releaseMic = useCallback(() => {
    void tearDownMic();
  }, [tearDownMic]);

  const startCall = useCallback(async () => {
    const session = ++sessionRef.current;

    activeRef.current = false;
    busyRef.current = false;
    finalizeLockRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    // Do NOT tearDownMic here — Safari mic was opened in prepareMic() under the dial tap
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    await stopRecorderAsync();
    stopPlayback();
    messagesRef.current = [];
    ttsModeRef.current = 'unset';
    mutedRef.current = false;
    setMuted(false);
    setError(null);

    if (session !== sessionRef.current) return;

    activeRef.current = true;
    unlockAudio();
    if (playbackCtxRef.current?.state === 'suspended') {
      await playbackCtxRef.current.resume();
    }

    try {
      if (!streamIsLive(mediaStreamRef.current)) {
        // Fallback (non-Safari) if prepareMic wasn't called
        await prepareMic();
      } else {
        mediaStreamRef.current!.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
        await wireMicAnalyser(mediaStreamRef.current!);
      }
      if (session !== sessionRef.current || !activeRef.current) return;
      startVadLoop();
      await runAssistantTurnRef.current();
    } catch (err) {
      if (session !== sessionRef.current) return;
      const message = err instanceof Error ? err.message : 'Microphone access denied';
      setError(message);
      setPhaseSafe('error');
      activeRef.current = false;
    }
  }, [
    prepareMic,
    setPhaseSafe,
    startVadLoop,
    stopPlayback,
    stopRecorderAsync,
    unlockAudio,
    wireMicAnalyser,
  ]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    mediaStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    if (next) {
      void stopRecorderAsync();
    } else if (activeRef.current && !busyRef.current && phaseRef.current === 'listening') {
      void startRecorder();
    }
  }, [startRecorder, stopRecorderAsync]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      activeRef.current = false;
      void tearDownMic();
      stopPlayback();
      if (playbackCtxRef.current && playbackCtxRef.current.state !== 'closed') {
        void playbackCtxRef.current.close().catch(() => undefined);
        playbackCtxRef.current = null;
      }
      if (micCtxRef.current && micCtxRef.current.state !== 'closed') {
        void micCtxRef.current.close().catch(() => undefined);
        micCtxRef.current = null;
      }
    };
  }, [stopPlayback, tearDownMic]);

  return {
    phase,
    error,
    muted,
    unlockAudio,
    prepareMic,
    releaseMic,
    startCall,
    hangup,
    toggleMute,
  };
}
