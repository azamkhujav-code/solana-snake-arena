import { type Container, Particle, ParticleContainer, type Texture } from 'pixi.js';

import type { FoodState } from '@arena/protocol';

import { isVisible, type CameraBounds } from '../camera';

/**
 * Food pellets.
 *
 * Food is the highest-count entity on screen and every pellet shares one
 * texture, so it renders through a single `ParticleContainer` — one draw call
 * for hundreds of pellets. A `Sprite` per pellet would be hundreds of scene
 * graph nodes with full transform bookkeeping, for something that is a coloured
 * dot.
 */
export class FoodRenderer {
  private readonly container: ParticleContainer;
  private readonly active = new Map<number, Particle>();
  /** Particles removed from view, kept for reuse. */
  private readonly pool: Particle[] = [];
  private time = 0;

  constructor(
    private readonly layer: Container,
    private readonly texture: Texture,
  ) {
    this.container = new ParticleContainer({
      // Only these change per frame. Declaring the rest static lets Pixi skip
      // re-uploading them, which is most of the win.
      dynamicProperties: { position: true, scale: true, tint: false, rotation: false },
    });
    this.layer.addChild(this.container);
  }

  update(food: readonly FoodState[], bounds: CameraBounds, deltaMs: number): void {
    this.time += deltaMs;
    const seen = new Set<number>();

    for (const pellet of food) {
      if (!isVisible(bounds, pellet.position.x, pellet.position.y, 20)) continue;
      seen.add(pellet.id);

      let particle = this.active.get(pellet.id);
      if (!particle) {
        particle =
          this.pool.pop() ?? new Particle({ texture: this.texture, anchorX: 0.5, anchorY: 0.5 });
        particle.tint = hueToRgb(pellet.hue);
        this.active.set(pellet.id, particle);
        this.container.addParticle(particle);
      }

      particle.x = pellet.position.x;
      particle.y = pellet.position.y;

      // Gentle pulse, offset per pellet so the field does not breathe in unison.
      const pulse = 1 + Math.sin(this.time / 320 + pellet.id) * 0.12;
      const scale = ((4 + pellet.mass * 0.9) / 8) * pulse;
      particle.scaleX = scale;
      particle.scaleY = scale;
    }

    for (const [id, particle] of this.active) {
      if (seen.has(id)) continue;
      this.container.removeParticle(particle);
      this.active.delete(id);
      // Recycled rather than destroyed; pellets churn constantly and
      // reallocating each one is avoidable garbage.
      if (this.pool.length < 512) this.pool.push(particle);
    }
  }

  get visibleCount(): number {
    return this.active.size;
  }

  destroy(): void {
    this.container.destroy();
    this.active.clear();
    this.pool.length = 0;
  }
}

/** Fully saturated HSL to packed RGB. */
export function hueToRgb(hue: number): number {
  const h = ((hue % 360) + 360) % 360;
  const c = 1;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  // Lifted toward white so pellets stay readable on a dark background.
  const lift = (value: number) => Math.round(120 + value * 135);
  return (lift(r) << 16) | (lift(g) << 8) | lift(b);
}
