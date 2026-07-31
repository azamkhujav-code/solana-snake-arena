'use client';

import { useEffect, useRef } from 'react';

import { useGameStore } from '@/stores/game-store';

const SIZE = 150;

/**
 * World minimap.
 *
 * Drawn on its own small 2D canvas rather than inside the Pixi scene graph: it
 * updates a few times per second, and keeping it out of the main renderer
 * avoids a second camera transform on the hot path every frame.
 *
 * Positions come from the store, which the engine writes at HUD rate — not per
 * frame. Redrawing 150×150 pixels five times a second is free; doing it sixty
 * times a second alongside the game is not.
 */
export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const self = useGameStore((state) => state.selfPosition);
  const others = useGameStore((state) => state.otherPositions);
  const worldRadius = useGameStore((state) => state.worldRadius);
  const connected = useGameStore((state) => state.status === 'connected');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cap DPR: a 3× phone would otherwise rasterise nine times the pixels for
    // a thumbnail.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== SIZE * dpr) {
      canvas.width = SIZE * dpr;
      canvas.height = SIZE * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const centre = SIZE / 2;
    const radius = SIZE / 2 - 5;
    const scale = radius / worldRadius;

    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 29, 72, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    // Clip to the arena disc so a stray position cannot paint outside it.
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    for (const other of others) {
      ctx.beginPath();
      ctx.arc(centre + other.x * scale, centre + other.y * scale, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    if (self) {
      ctx.beginPath();
      ctx.arc(centre + self.x * scale, centre + self.y * scale, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#34d399';
      ctx.fill();
      ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }, [self, others, worldRadius]);

  if (!connected) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{ width: SIZE, height: SIZE }}
      // Hidden on small screens: a phone has no room for it beside the thumb.
      className="pointer-events-none fixed bottom-3 right-3 hidden rounded-full border border-slate-800/80 backdrop-blur-sm sm:block"
      aria-hidden
    />
  );
}
