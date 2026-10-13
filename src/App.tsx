import { useState, useCallback, useRef, useEffect } from 'react';
import { Phone } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { Keypad } from './components/Keypad';
import { PhoneDisplay } from './components/PhoneDisplay';
import { CallScreen } from './components/CallScreen';
import { useAudio } from './hooks/useAudio';
import { useVoiceCall } from './hooks/useVoiceCall';

const AI_NUMBER = '1400';

function App() {
  const [number, setNumber] = useState('');
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected' | 'failed'>('idle');
  const { playDTMF, playRingtone, playFailureMessage, stopAllAudio, playEndBeep } = useAudio();
  const {
    phase,
    error,
    muted,
    unlockAudio,
    prepareMic,
    releaseMic,
    startCall,
    hangup,
    toggleMute,
  } = useVoiceCall();

  const dialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialTokenRef = useRef(0);
  const numberRef = useRef(number);

  const clearDialTimer = useCallback(() => {
    if (dialTimerRef.current) {
      clearTimeout(dialTimerRef.current);
      dialTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    numberRef.current = number;
  }, [number]);

  useEffect(() => () => clearDialTimer(), [clearDialTimer]);

  const handleKeyPress = useCallback((key: string) => {
    if (number.length < 15) {
      setNumber((prev) => prev + key);
      playDTMF(key);
    }
  }, [number, playDTMF]);

  const handleDelete = useCallback(() => {
    setNumber((prev) => prev.slice(0, -1));
  }, []);

  const handleAutoEnd = useCallback(() => {
    setTimeout(() => {
      setCallStatus('idle');
      playEndBeep();
      stopAllAudio();
    }, 400);
  }, [playEndBeep, stopAllAudio]);

  const startDial = async () => {
    if (!numberRef.current) return;

    clearDialTimer();
    const token = ++dialTokenRef.current;

    // Safari/iOS: unlock AudioContext + HTMLAudio SYNCHRONOUSLY before any await
    // (await getUserMedia / permission sheet breaks the user-gesture chain)
    unlockAudio();

    // Mic still needs to open during this tap; unlock already happened above
    try {
      await prepareMic();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access denied';
      setCallStatus('idle');
      window.alert(`Microphone required for the call.\n\n${message}`);
      return;
    }

    if (token !== dialTokenRef.current) {
      releaseMic();
      return;
    }

    setCallStatus('calling');
    playRingtone();

    dialTimerRef.current = setTimeout(() => {
      dialTimerRef.current = null;
      if (token !== dialTokenRef.current) return;

      if (numberRef.current === AI_NUMBER) {
        stopAllAudio();
        setCallStatus('connected');
        void startCall();
      } else {
        releaseMic();
        setCallStatus('failed');
        playFailureMessage(handleAutoEnd);
      }
    }, 1200);
  };

  const endCall = () => {
    dialTokenRef.current += 1;
    clearDialTimer();
    hangup();
    stopAllAudio();
    setCallStatus('idle');
    playEndBeep();
  };

  return (
    <div className="phone-container">
      <AnimatePresence>
        {callStatus !== 'idle' && (
          <CallScreen
            number={number}
            status={callStatus === 'connected' ? 'connected' : 'calling'}
            voicePhase={phase}
            voiceError={error}
            muted={muted}
            onEndCall={endCall}
            onToggleMute={toggleMute}
            onUnlockAudio={unlockAudio}
          />
        )}
      </AnimatePresence>

      <PhoneDisplay number={number} onDelete={handleDelete} />

      <div style={{ width: '100%', maxWidth: '320px' }}>
        <Keypad onKeyPress={handleKeyPress} />

        <div className="call-button-container">
          <button className="call-button" onClick={() => void startDial()} type="button" aria-label="Call">
            <Phone size={32} fill="white" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
