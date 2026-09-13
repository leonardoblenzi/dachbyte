import React from 'react';
import { Toaster } from 'react-hot-toast';

const Toast = () => {
  const desktopTopOffset = window.voltChatDesktop ? 56 : 16;
  return (
    <Toaster
      position="top-right"
      reverseOrder={false}
      containerStyle={{ top: desktopTopOffset }}
      gutter={8}
      toastOptions={{
        duration: 4000,
        style: {
          background: '#fff',
          color: '#1e293b',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
          fontSize: '14px',
          fontWeight: '500',
          padding: '12px 16px',
        },
        success: {
          duration: 3000,
          iconTheme: {
            primary: '#10b981',
            secondary: '#fff',
          },
        },
        error: {
          duration: 5000,
          iconTheme: {
            primary: '#ef4444',
            secondary: '#fff',
          },
        },
      }}
    />
  );
};

export default Toast;
