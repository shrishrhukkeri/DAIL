import { useCallback, useRef } from 'react';

const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
};

export const useAudio = () => {
  const audioCtx = useRef<AudioContext | null>(null);
  const currentAudio = useRef<HTMLAudioElement | null>(null);

  const initAudio = () => {
    if (!audioCtx.current) {
      audioCtx.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.current.state === 'suspended') {
      audioCtx.current.resume();
    }
  };

  const playDTMF = useCallback((key: string) => {
    initAudio();
    if (!audioCtx.current || !DTMF_FREQS[key]) return;

    const [f1, f2] = DTMF_FREQS[key];
    const osc1 = audioCtx.current.createOscillator();
    const osc2 = audioCtx.current.createOscillator();
    const gainNode = audioCtx.current.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(f1, audioCtx.current.currentTime);
    osc2.frequency.setValueAtTime(f2, audioCtx.current.currentTime);

    gainNode.gain.setValueAtTime(0.1, audioCtx.current.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.current.currentTime + 0.5);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioCtx.current.destination);

    osc1.start();
    osc2.start();
    osc1.stop(audioCtx.current.currentTime + 0.5);
    osc2.stop(audioCtx.current.currentTime + 0.5);
  }, []);

  const playBusyTone = useCallback(() => {
    initAudio();
    if (!audioCtx.current) return;

    const playPulse = (startTime: number) => {
      const osc = audioCtx.current!.createOscillator();
      const gain = audioCtx.current!.createGain();
      osc.frequency.setValueAtTime(480, startTime);
      gain.gain.setValueAtTime(0.1, startTime);
      gain.gain.setValueAtTime(0.1, startTime + 0.4);
      gain.gain.setValueAtTime(0, startTime + 0.5);
      osc.connect(gain);
      gain.connect(audioCtx.current!.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.5);
    };

    const now = audioCtx.current.currentTime;
    for (let i = 0; i < 5; i++) {
      playPulse(now + i * 1.0);
    }
  }, []);

  const playRingtone = useCallback(() => {
    initAudio();
    if (!audioCtx.current) return;
    
    const playRing = (startTime: number) => {
        const osc1 = audioCtx.current!.createOscillator();
        const osc2 = audioCtx.current!.createOscillator();
        const gain = audioCtx.current!.createGain();
        
        osc1.frequency.setValueAtTime(440, startTime);
        osc2.frequency.setValueAtTime(480, startTime);
        
        gain.gain.setValueAtTime(0.05, startTime);
        gain.gain.linearRampToValueAtTime(0.05, startTime + 2);
        gain.gain.linearRampToValueAtTime(0, startTime + 2.1);
        
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.current!.destination);
        
        osc1.start(startTime);
        osc2.start(startTime);
        osc1.stop(startTime + 2.1);
        osc2.stop(startTime + 2.1);
    }

    const now = audioCtx.current.currentTime;
    playRing(now);
  }, []);

  const playEndBeep = useCallback(() => {
    // Replace synthesized beep with hangup.mp3
    const audio = new Audio('/hangup.mp3');
    audio.play();
  }, []);

  const playVoiceClue = useCallback((onEnded?: () => void) => {
    if (currentAudio.current) {
        currentAudio.current.pause();
        currentAudio.current = null;
    }

    const audio = new Audio('/rightcall.mp3');
    currentAudio.current = audio;
    if (onEnded) {
        audio.onended = onEnded;
    }
    audio.play();
  }, []);

  const playFailureMessage = useCallback((onEnded?: () => void) => {
    if (currentAudio.current) {
        currentAudio.current.pause();
        currentAudio.current = null;
    }

    const audio = new Audio('/wrongnumber.mp3');
    currentAudio.current = audio;
    if (onEnded) {
        audio.onended = onEnded;
    }
    audio.play();
  }, []);

  const stopAllAudio = useCallback(() => {
    if (currentAudio.current) {
        currentAudio.current.pause();
        currentAudio.current = null;
    }
    window.speechSynthesis.cancel();
  }, []);

  return { playDTMF, playBusyTone, playRingtone, playVoiceClue, playFailureMessage, stopAllAudio, playEndBeep };
};
