
import React, { useEffect, useRef } from 'react';

interface Point {
  x: number;
  y: number;
}

interface Bolt {
  segments: Point[];
  branches: Bolt[];
  alpha: number;
  width: number;
  life: number;
  color: string;
}

export const LightningStorm: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let bolts: Bolt[] = [];
    let flashOpacity = 0;

    const resize = () => {
      // Use parent element size if available, fallback to window
      const parent = canvas.parentElement;
      if (parent) {
          width = canvas.width = parent.clientWidth;
          height = canvas.height = parent.clientHeight;
      } else {
          width = canvas.width = window.innerWidth;
          height = canvas.height = window.innerHeight;
      }
    };
    
    resize();
    window.addEventListener('resize', resize);

    const createBoltPath = (startX: number, startY: number, maxY: number): Point[] => {
      const path: Point[] = [{ x: startX, y: startY }];
      let currentX = startX;
      let currentY = startY;

      while (currentY < maxY) {
        // Jagged movement
        const xOffset = (Math.random() - 0.5) * 40; 
        const yStep = Math.random() * 15 + 10;
        
        currentX += xOffset;
        currentY += yStep;
        path.push({ x: currentX, y: currentY });
      }
      return path;
    };

    const createBolt = (x?: number, y?: number, isBranch = false): Bolt => {
      const startX = x ?? Math.random() * width;
      const startY = y ?? 0; // Start from top if main bolt, else from parent
      
      // Main bolts go to bottom, branches fade out sooner
      const maxY = isBranch ? startY + (Math.random() * 200 + 100) : height + 100;

      const path = createBoltPath(startX, startY, maxY);
      
      const branches: Bolt[] = [];
      if (!isBranch) {
        // Chance to create branches from main path points
        path.forEach((point, index) => {
          if (index > 5 && index < path.length - 5 && Math.random() > 0.85) {
             branches.push(createBolt(point.x, point.y, true));
          }
        });
      }

      return {
        segments: path,
        branches,
        alpha: 1,
        width: isBranch ? 1 : 2.5,
        life: 1.0,
        color: Math.random() > 0.5 ? '#00f3ff' : '#bc13fe' // Neon Blue or Purple
      };
    };

    const drawBolt = (bolt: Bolt) => {
      if (bolt.segments.length < 2) return;

      ctx.beginPath();
      ctx.moveTo(bolt.segments[0].x, bolt.segments[0].y);
      for (let i = 1; i < bolt.segments.length; i++) {
        ctx.lineTo(bolt.segments[i].x, bolt.segments[i].y);
      }

      // Outer Glow
      ctx.shadowBlur = 20;
      ctx.shadowColor = bolt.color;
      ctx.strokeStyle = `rgba(255, 255, 255, ${bolt.alpha})`; // White core
      ctx.lineWidth = bolt.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Inner Core (Hotter)
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255, 255, 255, ${bolt.alpha * 0.8})`;
      ctx.lineWidth = bolt.width * 0.5;
      ctx.stroke();

      // Draw branches
      bolt.branches.forEach(branch => {
        branch.alpha = bolt.alpha; // Fade with parent
        drawBolt(branch);
      });
    };

    const loop = () => {
        ctx.clearRect(0, 0, width, height);

        // 1. Draw Screen Flash (Clarão)
        if (flashOpacity > 0.01) {
            ctx.fillStyle = `rgba(200, 220, 255, ${flashOpacity})`;
            ctx.fillRect(0, 0, width, height);
            flashOpacity *= 0.85; // Fast fade out
        } else {
            flashOpacity = 0;
        }

        // 2. Spawn Logic (More Frequent)
        // 0.96 means roughly 4% chance per frame (~2.5 strikes/sec at 60fps)
        if (Math.random() > 0.96) {
            bolts.push(createBolt());
            
            // Trigger flash based on luck, big strikes flash harder
            if (Math.random() > 0.6) {
                flashOpacity = Math.random() * 0.15 + 0.05;
            }
        }

        // 3. Update & Draw Bolts
        for (let i = 0; i < bolts.length; i++) {
            const bolt = bolts[i];
            
            drawBolt(bolt);
            
            // Fade out logic
            // Branches fade slightly faster visually but linked to parent alpha
            bolt.alpha -= 0.05 + (Math.random() * 0.04); 

            if (bolt.alpha <= 0) {
                bolts.splice(i, 1);
                i--;
            }
        }

        requestAnimationFrame(loop);
    };

    const frameId = requestAnimationFrame(loop);

    return () => {
        window.removeEventListener('resize', resize);
        cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <canvas 
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-80 mix-blend-screen"
    />
  );
};
