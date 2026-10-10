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

/** RMS above this counts as speech (echoCancellation keeps TTS quieter). */
const SPEECH_THRESHOLD = 0.018;
/** Wait after you stop talking before sending the turn. */
const SILENCE_MS = 550;
/** Ignore blips shorter than this. */
const MIN_SPEECH_MS = 280;
/** Speech while AI is talking interrupts playback. */
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

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

export function useVoiceCall(options: UseVoiceCallOptions = {}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  /** Mic analysis context (may share playback ctx). */
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** Kept alive across the ringtone delay so TTS isn't blocked by autoplay. */
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(false);
  const activeRef = useRef(false);
  const speakChainRef = useRef<Promise<void>>(Promise.resolve());
  const phaseRef = useRef<VoicePhase>('idle');
  const mutedRef = useRef(false);
  /** True only while STT/LLM request is in flight (not during TTS playback). */
  const busyRef = useRef(false);
  const capturingRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const bargeStartedAtRef = useRef<number | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef('');
  const finalizeLockRef = useRef(false);

  const runAssistantTurnRef = useRef<(userText?: string) => Promise<void>>(async () => undefined);
  const finalizeSpeechRef = useRef<() => Promise<void>>(async () => undefined);

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
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

  /** Call from the dial button click (user gesture) before any setTimeout. */
  const unlockAudio = useCallback(() => {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AC();
    }
    const ctx = playbackCtxRef.current;
    void ctx.resume();

    // Silent buffer "primes" autoplay so later async TTS can play
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    try {
      source.start(0);
    } catch {
      /* ignore */
    }

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      // Some browsers need speak() once under a gesture
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.cancel();
    }
  }, []);

  const stopRecorderOnly = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    chunksRef.current = [];
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    bargeStartedAtRef.current = null;
  }, []);

  const tearDownMic = useCallback(() => {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    stopRecorderOnly();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    analyserRef.current = null;
    // Don't close playbackCtxRef here — it must stay unlocked for TTS
    if (audioCtxRef.current && audioCtxRef.current !== playbackCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
    }
    audioCtxRef.current = null;
  }, [stopRecorderOnly]);

  const hangup = useCallback(() => {
    activeRef.current = false;
    busyRef.current = false;
    finalizeLockRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    tearDownMic();
    stopPlayback();
    if (playbackCtxRef.current) {
      void playbackCtxRef.current.close().catch(() => undefined);
      playbackCtxRef.current = null;
    }
    messagesRef.current = [];
    speakChainRef.current = Promise.resolve();
    mutedRef.current = false;
    setMuted(false);
    setPhaseSafe('idle');
    setError(null);
  }, [setPhaseSafe, stopPlayback, tearDownMic]);

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

  const startRecorder = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream || !activeRef.current || mutedRef.current) return;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') return;

    chunksRef.current = [];
    const mimeType = mimeTypeRef.current;
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start(100);
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
  }, []);

  const stopRecorderToBlob = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      chunksRef.current = [];
      return null;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeTypeRef.current || 'audio/webm';
        const out = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        resolve(out.size > 800 ? out : null);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

    mediaRecorderRef.current = null;
    capturingRef.current = false;
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    return blob;
  }, []);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    const ctx = playbackCtxRef.current;
    if (!next || !ctx) {
      if (activeRef.current && !busyRef.current && phaseRef.current === 'speaking') {
        startRecorder();
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

    const finish = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
      playingRef.current = false;
      playNext();
    };
    source.onended = finish;
    try {
      source.start(0);
    } catch {
      finish();
    }
  }, [setPhaseSafe, startRecorder]);

  const speakWithBrowser = useCallback(
    (text: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (!window.speechSynthesis) {
          resolve();
          return;
        }

        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.pitch = 1;

        const finish = () => {
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
    (text: string, signal: AbortSignal) => {
      const trimmed = text.trim();
      if (!trimmed || signal.aborted) return;

      speakChainRef.current = speakChainRef.current
        .then(async () => {
          if (signal.aborted || !activeRef.current) return;
          const res = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: trimmed }),
            signal,
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            // Orpheus requires one-time terms acceptance — fall back so the call still talks
            console.warn('Groq TTS unavailable, using browser voice:', errBody.error || res.status);
            if (errBody.code === 'model_terms_required') {
              setError('Accept Orpheus terms in Groq console for higher-quality voice (using browser TTS for now)');
            }
            await speakWithBrowser(trimmed, signal);
            if (
              activeRef.current &&
              !signal.aborted &&
              !busyRef.current &&
              audioQueueRef.current.length === 0
            ) {
              startRecorder();
              setPhaseSafe('listening');
            }
            return;
          }

          const blob = await res.blob();
          if (signal.aborted || !activeRef.current) return;

          const ctx = playbackCtxRef.current;
          if (!ctx) {
            console.warn('Playback AudioContext missing — call unlockAudio() on dial');
            return;
          }
          await ctx.resume();
          const arrayBuf = await blob.arrayBuffer();
          const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
          if (signal.aborted || !activeRef.current) return;
          audioQueueRef.current.push(audioBuf);
          playNext();
        })
        .catch((err) => {
          if (signal.aborted) return;
          console.error(err);
        });
    },
    [playNext, setPhaseSafe, speakWithBrowser, startRecorder],
  );

  const runAssistantTurn = useCallback(
    async (userText?: string) => {
      if (!activeRef.current) return;

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      stopPlayback();
      speakChainRef.current = Promise.resolve();
      busyRef.current = true;
      stopRecorderOnly();

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
            sentenceBuffer += token;
            const { complete, rest } = splitSentences(sentenceBuffer);
            sentenceBuffer = rest;
            for (const sentence of complete) {
              enqueueSpeech(sentence, controller.signal);
            }
          },
        );

        if (sentenceBuffer.trim()) {
          enqueueSpeech(sentenceBuffer, controller.signal);
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

        // LLM done — allow barge-in while audio plays
        busyRef.current = false;
        await speakChainRef.current;

        await new Promise<void>((resolve) => {
          const check = () => {
            if (
              !activeRef.current ||
              controller.signal.aborted ||
              (!playingRef.current && audioQueueRef.current.length === 0)
            ) {
              resolve();
              return;
            }
            setTimeout(check, 50);
          };
          check();
        });

        if (activeRef.current && !controller.signal.aborted && !mutedRef.current) {
          startRecorder();
          setPhaseSafe('listening');
        }
      } catch (err) {
        busyRef.current = false;
        if (controller.signal.aborted || !activeRef.current) return;
        const message = err instanceof Error ? err.message : 'Call failed';
        setError(message);
        options.onFatalError?.(message);
        if (activeRef.current) {
          startRecorder();
          setPhaseSafe('listening');
        }
      }
    },
    [enqueueSpeech, options, setPhaseSafe, startRecorder, stopPlayback, stopRecorderOnly],
  );

  runAssistantTurnRef.current = runAssistantTurn;

  const finalizeSpeech = useCallback(async () => {
    if (!activeRef.current || busyRef.current || mutedRef.current || finalizeLockRef.current) return;
    finalizeLockRef.current = true;

    const started = speechStartedAtRef.current;
    if (!started || Date.now() - started < MIN_SPEECH_MS) {
      stopRecorderOnly();
      startRecorder();
      finalizeLockRef.current = false;
      return;
    }

    const blob = await stopRecorderToBlob();
    if (!blob) {
      startRecorder();
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
      finalizeLockRef.current = false;
      if (!cleaned || cleaned.length < 2) {
        busyRef.current = false;
        if (activeRef.current) {
          startRecorder();
          setPhaseSafe('listening');
        }
        return;
      }
      await runAssistantTurnRef.current(cleaned);
    } catch (err) {
      finalizeLockRef.current = false;
      busyRef.current = false;
      if (controller.signal.aborted || !activeRef.current) return;
      setError(err instanceof Error ? err.message : 'Transcription failed');
      startRecorder();
      setPhaseSafe('listening');
    }
  }, [setPhaseSafe, startRecorder, stopRecorderOnly, stopRecorderToBlob]);

  finalizeSpeechRef.current = finalizeSpeech;

  const onVadTick = useCallback(() => {
    if (!activeRef.current || mutedRef.current) return;

    const rms = getRms();
    const loud = rms >= SPEECH_THRESHOLD;
    const now = Date.now();
    const currentPhase = phaseRef.current;
    const aiAudible =
      playingRef.current || currentPhase === 'speaking' || currentPhase === 'greeting';

    // Interrupt AI when user starts talking
    if (aiAudible && !busyRef.current) {
      if (loud) {
        if (!bargeStartedAtRef.current) bargeStartedAtRef.current = now;
        if (now - (bargeStartedAtRef.current || now) >= BARGE_IN_MS) {
          abortRef.current?.abort();
          stopPlayback();
          speakChainRef.current = Promise.resolve();
          busyRef.current = false;
          finalizeLockRef.current = false;
          stopRecorderOnly();
          startRecorder();
          capturingRef.current = true;
          speechStartedAtRef.current = now;
          silenceStartedAtRef.current = null;
          bargeStartedAtRef.current = null;
          setPhaseSafe('listening');
        }
      } else {
        bargeStartedAtRef.current = null;
      }
      return;
    }

    if (currentPhase !== 'listening' || busyRef.current || finalizeLockRef.current) return;

    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      startRecorder();
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
  }, [getRms, setPhaseSafe, startRecorder, stopPlayback, stopRecorderOnly]);

  const startVadLoop = useCallback(() => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    vadTimerRef.current = setInterval(onVadTick, VAD_INTERVAL_MS);
  }, [onVadTick]);

  const openMic = useCallback(async () => {
    if (mediaStreamRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStreamRef.current = stream;
    mimeTypeRef.current = pickMimeType();

    // Reuse unlocked playback context when possible (avoids iOS autoplay lock)
    const ctx =
      playbackCtxRef.current && playbackCtxRef.current.state !== 'closed'
        ? playbackCtxRef.current
        : new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    playbackCtxRef.current = ctx;
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    analyserRef.current = analyser;
  }, []);

  const startCall = useCallback(async () => {
    // Soft reset — keep unlocked playback AudioContext
    activeRef.current = false;
    busyRef.current = false;
    finalizeLockRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    tearDownMic();
    stopPlayback();
    messagesRef.current = [];
    speakChainRef.current = Promise.resolve();
    mutedRef.current = false;
    setMuted(false);
    setError(null);

    activeRef.current = true;
    if (playbackCtxRef.current?.state === 'suspended') {
      await playbackCtxRef.current.resume();
    }

    try {
      await openMic();
      startVadLoop();
      await runAssistantTurnRef.current();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access denied';
      setError(message);
      setPhaseSafe('error');
    }
  }, [openMic, setPhaseSafe, startVadLoop, stopPlayback, tearDownMic]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    mediaStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    if (next) {
      stopRecorderOnly();
    } else if (activeRef.current && !busyRef.current && phaseRef.current === 'listening') {
      startRecorder();
    }
  }, [startRecorder, stopRecorderOnly]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      tearDownMic();
      stopPlayback();
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
