import {
  ClientEvent,
  decodeSnapshot,
  INTERPOLATION_DELAY_MS,
  ServerEvent,
  type LeaderboardEntry,
  type MatchEnded,
  type PlayerDied,
  type RoomJoined,
} from '@arena/protocol';
import { Application, Container, Graphics, type Texture } from 'pixi.js';

import { createCamera, followTarget, visibleBounds, zoomForMass, type CameraState } from './camera';
import { createInputController, type InputController } from './input/input-controller';
import {
  createSnapshotBuffer,
  sampleAt,
  pushSnapshot,
  type InterpolatedFrame,
} from './net/interpolation';
import {
  createPredictionBuffer,
  pushPrediction,
  reconcile,
  type PredictionBuffer,
} from './net/prediction';
import type { ArenaSocket } from './net/socket-client';
import { BackgroundRenderer } from './renderer/background';
import { FoodRenderer } from './renderer/food-renderer';
import { ParticleSystem } from './renderer/particles';
import { colourForPlayer, SnakeRenderer } from './renderer/snake-renderer';

export type QualityPreset = 'low' | 'medium' | 'high';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  socket: ArenaSocket;
  playerId: string;
  quality: QualityPreset;
  onHud?: (hud: EngineHud) => void;
  onDeath?: (event: PlayerDied) => void;
  /** The match resolved; standings are final. */
  onEnded?: ((event: MatchEnded) => void) | undefined;
  onLeaderboard?: (entries: LeaderboardEntry[]) => void;
}

export interface EngineHud {
  score: number;
  mass: number;
  alive: boolean;
  spectating: boolean;
  fps: number;
  rttMs: number;
  visibleSnakes: number;
  /** Server clock, for the match timer. */
  elapsedMs: number;
  worldRadius: number;
  /** Minimap positions, sampled at HUD rate rather than per frame. */
  selfPosition: { x: number; y: number } | null;
  otherPositions: Array<{ x: number; y: number }>;
  /** Nickname lookup so the kill feed can name players. */
  nicknames: Map<string, string>;
}

/**
 * Owns the PixiJS application and the render loop.
 *
 * Deliberately isolated from React: the loop runs at display refresh rate, and
 * routing any of it through component state would trigger a reconcile per
 * frame. React renders the HUD; this class renders the game.
 */
export class GameEngine {
  private app: Application | null = null;
  private readonly world = new Container();
  private readonly backgroundLayer = new Container();
  private readonly foodLayer = new Container();
  private readonly bodyLayer = new Container();
  private readonly particleLayer = new Container();
  private readonly labelLayer = new Container();

  private background: BackgroundRenderer | null = null;
  private snakes: SnakeRenderer | null = null;
  private food: FoodRenderer | null = null;
  private particles: ParticleSystem | null = null;

  private input: InputController | null = null;
  private socket: ArenaSocket | null = null;
  private options: EngineOptions | null = null;

  private camera: CameraState = createCamera(1, 1);
  private readonly buffer = createSnapshotBuffer();
  private prediction: PredictionBuffer | null = null;

  private serverTimeOffset = 0;
  private rttMs = 0;
  private worldRadius = 8_000;
  private alive = false;
  private spectating = false;
  private running = false;

  private frameCount = 0;
  private fpsAccumulator = 0;
  private fps = 60;
  private hudAccumulator = 0;
  private lastFrameAt = 0;

  async init(options: EngineOptions): Promise<void> {
    this.options = options;
    this.socket = options.socket;

    const app = new Application();

    // Pixi 8's init is async and must complete before any resource is added.
    await app.init({
      canvas: options.canvas,
      resizeTo: window,
      background: 0x0b1120,
      // Antialiasing is the single most expensive setting on a weak GPU, and a
      // phone gets none of it.
      antialias: options.quality === 'high',
      // Capping DPR matters most on mobile: a 3x retina phone would otherwise
      // render nine times the pixels of a 1x display.
      resolution: Math.min(window.devicePixelRatio || 1, options.quality === 'low' ? 1 : 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });

    this.app = app;
    this.camera = createCamera(app.screen.width, app.screen.height);

    // Layer order is the draw order: grid, food, bodies, particles, labels.
    app.stage.addChild(this.backgroundLayer);
    app.stage.addChild(this.world);
    this.world.addChild(this.foodLayer, this.bodyLayer, this.particleLayer, this.labelLayer);

    const dot = this.makeDotTexture(app);

    this.background = new BackgroundRenderer(
      this.backgroundLayer,
      this.worldRadius,
      app.screen.width,
      app.screen.height,
    );
    this.world.addChild(this.background.boundaryGraphic);

    this.food = new FoodRenderer(this.foodLayer, dot);
    this.snakes = new SnakeRenderer(this.bodyLayer, this.labelLayer);
    this.particles = new ParticleSystem(
      this.particleLayer,
      dot,
      options.quality === 'low' ? 120 : 400,
    );

    this.input = createInputController(options.canvas);
    this.input.start();

    this.wireSocket();

    app.ticker.add((ticker) => this.onFrame(ticker.deltaMS));
    this.running = true;
  }

  /** One white dot, reused by food and every particle. */
  private makeDotTexture(app: Application): Texture {
    const graphic = new Graphics().circle(0, 0, 8).fill({ color: 0xffffff });
    return app.renderer.generateTexture(graphic);
  }

  private wireSocket(): void {
    const socket = this.socket;
    const options = this.options;
    if (!socket || !options) return;

    socket.on(ServerEvent.Joined, (payload: RoomJoined) => {
      this.worldRadius = payload.worldRadius;
      this.alive = true;
      this.spectating = false;
      this.prediction = createPredictionBuffer({ x: 0, y: 0, angle: 0, mass: 10 });
    });

    socket.on(ServerEvent.Snapshot, (payload) => {
      // The hot path is an ArrayBuffer; the JSON form only appears in dev.
      const snapshot =
        payload instanceof ArrayBuffer
          ? decodeSnapshot(payload, { x: this.camera.x, y: this.camera.y })
          : payload;

      pushSnapshot(this.buffer, snapshot);
      this.reconcileSelf(snapshot);
    });

    socket.on(ServerEvent.Died, (event: PlayerDied) => {
      // Every death in the room arrives here; the callback drives the kill
      // feed and kill counter, so it fires for all of them.
      options.onDeath?.(event);

      if (event.playerId !== options.playerId) return;

      this.alive = false;
      // Death does not disconnect: the camera keeps following the last known
      // position so the player can watch the room while deciding to respawn.
      this.spectating = true;

      const self = this.currentFrame()?.snakes.find((s) => s.id === options.playerId);
      const head = self?.points[0];
      if (head && this.particles) {
        this.particles.burst(head.x, head.y, colourForPlayer(options.playerId), 40, 320);
      }
    });

    socket.on(ServerEvent.Leaderboard, (entries: LeaderboardEntry[]) => {
      options.onLeaderboard?.(entries);
    });

    socket.on(ServerEvent.Ended, (event: MatchEnded) => {
      // The match is decided, so stop taking input: the snake is no longer
      // playing for anything and steering it into a wall after the fact would
      // be a strange last impression.
      this.spectating = true;
      options.onEnded?.(event);
    });

    // Clock sync. Interpolation renders at `serverTime - delay`, so a wrong
    // offset shows up as permanent stutter rather than an obvious clock bug.
    const ping = (): void => {
      const sentAt = performance.now();
      socket.emit(ClientEvent.Ping, Math.floor(sentAt), (serverTime: number) => {
        const now = performance.now();
        this.rttMs = now - sentAt;
        this.serverTimeOffset = serverTime + this.rttMs / 2 - now;
      });
    };
    ping();
    const pingTimer = setInterval(ping, 2_000);
    socket.on('disconnect', () => clearInterval(pingTimer));
  }

  private reconcileSelf(snapshot: {
    snakes: Array<{
      id: string;
      points: Array<{ x: number; y: number }>;
      angle: number;
      mass: number;
    }>;
    ackSeq: number;
  }): void {
    const options = this.options;
    if (!options || !this.prediction) return;

    const self = snapshot.snakes.find((snake) => snake.id === options.playerId);
    const head = self?.points[0];
    if (!self || !head) return;

    reconcile(
      this.prediction,
      { x: head.x, y: head.y, angle: self.angle, mass: self.mass },
      snapshot.ackSeq,
      1 / 30,
    );
  }

  private currentFrame(): InterpolatedFrame | null {
    const renderTime = performance.now() + this.serverTimeOffset - INTERPOLATION_DELAY_MS;
    return sampleAt(this.buffer, renderTime);
  }

  /**
   * The frame loop.
   *
   * Per frame: sample input, predict locally, sample the interpolation buffer
   * for remote entities, update renderers, move the camera.
   */
  private onFrame(deltaMs: number): void {
    if (!this.running || !this.app) return;

    const now = performance.now();
    this.lastFrameAt = now;

    // ---- Input + prediction ------------------------------------------------
    if (this.input && this.socket && this.alive && this.prediction) {
      const command = this.input.poll(this.camera, now);
      if (command) {
        pushPrediction(this.prediction, command, command.dt / 1_000);
        this.socket.emit(ClientEvent.Input, {
          commands: [command],
          clientTime: Math.floor(now),
        });
      }
    }

    // ---- Interpolated world ------------------------------------------------
    const frame = this.currentFrame();

    // The local snake follows the prediction; everyone else follows the
    // interpolated snapshot. Using the snapshot for self would add a full round
    // trip of input lag.
    const target =
      this.alive && this.prediction
        ? { x: this.prediction.state.x, y: this.prediction.state.y }
        : (frame?.snakes.find((s) => s.id === this.options?.playerId)?.points[0] ?? {
            x: this.camera.x,
            y: this.camera.y,
          });

    const mass = this.prediction?.state.mass ?? 10;
    followTarget(this.camera, target, zoomForMass(mass), deltaMs);

    // ---- Render ------------------------------------------------------------
    const bounds = visibleBounds(this.camera);

    this.world.scale.set(this.camera.zoom);
    this.world.position.set(
      this.app.screen.width / 2 - this.camera.x * this.camera.zoom,
      this.app.screen.height / 2 - this.camera.y * this.camera.zoom,
    );

    this.background?.update(this.camera);

    if (frame) {
      this.food?.update(frame.food, bounds, deltaMs);
      this.snakes?.update(
        frame.snakes,
        bounds,
        deltaMs,
        this.options?.playerId ?? null,
        this.camera.zoom,
      );

      // Boost trails, skipped entirely on the low preset.
      if (this.particles && this.options?.quality !== 'low') {
        for (const snake of frame.snakes) {
          if (!snake.boosting) continue;
          const tail = snake.points[snake.points.length - 1];
          if (tail) this.particles.trail(tail.x, tail.y, colourForPlayer(snake.id));
        }
      }
    }

    this.particles?.update(deltaMs);

    // ---- HUD ---------------------------------------------------------------
    this.frameCount += 1;
    this.fpsAccumulator += deltaMs;
    if (this.fpsAccumulator >= 500) {
      this.fps = Math.round((this.frameCount * 1_000) / this.fpsAccumulator);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // The HUD is React, so it updates a few times a second rather than every
    // frame — that is the whole reason the loop lives outside React.
    this.hudAccumulator += deltaMs;
    if (this.hudAccumulator >= 200) {
      this.hudAccumulator = 0;
      const nicknames = new Map<string, string>();
      const otherPositions: Array<{ x: number; y: number }> = [];

      for (const snake of frame?.snakes ?? []) {
        nicknames.set(snake.id, snake.nickname);
        const head = snake.points[0];
        if (head && snake.id !== this.options?.playerId) {
          otherPositions.push({ x: head.x, y: head.y });
        }
      }

      this.options?.onHud?.({
        score: Math.max(0, Math.floor((mass - 10) * 10)),
        mass,
        alive: this.alive,
        spectating: this.spectating,
        fps: this.fps,
        rttMs: Math.round(this.rttMs),
        visibleSnakes: this.snakes?.visibleCount ?? 0,
        elapsedMs: frame?.serverTime ?? 0,
        worldRadius: this.worldRadius,
        selfPosition: this.alive ? { x: target.x, y: target.y } : null,
        otherPositions,
        nicknames,
      });
    }
  }

  /**
   * Tells the server the player is leaving for good.
   *
   * Without this the only signal is the socket closing, which the room treats
   * as a blip: the seat is held for the reconnect grace window with the snake
   * still in the arena. For a staked match that means the player who quit is
   * still alive to everyone else, and can still "win" it by outlasting them.
   */
  leave(): void {
    this.socket?.emit(ClientEvent.Leave);
  }

  /** Requests a respawn and leaves spectator mode. */
  respawn(): void {
    this.socket?.emit(ClientEvent.Respawn, () => {
      this.alive = true;
      this.spectating = false;
      this.prediction = createPredictionBuffer({
        x: this.camera.x,
        y: this.camera.y,
        angle: 0,
        mass: 10,
      });
    });
  }

  resize(width: number, height: number): void {
    this.camera.viewportWidth = width;
    this.camera.viewportHeight = height;
    this.app?.renderer.resize(width, height);
  }

  start(): void {
    this.running = true;
    this.app?.ticker.start();
  }

  stop(): void {
    this.running = false;
    this.app?.ticker.stop();
  }

  get lastFrameTime(): number {
    return this.lastFrameAt;
  }

  /**
   * Releases GPU resources.
   *
   * Must run on unmount — a leaked WebGL context per navigation exhausts the
   * browser's context limit after a handful of games and the canvas goes black.
   */
  destroy(): void {
    this.running = false;
    this.input?.stop();

    this.background?.destroy();
    this.snakes?.destroy();
    this.food?.destroy();
    this.particles?.destroy();

    this.world.destroy({ children: true });
    this.app?.destroy(true, { children: true, texture: true });
    this.app = null;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
