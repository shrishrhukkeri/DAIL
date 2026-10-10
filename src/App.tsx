import { useState, useCallback } from 'react';
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
  const { phase, error, muted, unlockAudio, startCall, hangup, toggleMute } = useVoiceCall();

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

  const startDial = () => {
    if (!number) return;

    // Must run in the click handler — unlocks autoplay for async TTS on Render/mobile
    unlockAudio();

    setCallStatus('calling');
    playRingtone();

    setTimeout(() => {
      if (number === AI_NUMBER) {
        setCallStatus('connected');
        void startCall();
      } else {
        setCallStatus('failed');
        playFailureMessage(handleAutoEnd);
      }
    }, 1200);
  };

  const endCall = () => {
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
          />
        )}
      </AnimatePresence>

      <PhoneDisplay number={number} onDelete={handleDelete} />

      <div style={{ width: '100%', maxWidth: '320px' }}>
        <Keypad onKeyPress={handleKeyPress} />

        <div className="call-button-container">
          <button className="call-button" onClick={startDial} type="button" aria-label="Call">
            <Phone size={32} fill="white" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
