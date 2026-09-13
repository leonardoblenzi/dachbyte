import { useEffect, useRef } from "react";

export const LogoLightning = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let animationFrame: number;
    let lightningTimer = 0;
    let lightningOpacity = 0;

    const resize = () => {
      const parent = canvas.parentElement!;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };

    resize();
    window.addEventListener("resize", resize);

    const drawLightning = (opacity: number) => {
      const startX = canvas.width / 2;
      const startY = 0;
      const segments = 18;
      const segmentLength = canvas.height / segments;

      ctx.beginPath();
      ctx.moveTo(startX, startY);

      let currentX = startX;
      let currentY = startY;

      for (let i = 0; i < segments; i++) {
        const offset = (Math.random() - 0.5) * 40;
        currentX += offset;
        currentY += segmentLength;

        ctx.lineTo(currentX, currentY);

        if (Math.random() > 0.8) {
          ctx.moveTo(currentX, currentY);
          ctx.lineTo(
            currentX + offset * 0.5,
            currentY + segmentLength * 0.5
          );
        }
      }

      ctx.strokeStyle = `rgba(0,243,255,${opacity})`;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 30;
      ctx.shadowColor = `rgba(0,243,255,${opacity})`;
      ctx.stroke();
    };

    const loop = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // dispara relâmpago raramente
      if (lightningTimer <= 0 && Math.random() > 0.985) {
        lightningTimer = 8; // duração em frames
        lightningOpacity = 1;
      }

      if (lightningTimer > 0) {
        drawLightning(lightningOpacity);
        lightningOpacity *= 0.7; // fade exponencial natural
        lightningTimer--;
      }

      animationFrame = requestAnimationFrame(loop);
    };

    loop();

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-0"
    />
  );
};
