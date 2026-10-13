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
  /** Safari: tap speaker to re-unlock AudioContext / HTMLAudio mid-call */
  onUnlockAudio?: () => void;
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
  onUnlockAudio,
}) => {
  const [timer, setTimer] = useState(0);
  const [soundArmed, setSoundArmed] = useState(false);
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
        {status === 'connected' && !soundArmed && (
          <p style={{ color: 'rgba(52, 199, 89, 0.9)', fontSize: 13, marginTop: 10 }}>
            No sound? Tap speaker once
          </p>
        )}
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
        {(
          [
            {
              icon: muted ? MicOff : Mic,
              label: muted ? 'unmute' : 'mute',
              action: 'mute' as const,
            },
            { icon: GripVertical, label: 'keypad', action: 'none' as const },
            { icon: Volume2, label: soundArmed ? 'sound on' : 'speaker', action: 'speaker' as const },
            { icon: Plus, label: 'add call', action: 'none' as const },
            { icon: Video, label: 'FaceTime', action: 'none' as const },
            { icon: User, label: 'contacts', action: 'none' as const },
          ]
        ).map((item, idx) => {
          const interactive = item.action === 'mute' || item.action === 'speaker';
          const Icon = item.icon;
          return (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <button
                type="button"
                disabled={!interactive || status !== 'connected'}
                onClick={() => {
                  if (item.action === 'mute') onToggleMute?.();
                  if (item.action === 'speaker') {
                    onUnlockAudio?.();
                    setSoundArmed(true);
                  }
                }}
                style={{
                  width: '50px',
                  height: '50px',
                  borderRadius: '50%',
                  background:
                    (item.action === 'mute' && muted) || (item.action === 'speaker' && soundArmed)
                      ? 'rgba(52, 199, 89, 0.35)'
                      : 'rgba(255,255,255,0.1)',
                  border:
                    item.action === 'mute' && muted
                      ? '1px solid #ff3b30'
                      : item.action === 'speaker' && soundArmed
                        ? '1px solid #34c759'
                        : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '8px',
                  color: 'white',
                  cursor: interactive && status === 'connected' ? 'pointer' : 'default',
                  opacity: !interactive ? 0.55 : 1,
                }}
                aria-label={
                  item.action === 'mute'
                    ? muted
                      ? 'Unmute'
                      : 'Mute'
                    : item.action === 'speaker'
                      ? 'Enable sound'
                      : item.label
                }
              >
                <Icon size={24} />
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
