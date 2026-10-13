import React, { useEffect, useState } from 'react';
import { PhoneOff, Mic, MicOff, Video, Volume2, Plus, User, GripVertical } from 'lucide-react';
import { motion } from 'framer-motion';
import type { VoicePhase } from '../hooks/useVoiceCall';

interface CallScreenProps {
  number: string;
  status: 'calling' | 'connected' | 'ended';
  voicePhase?: VoicePhase;
  voiceError?: string | null;
  muted?: boolean;
  onEndCall: () => void;
  onToggleMute?: () => void;
}

function statusLabel(status: CallScreenProps['status'], phase?: VoicePhase, error?: string | null) {
  if (status !== 'connected') return 'calling...';
  if (error && phase === 'error') return 'error — keep talking';
  switch (phase) {
    case 'greeting':
      return 'connecting...';
    case 'listening':
      return 'listening — speak anytime';
    case 'thinking':
      return 'thinking...';
    case 'speaking':
      return 'speaking...';
    default:
      return 'connected';
  }
}

export const CallScreen: React.FC<CallScreenProps> = ({
  number,
  status,
  voicePhase = 'idle',
  voiceError,
  muted = false,
  onEndCall,
  onToggleMute,
}) => {
  const [timer, setTimer] = useState(0);
  const listening = voicePhase === 'listening' && !muted;

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (status === 'connected') {
      interval = setInterval(() => {
        setTimer((t) => t + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 100 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 100 }}
      className="glass-panel"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        backgroundColor: 'rgba(0,0,0,0.95)',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 'clamp(40px, 10vw, 60px)' }}>
        <div
          style={{
            width: 'clamp(80px, 20vw, 100px)',
            height: 'clamp(80px, 20vw, 100px)',
            borderRadius: '50%',
            background: '#333',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
            boxShadow: listening ? '0 0 0 3px rgba(52, 199, 89, 0.45)' : undefined,
          }}
        >
          <User size={50} color="#666" />
        </div>
        <h2 style={{ fontSize: 'clamp(24px, 6vw, 32px)', fontWeight: '400', marginBottom: '8px' }}>
          {status === 'connected' ? 'AI Line' : number}
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.6)' }}>
          {status === 'connected'
            ? `${formatTime(timer)} · ${muted ? 'muted' : statusLabel(status, voicePhase, voiceError)}`
            : 'calling...'}
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 'clamp(20px, 5vw, 30px)',
          marginBottom: 'clamp(40px, 10vw, 60px)',
          width: '100%',
          maxWidth: '280px',
        }}
      >
        {[
          {
            icon: muted ? MicOff : Mic,
            label: muted ? 'unmute' : 'mute',
            interactive: true,
          },
          { icon: GripVertical, label: 'keypad' },
          { icon: Volume2, label: 'speaker' },
          { icon: Plus, label: 'add call' },
          { icon: Video, label: 'FaceTime' },
          { icon: User, label: 'contacts' },
        ].map((item, idx) => {
          const isMic = Boolean(item.interactive);
          const MicIcon = item.icon;
          return (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <button
                type="button"
                disabled={!isMic || status !== 'connected'}
                onClick={() => {
                  if (isMic) onToggleMute?.();
                }}
                style={{
                  width: '50px',
                  height: '50px',
                  borderRadius: '50%',
                  background: isMic && muted ? 'rgba(255, 59, 48, 0.45)' : 'rgba(255,255,255,0.1)',
                  border: isMic && muted ? '1px solid #ff3b30' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '8px',
                  color: 'white',
                  cursor: isMic && status === 'connected' ? 'pointer' : 'default',
                  opacity: !isMic ? 0.55 : 1,
                }}
                aria-label={isMic ? (muted ? 'Unmute' : 'Mute') : item.label}
              >
                <MicIcon size={24} />
              </button>
              <span style={{ fontSize: '12px', opacity: 0.6 }}>{item.label}</span>
            </div>
          );
        })}
      </div>

      <button onClick={onEndCall} className="call-button end-call-button" type="button" aria-label="End call">
        <PhoneOff size={32} />
      </button>
    </motion.div>
  );
};
