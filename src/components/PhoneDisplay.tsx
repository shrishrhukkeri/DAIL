import React from 'react';
import { Delete } from 'lucide-react';

interface PhoneDisplayProps {
  number: string;
  onDelete: () => void;
}

export const PhoneDisplay: React.FC<PhoneDisplayProps> = ({ number, onDelete }) => {
  // Dynamic font size based on number length
  const getFontSize = () => {
    if (number.length > 10) return '28px';
    if (number.length > 7) return '36px';
    return '48px';
  };

  return (
    <div style={{ 
      height: '140px', 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center',
      marginBottom: '20px',
      position: 'relative',
      width: '100%'
    }}>
      <div style={{ 
        fontSize: getFontSize(), 
        fontWeight: '300', 
        letterSpacing: '1px',
        minHeight: '60px',
        textAlign: 'center',
        width: '100%',
        transition: 'all 0.1s ease'
      }}>
        {number}
      </div>
      {number.length > 0 && (
        <button 
          onClick={onDelete}
          style={{
            position: 'absolute',
            right: '10px',
            background: 'none',
            border: 'none',
            color: 'rgba(255, 255, 255, 0.5)',
            cursor: 'pointer'
          }}
        >
          <Delete size={24} />
        </button>
      )}
    </div>
  );
};
