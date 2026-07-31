import { type Container, Particle, ParticleContainer, type Texture } from 'pixi.js';

/**
 * Particle effects: death bursts and boost trails.
 *
 * A fixed-size pool with a free list. Effects fire in bursts — a death emits
 * dozens at once — and allocating on death means the biggest allocation spike
 * lands exactly when the frame is already busy rendering an explosion.
 */

interface ParticleState {
  particle: Particle;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  startScale: number;
  active: boolean;
}

export class ParticleSystem {
  private readonly container: ParticleContainer;
  private readonly particles: ParticleState[] = [];
  private readonly free: number[] = [];

  constructor(
    private readonly layer: Container,
    texture: Texture,
    private readonly capacity = 400,
  ) {
    this.container = new ParticleContainer({
      dynamicProperties: { position: true, scale: true, alpha: true, tint: false, rotation: false },
    });
    this.layer.addChild(this.container);

    // Pre-allocate everything up front so no frame ever pays for allocation.
    for (let i = 0; i < capacity; i += 1) {
      const particle = new Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
      particle.alpha = 0;
      this.container.addParticle(particle);
      this.particles.push({
        particle,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        startScale: 1,
        active: false,
      });
      this.free.push(i);
    }
  }

  /** Ring of debris where a snake died. */
  burst(x: number, y: number, colour: number, count = 24, speed = 220): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const velocity = speed * (0.5 + Math.random() * 0.8);
      this.emit(x, y, Math.cos(angle) * velocity, Math.sin(angle) * velocity, colour, 900, 1.6);
    }
  }

  /** Short-lived spark shed behind a boosting snake. */
  trail(x: number, y: number, colour: number): void {
    this.emit(
      x + (Math.random() - 0.5) * 12,
      y + (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 40,
      (Math.random() - 0.5) * 40,
      colour,
      380,
      0.9,
    );
  }

  private emit(
    x: number,
    y: number,
    vx: number,
    vy: number,
    colour: number,
    lifeMs: number,
    scale: number,
  ): void {
    const index = this.free.pop();
    // Silently dropping when saturated is deliberate: the alternative is
    // growing the pool during the exact frame that overwhelmed it.
    if (index === undefined) return;

    const state = this.particles[index]!;
    state.particle.x = x;
    state.particle.y = y;
    state.particle.tint = colour;
    state.particle.alpha = 1;
    state.particle.scaleX = scale;
    state.particle.scaleY = scale;
    state.vx = vx;
    state.vy = vy;
    state.life = lifeMs;
    state.maxLife = lifeMs;
    state.startScale = scale;
    state.active = true;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1_000;

    for (let i = 0; i < this.particles.length; i += 1) {
      const state = this.particles[i]!;
      if (!state.active) continue;

      state.life -= deltaMs;
      if (state.life <= 0) {
        state.active = false;
        state.particle.alpha = 0;
        this.free.push(i);
        continue;
      }

      state.particle.x += state.vx * dt;
      state.particle.y += state.vy * dt;

      // Drag, so debris decelerates rather than flying off at constant speed.
      state.vx *= 0.94;
      state.vy *= 0.94;

      const t = state.life / state.maxLife;
      state.particle.alpha = t;
      const scale = state.startScale * (0.3 + t * 0.7);
      state.particle.scaleX = scale;
      state.particle.scaleY = scale;
    }
  }

  get activeCount(): number {
    return this.capacity - this.free.length;
  }

  destroy(): void {
    this.container.destroy();
    this.particles.length = 0;
    this.free.length = 0;
  }
}
