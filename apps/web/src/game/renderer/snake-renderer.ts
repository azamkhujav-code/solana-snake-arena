import { type Container, Graphics, Text, TextStyle } from 'pixi.js';

import { isVisible, type CameraBounds } from '../camera';
import type { InterpolatedSnake } from '../net/interpolation';

/**
 * Snake bodies.
 *
 * Each snake is drawn as a single `Graphics` redrawn per frame rather than one
 * sprite per segment. A full room holds tens of thousands of segments, and a
 * display object per segment blows the draw-call budget long before the GPU is
 * the limit.
 *
 * Graphics objects are pooled by player id, so a snake entering and leaving the
 * viewport does not churn allocations.
 */

export interface SnakeVisual {
  body: Graphics;
  label: Text;
}

const LABEL_STYLE = new TextStyle({
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 14,
  fill: 0xe2e8f0,
  stroke: { color: 0x020617, width: 3 },
});

/** Deterministic colour per player, so a snake looks the same to everyone. */
export function colourForPlayer(playerId: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < playerId.length; i += 1) {
    hash ^= playerId.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }

  const hue = (hash >>> 0) % 360;
  const c = 0.65;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));

  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const to255 = (value: number) => Math.round(60 + value * 195);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

export class SnakeRenderer {
  private readonly visuals = new Map<string, SnakeVisual>();
  private readonly pool: SnakeVisual[] = [];
  private time = 0;

  constructor(
    private readonly bodyLayer: Container,
    private readonly labelLayer: Container,
  ) {}

  update(
    snakes: readonly InterpolatedSnake[],
    bounds: CameraBounds,
    deltaMs: number,
    selfId: string | null,
    zoom: number,
  ): void {
    this.time += deltaMs;
    const seen = new Set<string>();

    for (const snake of snakes) {
      const head = snake.points[0];
      if (!head) continue;
      if (!isVisible(bounds, head.x, head.y, snake.radius + 200)) continue;

      seen.add(snake.id);
      const visual = this.acquire(snake.id);
      this.draw(visual, snake, selfId === snake.id, zoom);
    }

    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;
      this.release(id, visual);
    }
  }

  private acquire(id: string): SnakeVisual {
    const existing = this.visuals.get(id);
    if (existing) return existing;

    const recycled = this.pool.pop();
    const visual: SnakeVisual = recycled ?? {
      body: new Graphics(),
      label: new Text({ text: '', style: LABEL_STYLE }),
    };

    visual.label.anchor.set(0.5, 1);
    visual.body.visible = true;
    visual.label.visible = true;

    this.bodyLayer.addChild(visual.body);
    this.labelLayer.addChild(visual.label);
    this.visuals.set(id, visual);

    return visual;
  }

  private release(id: string, visual: SnakeVisual): void {
    this.bodyLayer.removeChild(visual.body);
    this.labelLayer.removeChild(visual.label);
    visual.body.clear();
    this.visuals.delete(id);

    if (this.pool.length < 64) this.pool.push(visual);
    else {
      visual.body.destroy();
      visual.label.destroy();
    }
  }

  private draw(visual: SnakeVisual, snake: InterpolatedSnake, isSelf: boolean, zoom: number): void {
    const { body, label } = visual;
    body.clear();

    const points = snake.points;
    const head = points[0];
    if (!head) return;

    const colour = colourForPlayer(snake.id);

    // The spine is drawn as one stroked polyline with round joins, which reads
    // as a continuous body far more cheaply than stamping a circle per segment.
    if (points.length > 1) {
      body.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i += 1) {
        body.lineTo(points[i]!.x, points[i]!.y);
      }

      // Outline first, then the fill on top, so adjacent snakes stay readable
      // where they overlap.
      body.stroke({
        width: snake.radius * 2 + 6,
        color: 0x020617,
        alpha: 0.85,
        cap: 'round',
        join: 'round',
      });

      body.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i += 1) {
        body.lineTo(points[i]!.x, points[i]!.y);
      }
      body.stroke({ width: snake.radius * 2, color: colour, cap: 'round', join: 'round' });
    }

    // Boost glow. Pulsing is cheap here because it is one extra stroke, not a
    // per-segment effect.
    if (snake.boosting) {
      const pulse = 0.35 + Math.sin(this.time / 90) * 0.15;
      body.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < Math.min(points.length, 24); i += 1) {
        body.lineTo(points[i]!.x, points[i]!.y);
      }
      body.stroke({
        width: snake.radius * 2 + 10,
        color: 0xffffff,
        alpha: pulse,
        cap: 'round',
        join: 'round',
      });
    }

    // Head, then eyes oriented along the heading.
    body.circle(head.x, head.y, snake.radius).fill({ color: colour });
    body.circle(head.x, head.y, snake.radius).stroke({ width: 3, color: 0x020617, alpha: 0.9 });

    const eyeOffset = snake.radius * 0.45;
    const eyeRadius = Math.max(2, snake.radius * 0.28);
    for (const side of [-1, 1]) {
      const ex = head.x + Math.cos(snake.angle + side * 0.6) * eyeOffset;
      const ey = head.y + Math.sin(snake.angle + side * 0.6) * eyeOffset;
      body.circle(ex, ey, eyeRadius).fill({ color: 0xffffff });
      body
        .circle(
          ex + Math.cos(snake.angle) * eyeRadius * 0.4,
          ey + Math.sin(snake.angle) * eyeRadius * 0.4,
          eyeRadius * 0.5,
        )
        .fill({ color: 0x0f172a });
    }

    if (isSelf) {
      body.circle(head.x, head.y, snake.radius + 8).stroke({
        width: 2,
        color: 0x34d399,
        alpha: 0.6,
      });
    }

    label.text = snake.nickname;
    label.x = head.x;
    label.y = head.y - snake.radius - 8;
    // Counter-scale so the name stays legible at any zoom.
    label.scale.set(1 / Math.max(0.001, zoom));
    // Hide labels when zoomed far out; at that size they are unreadable clutter
    // and hundreds of text objects are the most expensive thing on screen.
    label.visible = zoom > 0.6;
  }

  get visibleCount(): number {
    return this.visuals.size;
  }

  destroy(): void {
    for (const [id, visual] of this.visuals) this.release(id, visual);
    for (const visual of this.pool) {
      visual.body.destroy();
      visual.label.destroy();
    }
    this.pool.length = 0;
  }
}
