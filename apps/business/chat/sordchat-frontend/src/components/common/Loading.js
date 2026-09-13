import React from 'react';

const Loading = ({ size = 'medium', text = 'Carregando...', fullScreen = false }) => {
  const sizeClasses = {
    small: 'w-4 h-4',
    medium: 'w-8 h-8',
    large: 'w-12 h-12'
  };

  if (fullScreen) {
    return (
      <div className="fixed inset-0 bg-white bg-opacity-90 flex items-center justify-center z-50">
        <div className="text-center">
          <div className={`spinner mx-auto mb-4 ${sizeClasses[size]}`}></div>
          <p className="text-gray-600">{text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-8">
      <div className="text-center">
        <div className={`spinner mx-auto mb-2 ${sizeClasses[size]}`}></div>
        <p className="text-gray-600">{text}</p>
      </div>
    </div>
  );
};

export default Loading;