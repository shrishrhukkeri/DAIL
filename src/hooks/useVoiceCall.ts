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
const VAD_INTERVAL_MS = 40;
/** Ignore mic for a moment after we start listening so TTS echo doesn't get captured. */
const LISTEN_GRACE_MS = 350;
const MIN_AUDIO_BYTES = 200;
const NOISE_FLOOR_MAX = 0.04;
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
/** First spoken sentence min length before early TTS pipeline kicks in */
const EARLY_TTS_MIN_CHARS = 12;

function getAudioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function isSafariBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
  return isIOS || isSafari;
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  // Safari/iOS: webm unsupported — prefer mp4 first. Chrome prefers webm/opus.
  const candidates = isSafariBrowser()
    ? ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function streamIsLive(stream: MediaStream | null) {
  return Boolean(stream?.getAudioTracks().some((t) => t.readyState === 'live'));
}

/** MediaRecorder containers need their first cluster/init segment — never drop leading chunks. */
function looksLikeMediaContainer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const u8 = new Uint8Array(buf.slice(0, 12));
  // EBML / WebM
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return true;
  // RIFF / WAV
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return true;
  // ISO BMFF (mp4/m4a) — "ftyp" at offset 4
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
  // Ogg
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return true;
  // Raw ADTS AAC (sync word 0xFFF1 / 0xFFF9 …)
  if (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0) return true;
  return false;
}

/** Split on sentence end; skip common abbreviations so early TTS is not stuck on "Dr." */
function takeEarlySentence(buf: string, minChars: number): { sentence: string; rest: string } | null {
  const re = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buf)) !== null) {
    const end = match.index + 1;
    const sentence = buf.slice(0, end).trim();
    if (sentence.length < minChars) continue;
    // Reject abbreviation-like endings: single capital letter before the period (Dr./Mr./Ms./St.)
    if (/[A-Z]\.$/.test(sentence) && sentence.length < minChars + 8) continue;
    // Also skip e.g. / i.e. style
    if (/\b(e\.g|i\.e|vs|etc)\.$/i.test(sentence) && !/[!?]/.test(sentence)) continue;
    const rest = buf.slice(end).replace(/^\s+/, '');
    return { sentence, rest };
  }
  return null;
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

export function useVoiceCall(options: UseVoiceCallOptions = {}) {
  const onFatalError = options.onFatalError;
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
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef('');
  const finalizeLockRef = useRef(false);
  /** Monotonic session id — ignores stale async work from a previous call/turn. */
  const sessionRef = useRef(0);
  /**
   * One voice per call. Orpheus WAV and Google MPEG fallback sound different —
   * never mix them (or browser speech) after the first successful utterance.
   */
  const ttsEngineRef = useRef<'unset' | 'orpheus' | 'fallback' | 'browser'>('unset');
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
    }
  }, []);

  /** Keep one HTMLAudioElement in the DOM — iOS unlock does not transfer to a new Audio(). */
  const ensurePlaybackAudio = useCallback(() => {
    let el = htmlAudioRef.current;
    if (!el) {
      el = document.createElement('audio');
      el.preload = 'auto';
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      htmlAudioRef.current = el;
    }
    return el;
  }, []);

  /** Near-silent looping audio keeps Safari's media unlock alive across awaits/timeouts. */
  const startSilentKeepAlive = useCallback(() => {
    const audio = ensurePlaybackAudio();
    if (htmlAudioUrlRef.current) {
      URL.revokeObjectURL(htmlAudioUrlRef.current);
      htmlAudioUrlRef.current = null;
    }
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.loop = true;
      audio.muted = false;
      audio.volume = 0.001;
      if (!audio.src.includes('data:audio/wav')) {
        audio.src = SILENT_WAV;
      }
      void audio.play().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, [ensurePlaybackAudio]);

  const stopHtmlAudio = useCallback(
    (opts?: { preserveUnlock?: boolean }) => {
      const el = htmlAudioRef.current;
      if (htmlAudioUrlRef.current) {
        URL.revokeObjectURL(htmlAudioUrlRef.current);
        htmlAudioUrlRef.current = null;
      }
      if (!el) return;
      try {
        el.onended = null;
        el.onerror = null;
        if (opts?.preserveUnlock) {
          startSilentKeepAlive();
          return;
        }
        el.loop = false;
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* ignore */
      }
    },
    [startSilentKeepAlive],
  );

  const stopPlayback = useCallback(
    (opts?: { preserveUnlock?: boolean }) => {
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
      stopHtmlAudio({ preserveUnlock: opts?.preserveUnlock ?? true });
      playingRef.current = false;
      if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) {
        window.speechSynthesis.cancel();
      }
    },
    [stopHtmlAudio],
  );

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

    // Keep looping silent media on the SAME element used for TTS (Safari unlock retention).
    // No 20Hz oscillator — it locks mobile audio routing and leaves the tab "playing" forever.
    stopKeepAlive();
    startSilentKeepAlive();

    // Warm speechSynthesis without cancel-after-speak (corrupts WebKit TTS queue)
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        const warmUtter = new SpeechSynthesisUtterance('');
        warmUtter.volume = 0;
        window.speechSynthesis.speak(warmUtter);
      } catch {
        /* ignore */
      }
    }
  }, [startSilentKeepAlive, stopKeepAlive]);

  const stopRecorderAsync = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;

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
    if (busyRef.current || playingRef.current) return;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') return;

    // Ensure previous recorder fully stopped (Chrome rejects overlapping recorders)
    await stopRecorderAsync();
    if (!activeRef.current || !mediaStreamRef.current || busyRef.current || playingRef.current) return;

    mediaStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !mutedRef.current;
    });

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
    // Keep every chunk — shifting idle chunks strips the WebM/MP4 init segment and
    // Groq rejects the blob as invalid_media_file.
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
    stopPlayback({ preserveUnlock: false });
    stopKeepAlive();
    // Keep playback context alive (suspended) so the next dial can resume under a gesture
    if (playbackCtxRef.current && playbackCtxRef.current.state !== 'closed') {
      void playbackCtxRef.current.suspend().catch(() => undefined);
    }
    messagesRef.current = [];
    ttsEngineRef.current = 'unset';
    browserVoiceRef.current = null;
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

  /** Mic stays off while AI replies so speaker echo cannot re-trigger listening. */
  const setMicCapture = useCallback((armed: boolean) => {
    mediaStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = armed && !mutedRef.current;
    });
  }, []);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    const ctx = playbackCtxRef.current;
    if (!next || !ctx || ctx.state === 'closed') {
      // Do NOT start the recorder here — turn orchestration resumes listening
      // only after the full assistant reply finishes.
      return;
    }

    playingRef.current = true;
    setPhaseSafe('speaking');
    setMicCapture(false);

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
  }, [setMicCapture, setPhaseSafe]);

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
      new Promise<void>((resolve, reject) => {
        if (!window.speechSynthesis || session !== sessionRef.current) {
          resolve();
          return;
        }

        // Strip Orpheus-style [direction] tags so fallback voice stays consistent
        const clean = text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!clean) {
          resolve();
          return;
        }
        const utter = new SpeechSynthesisUtterance(clean);
        utter.rate = 1.02;
        utter.pitch = 1;
        utter.lang = 'en-US';
        const voice = pickBrowserVoice();
        if (voice) utter.voice = voice;

        let done = false;
        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          playingRef.current = false;
          if (err) reject(err);
          else resolve();
        };

        const onAbort = () => {
          window.speechSynthesis.cancel();
          finish();
        };

        signal.addEventListener('abort', onAbort);
        utter.onend = () => finish();
        utter.onerror = (ev) => {
          const code = (ev as SpeechSynthesisErrorEvent).error;
          if (signal.aborted || code === 'interrupted' || code === 'canceled') {
            finish();
            return;
          }
          finish(new Error('speechSynthesis failed'));
        };

        playingRef.current = true;
        setMicCapture(false);
        setPhaseSafe('speaking');
        window.speechSynthesis.speak(utter);
      }),
    [pickBrowserVoice, setMicCapture, setPhaseSafe],
  );

  const playViaWebAudio = useCallback(
    async (blob: Blob, signal: AbortSignal, session: number) => {
      let ctx = playbackCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new (getAudioContextCtor())();
        playbackCtxRef.current = ctx;
      }
      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running') {
        throw new Error('AudioContext not running');
      }
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
      if (signal.aborted || session !== sessionRef.current) {
        throw new Error('aborted');
      }
      // Push first, then call playNext WHILE playingRef is still false.
      // playNext itself sets playingRef=true; setting it earlier deadlocks
      // (playNext early-returns and the wait loop never resolves).
      audioQueueRef.current.push(audioBuf);
      setMicCapture(false);
      setPhaseSafe('speaking');
      playNextRef.current();
      const startedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const wait = () => {
          if (signal.aborted || session !== sessionRef.current) {
            reject(new Error('aborted'));
            return;
          }
          // Safety: never hang forever if playNext failed to start
          if (Date.now() - startedAt > 15000) {
            playingRef.current = false;
            audioQueueRef.current = [];
            reject(new Error('Web Audio playback timeout'));
            return;
          }
          if (!playingRef.current && audioQueueRef.current.length === 0) {
            resolve();
            return;
          }
          // If queue still has audio but nothing is playing, kick playNext again
          if (!playingRef.current && audioQueueRef.current.length > 0) {
            playNextRef.current();
          }
          setTimeout(wait, 40);
        };
        wait();
      });
    },
    [setMicCapture, setPhaseSafe],
  );

  /** Prefer unlocked HTMLAudio (silent keep-alive); Web Audio as fallback. */
  const playGroqWav = useCallback(
    async (blob: Blob, signal: AbortSignal, session: number) => {
      if (signal.aborted || !activeRef.current || session !== sessionRef.current) {
        throw new Error('aborted');
      }
      if (!blob.size) throw new Error('Empty TTS audio');

      const tryHtml = () =>
        new Promise<void>((resolve, reject) => {
          if (htmlAudioUrlRef.current) {
            URL.revokeObjectURL(htmlAudioUrlRef.current);
            htmlAudioUrlRef.current = null;
          }
          const url = URL.createObjectURL(blob);
          htmlAudioUrlRef.current = url;
          const audio = ensurePlaybackAudio();
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            playingRef.current = false;
            try {
              audio.onended = null;
              audio.onerror = null;
            } catch {
              /* ignore */
            }
            if (htmlAudioUrlRef.current) {
              URL.revokeObjectURL(htmlAudioUrlRef.current);
              htmlAudioUrlRef.current = null;
            }
            // Restore silent loop so the next turn stays unlocked on Safari
            startSilentKeepAlive();
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
          audio.loop = false;
          audio.muted = false;
          audio.volume = 1;
          audio.onended = () => finish();
          audio.onerror = () => finish(new Error('HTMLAudio playback failed'));

          const startPlay = () => {
            playingRef.current = true;
            setMicCapture(false);
            setPhaseSafe('speaking');
            void audio.play().then(() => undefined).catch((err) => finish(err instanceof Error ? err : new Error('play blocked')));
          };

          audio.src = url;
          if (audio.readyState >= 3) {
            startPlay();
          } else {
            let started = false;
            const onReady = () => {
              if (started) return;
              started = true;
              audio.removeEventListener('canplaythrough', onReady);
              audio.removeEventListener('canplay', onReady);
              startPlay();
            };
            audio.addEventListener('canplaythrough', onReady);
            audio.addEventListener('canplay', onReady);
            // Safari sometimes never fires canplaythrough for blob URLs
            setTimeout(onReady, 250);
            audio.load();
          }
        });

      // HTMLAudio first (same element primed in dial gesture) — works on Safari + Chrome
      try {
        await tryHtml();
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.message === 'aborted')) throw err;
        console.warn('HTMLAudio play failed, trying Web Audio', err);
        await playViaWebAudio(blob, signal, session);
        startSilentKeepAlive();
      }
    },
    [ensurePlaybackAudio, playViaWebAudio, setMicCapture, setPhaseSafe, startSilentKeepAlive],
  );

  const fetchGroqSpeech = useCallback(async (text: string, signal: AbortSignal) => {
    let lastErr: unknown;
    const locked = ttsEngineRef.current;
    const preferEngine =
      locked === 'fallback' ? 'fallback' : locked === 'orpheus' ? 'orpheus' : undefined;
    // Production Cloudflare sometimes resets /api/speak — retry a few times
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const res = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.slice(0, 2000),
            ...(preferEngine ? { preferEngine } : {}),
          }),
          signal,
        });
        // 503 orpheus_rate_limited is intentional when locked — do not retry into a voice flip
        if (res.ok || res.status < 500 || (preferEngine === 'orpheus' && res.status === 503)) {
          return res;
        }
        lastErr = new Error(`TTS HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw err;
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    if (lastErr) throw lastErr;
    throw new Error('TTS fetch failed');
  }, []);

  const lockTtsEngine = useCallback((engine: 'orpheus' | 'fallback' | 'browser') => {
    if (ttsEngineRef.current === 'unset') {
      ttsEngineRef.current = engine;
    }
  }, []);

  /**
   * One voice per call. First successful utterance locks the engine for the rest
   * of the call (new calls may pick a different engine).
   */
  const speakFullReply = useCallback(
    async (text: string, signal: AbortSignal, session: number) => {
      const trimmed = text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!trimmed || signal.aborted || session !== sessionRef.current) return;

      const speakBrowserLocked = async () => {
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
        ttsEngineRef.current = 'browser';
      };

      if (ttsEngineRef.current === 'browser') {
        try {
          await speakBrowserLocked();
        } catch (err) {
          if (signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Voice playback failed';
          setError(message);
          onFatalError?.(message);
        }
        return;
      }

      let playedOk = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted || session !== sessionRef.current) return;
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 400));
          }
          const res = await fetchGroqSpeech(trimmed, signal);
          if (res.ok) {
            const engineHeader = (res.headers.get('X-TTS-Engine') || 'orpheus').toLowerCase();
            const engine: 'orpheus' | 'fallback' =
              engineHeader === 'fallback' ? 'fallback' : 'orpheus';

            // Already locked to a different server engine — reject and retry / fall through
            if (ttsEngineRef.current === 'orpheus' && engine === 'fallback') {
              continue;
            }
            if (ttsEngineRef.current === 'fallback' && engine === 'orpheus') {
              continue;
            }

            const blob = await res.blob();
            if (!blob.size) {
              console.warn('TTS returned empty audio');
              if (attempt === 0) continue;
              break;
            }
            try {
              await playGroqWav(blob, signal, session);
              lockTtsEngine(engine);
              playedOk = true;
              return;
            } catch (playErr) {
              if (signal.aborted || (playErr instanceof Error && playErr.message === 'aborted')) {
                return;
              }
              console.warn('TTS audio play failed:', playErr);
              if (attempt === 0) continue;
              break;
            }
          }
          const errBody = await res.json().catch(() => ({}));
          console.warn('TTS failed:', errBody.error || res.status);
          // Locked Orpheus exhausted — do not flip to Google mid-call; use browser once
          if (ttsEngineRef.current === 'orpheus') break;
          if (attempt === 0 && res.status >= 500) continue;
          break;
        } catch (err) {
          if (signal.aborted) return;
          console.warn('Groq TTS error:', err);
          if (attempt === 0) continue;
          break;
        }
      }

      if (playedOk || signal.aborted || session !== sessionRef.current) return;

      // Last resort: lock browser voice for the rest of this call (no more flips)
      try {
        setError('Using device voice for the rest of this call');
        await speakBrowserLocked();
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Voice playback failed';
        setError(message);
        onFatalError?.(message);
      }
    },
    [fetchGroqSpeech, lockTtsEngine, onFatalError, pickBrowserVoice, playGroqWav, speakWithBrowser],
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
      stopPlayback({ preserveUnlock: true });
      busyRef.current = true;
      setMicCapture(false);
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
        // Pipeline: speak first sentence ASAP; prefetch remaining TTS while it plays
        let earlySpoken = '';
        let remainder = '';
        let earlySpeakPromise: Promise<void> | null = null;
        let streamBuf = '';

        const full = await streamChat(
          messagesRef.current,
          controller.signal,
          (token) => {
            if (earlySpoken) {
              remainder += token;
              return;
            }
            streamBuf += token;
            const early = takeEarlySentence(streamBuf, EARLY_TTS_MIN_CHARS);
            if (early) {
              earlySpoken = early.sentence;
              remainder = early.rest;
              streamBuf = '';
              setPhaseSafe(userText ? 'speaking' : 'greeting');
              earlySpeakPromise = speakFullReply(earlySpoken, controller.signal, session);
            }
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

        // Keep busy=true through TTS — always go through speakFullReply so voice lock holds
        if (earlySpeakPromise) {
          const rest =
            (remainder + streamBuf).trim() ||
            (full ? full.slice(earlySpoken.length).trim() : '');
          await earlySpeakPromise;
          if (rest && session === sessionRef.current && activeRef.current && !controller.signal.aborted) {
            await speakFullReply(rest, controller.signal, session);
          }
        } else if (full) {
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
          setMicCapture(true);
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
        setMicCapture(true);
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
      setMicCapture,
      setPhaseSafe,
      speakFullReply,
      startRecorder,
      stopPlayback,
      stopRecorderAsync,
      waitForPlaybackIdle,
    ],
  );

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

    const headerBuf = await blob.slice(0, 16).arrayBuffer();
    if (!looksLikeMediaContainer(headerBuf)) {
      console.warn('Discarding utterance — not a valid media container', blob.type, blob.size);
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
      const isMp4 = /mp4|m4a|aac|mpeg/i.test(blob.type);
      const ext = isMp4 ? 'm4a' : 'webm';
      const mime = blob.type || (isMp4 ? 'audio/mp4' : 'audio/webm');
      form.append('audio', new File([blob], `utterance.${ext}`, { type: mime }));
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

  const onVadTick = useCallback(() => {
    if (!activeRef.current || mutedRef.current) return;

    const rms = getRms();
    const now = Date.now();
    const currentPhase = phaseRef.current;

    // Adaptive noise floor while idle-listening (hard upper clamp)
    if (currentPhase === 'listening' && !capturingRef.current && !busyRef.current) {
      noiseFloorRef.current = Math.min(
        NOISE_FLOOR_MAX,
        noiseFloorRef.current * 0.95 + rms * 0.05,
      );
    }
    const threshold = Math.max(SPEECH_THRESHOLD_MIN, noiseFloorRef.current * 3.2);
    const loud = rms >= threshold;

    // While AI is talking / thinking: never listen (speaker echo must not re-arm VAD)
    if (
      playingRef.current ||
      busyRef.current ||
      currentPhase === 'speaking' ||
      currentPhase === 'greeting' ||
      currentPhase === 'thinking'
    ) {
      return;
    }

    if (currentPhase !== 'listening' || busyRef.current || finalizeLockRef.current) return;
    if (now < listenArmedAtRef.current) return;
    // Guard: never arm capture while assistant audio is still draining
    if (playingRef.current) return;

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
  }, [getRms, startRecorder]);

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
    // Preserve Safari HTMLAudio unlock — do not tear down the silent keep-alive loop
    stopPlayback({ preserveUnlock: true });
    messagesRef.current = [];
    ttsEngineRef.current = 'unset';
    browserVoiceRef.current = null;
    mutedRef.current = false;
    setMuted(false);
    setError(null);

    if (session !== sessionRef.current) return;

    activeRef.current = true;
    // May be outside gesture — only resumes if already unlocked during dial tap
    unlockAudio();
    if (playbackCtxRef.current?.state === 'suspended') {
      void playbackCtxRef.current.resume();
    }
    startSilentKeepAlive();

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
    startSilentKeepAlive,
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
    playNextRef.current = playNext;
  }, [playNext]);

  useEffect(() => {
    runAssistantTurnRef.current = runAssistantTurn;
  }, [runAssistantTurn]);

  useEffect(() => {
    finalizeSpeechRef.current = finalizeSpeech;
  }, [finalizeSpeech]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      activeRef.current = false;
      void tearDownMic();
      stopPlayback({ preserveUnlock: false });
      try {
        htmlAudioRef.current?.remove();
      } catch {
        /* ignore */
      }
      htmlAudioRef.current = null;
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
