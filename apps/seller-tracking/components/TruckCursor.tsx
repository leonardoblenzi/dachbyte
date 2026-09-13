import React, { useEffect, useState } from 'react';
import { Truck } from 'lucide-react';

export const TruckCursor: React.FC = () => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isPointer, setIsPointer] = useState(false);
  const [facingRight, setFacingRight] = useState(true);

  useEffect(() => {
    let lastX = 0;

    const onMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });

      // Determine direction
      if (e.clientX > lastX + 2) {
        setFacingRight(true);
      } else if (e.clientX < lastX - 2) {
        setFacingRight(false);
      }
      lastX = e.clientX;

      // Check if hovering over a clickable element
      const target = e.target as HTMLElement;
      if (target) {
        const style = window.getComputedStyle(target);
        setIsPointer(
          style.cursor === 'pointer' ||
          target.tagName.toLowerCase() === 'button' ||
          target.tagName.toLowerCase() === 'a' ||
          target.closest('button') !== null ||
          target.closest('a') !== null
        );
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  return (
    <div
      className="fixed top-0 left-0 pointer-events-none z-[9999] transition-all duration-75 ease-out"
      style={{
        transform: `translate(${position.x + 12}px, ${position.y + 12}px)`,
      }}
    >
      <div
        className={`transition-all duration-200 ${
          isPointer 
            ? 'scale-125 text-blue-500 dark:text-neon-blue drop-shadow-[0_0_8px_rgba(0,243,255,0.8)]' 
            : 'scale-100 text-slate-500 dark:text-slate-400 drop-shadow-md'
        }`}
        style={{
          transform: facingRight ? 'scaleX(-1)' : 'scaleX(1)', // Lucide Truck naturally faces left, so -1 makes it face right
        }}
      >
        <Truck className="w-5 h-5" />
      </div>
    </div>
  );
};
