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

const SPEECH_THRESHOLD = 0.018;
const SILENCE_MS = 550;
const MIN_SPEECH_MS = 280;
const BARGE_IN_MS = 180;
const VAD_INTERVAL_MS = 40;

function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  const pattern = /[.!?]+(?:\s+|$)/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = pattern.exec(buffer)) !== null) {
    const end = match.index + match[0].length;
    const sentence = buffer.slice(lastIndex, end).trim();
    if (sentence) complete.push(sentence);
    lastIndex = end;
  }

  return { complete, rest: buffer.slice(lastIndex) };
}

function getAudioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
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
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(false);
  const activeRef = useRef(false);
  const speakChainRef = useRef<Promise<void>>(Promise.resolve());
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

  const runAssistantTurnRef = useRef<(userText?: string) => Promise<void>>(async () => undefined);
  const finalizeSpeechRef = useRef<() => Promise<void>>(async () => undefined);
  const playNextRef = useRef<() => void>(() => undefined);

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const resetSpeakChain = useCallback(() => {
    speakChainRef.current = Promise.resolve();
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
    playingRef.current = false;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  /** Must run inside the dial button click (user gesture). */
  const unlockAudio = useCallback(() => {
    const AC = getAudioContextCtor();
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AC();
    }
    const ctx = playbackCtxRef.current;
    void ctx.resume();

    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    try {
      source.start(0);
    } catch {
      /* ignore */
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.cancel();
    }
  }, []);

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
        resolve(out.size > 800 ? out : null);
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
    // Keep AudioContext alive (suspended) so the next dial can resume it under a gesture
    if (playbackCtxRef.current && playbackCtxRef.current.state !== 'closed') {
      void playbackCtxRef.current.suspend().catch(() => undefined);
    }
    messagesRef.current = [];
    resetSpeakChain();
    mutedRef.current = false;
    setMuted(false);
    setPhaseSafe('idle');
    setError(null);
  }, [resetSpeakChain, setPhaseSafe, stopPlayback, tearDownMic]);

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
    void ctx.resume();

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
  }, [setPhaseSafe, startRecorder]);

  playNextRef.current = playNext;

  const speakWithBrowser = useCallback(
    (text: string, signal: AbortSignal, session: number) =>
      new Promise<void>((resolve) => {
        if (!window.speechSynthesis || session !== sessionRef.current) {
          resolve();
          return;
        }

        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.pitch = 1;
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
    [setPhaseSafe],
  );

  const enqueueSpeech = useCallback(
    (text: string, signal: AbortSignal, session: number) => {
      const trimmed = text.trim();
      if (!trimmed || signal.aborted || session !== sessionRef.current) return;

      speakChainRef.current = speakChainRef.current
        .catch(() => undefined)
        .then(async () => {
          if (signal.aborted || !activeRef.current || session !== sessionRef.current) return;

          const res = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: trimmed }),
            signal,
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            console.warn('Groq TTS unavailable, using browser voice:', errBody.error || res.status);
            await speakWithBrowser(trimmed, signal, session);
            return;
          }

          const blob = await res.blob();
          if (signal.aborted || !activeRef.current || session !== sessionRef.current) return;

          let ctx = playbackCtxRef.current;
          if (!ctx || ctx.state === 'closed') {
            ctx = new (getAudioContextCtor())();
            playbackCtxRef.current = ctx;
          }
          await ctx.resume();
          const arrayBuf = await blob.arrayBuffer();
          const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
          if (signal.aborted || !activeRef.current || session !== sessionRef.current) return;
          audioQueueRef.current.push(audioBuf);
          playNextRef.current();
        })
        .catch((err) => {
          if (signal.aborted || session !== sessionRef.current) return;
          console.error(err);
        });
    },
    [speakWithBrowser],
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
      resetSpeakChain();
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

      let sentenceBuffer = '';
      try {
        const full = await streamChat(
          messagesRef.current,
          controller.signal,
          (token) => {
            if (session !== sessionRef.current) return;
            sentenceBuffer += token;
            const { complete, rest } = splitSentences(sentenceBuffer);
            sentenceBuffer = rest;
            for (const sentence of complete) {
              enqueueSpeech(sentence, controller.signal, session);
            }
          },
        );

        if (session !== sessionRef.current || !activeRef.current) return;

        if (sentenceBuffer.trim()) {
          enqueueSpeech(sentenceBuffer, controller.signal, session);
        }

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

        busyRef.current = false;
        await speakChainRef.current.catch(() => undefined);
        await waitForPlaybackIdle(session, controller.signal);

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
      enqueueSpeech,
      resetSpeakChain,
      setPhaseSafe,
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
      await startRecorder();
      finalizeLockRef.current = false;
      return;
    }

    const blob = await stopRecorderAsync();
    if (session !== sessionRef.current || !activeRef.current) {
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

      if (session !== sessionRef.current || !activeRef.current) return;

      if (!cleaned || cleaned.length < 2) {
        busyRef.current = false;
        finalizeLockRef.current = false;
        await startRecorder();
        setPhaseSafe('listening');
        return;
      }

      finalizeLockRef.current = false;
      await runAssistantTurnRef.current(cleaned);
    } catch (err) {
      if (controller.signal.aborted || !activeRef.current || session !== sessionRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Transcription failed');
      busyRef.current = false;
      finalizeLockRef.current = false;
      await startRecorder();
      setPhaseSafe('listening');
    }
  }, [setPhaseSafe, startRecorder, stopRecorderAsync]);

  finalizeSpeechRef.current = finalizeSpeech;

  const onVadTick = useCallback(() => {
    if (!activeRef.current || mutedRef.current) return;

    const rms = getRms();
    const loud = rms >= SPEECH_THRESHOLD;
    const now = Date.now();
    const currentPhase = phaseRef.current;
    const aiAudible =
      playingRef.current || currentPhase === 'speaking' || currentPhase === 'greeting';

    if (aiAudible && !busyRef.current) {
      if (loud) {
        if (!bargeStartedAtRef.current) bargeStartedAtRef.current = now;
        if (now - (bargeStartedAtRef.current || now) >= BARGE_IN_MS) {
          abortRef.current?.abort();
          stopPlayback();
          resetSpeakChain();
          busyRef.current = false;
          finalizeLockRef.current = false;
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

    if (currentPhase !== 'listening' || busyRef.current || finalizeLockRef.current) return;

    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      void startRecorder();
    }

    if (loud) {
      silenceStartedAtRef.current = null;
      if (!capturingRef.current) {
        capturingRef.current = true;
        speechStartedAtRef.current = now;
      }
      return;
    }

    if (capturingRef.current) {
      if (!silenceStartedAtRef.current) silenceStartedAtRef.current = now;
      if (now - silenceStartedAtRef.current >= SILENCE_MS) {
        void finalizeSpeechRef.current();
      }
    }
  }, [getRms, resetSpeakChain, setPhaseSafe, startRecorder, stopPlayback, stopRecorderAsync]);

  const startVadLoop = useCallback(() => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    vadTimerRef.current = setInterval(onVadTick, VAD_INTERVAL_MS);
  }, [onVadTick]);

  const openMic = useCallback(async () => {
    // Always refresh mic for a new call — stale stopped tracks break listening
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    micSourceRef.current = null;
    analyserRef.current = null;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStreamRef.current = stream;
    mimeTypeRef.current = pickMimeType();

    const AC = getAudioContextCtor();
    let ctx = playbackCtxRef.current;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AC();
      playbackCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    micSourceRef.current = source;
    analyserRef.current = analyser;
  }, []);

  const startCall = useCallback(async () => {
    const session = ++sessionRef.current;

    activeRef.current = false;
    busyRef.current = false;
    finalizeLockRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    await tearDownMic();
    stopPlayback();
    messagesRef.current = [];
    resetSpeakChain();
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
      await openMic();
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
    openMic,
    resetSpeakChain,
    setPhaseSafe,
    startVadLoop,
    stopPlayback,
    tearDownMic,
    unlockAudio,
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
    };
  }, [stopPlayback, tearDownMic]);

  return {
    phase,
    error,
    muted,
    unlockAudio,
    startCall,
    hangup,
    toggleMute,
  };
}
