import React from 'react';

interface KeypadProps {
  onKeyPress: (key: string) => void;
}

const KEYS = [
  { num: '1', letters: '' },
  { num: '2', letters: 'ABC' },
  { num: '3', letters: 'DEF' },
  { num: '4', letters: 'GHI' },
  { num: '5', letters: 'JKL' },
  { num: '6', letters: 'MNO' },
  { num: '7', letters: 'PQRS' },
  { num: '8', letters: 'TUV' },
  { num: '9', letters: 'WXYZ' },
  { num: '*', letters: '' },
  { num: '0', letters: '+' },
  { num: '#', letters: '' },
];

export const Keypad: React.FC<KeypadProps> = ({ onKeyPress }) => {
  return (
    <div className="keypad-grid">
      {KEYS.map((key) => (
        <button
          key={key.num}
          className="key-button"
          onClick={() => onKeyPress(key.num)}
        >
          <span className="key-number">{key.num}</span>
          {key.letters && <span className="key-letters">{key.letters}</span>}
        </button>
      ))}
    </div>
  );
};
