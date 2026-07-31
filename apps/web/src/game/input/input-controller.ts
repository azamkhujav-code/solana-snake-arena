import { INPUT_SEND_RATE_HZ, type InputCommand } from '@arena/protocol';

import { headingFromScreen, type CameraState } from '../camera';

/**
 * Translates pointer, touch and keyboard into input commands.
 *
 * Input is *sampled* at a fixed rate rather than sent per event. Browsers fire
 * `pointermove` far faster than the send rate — a high-polling mouse can emit
 * 1000 events a second — and forwarding each one would flood the socket and
 * trip the server's per-socket rate limiter within a second.
 */

export interface InputState {
  angle: number;
  boost: boolean;
}

export interface InputController {
  start: () => void;
  stop: () => void;
  /** Latest sampled command, or null if the send interval has not elapsed. */
  poll: (camera: CameraState, nowMs: number) => InputCommand | null;
  /** Current raw state, for the local predictor between sends. */
  current: () => InputState;
  readonly isTouch: boolean;
}

const SEND_INTERVAL_MS = 1_000 / INPUT_SEND_RATE_HZ;

export function createInputController(canvas: HTMLCanvasElement): InputController {
  let angle = 0;
  let boost = false;
  let pointerX = 0;
  let pointerY = 0;
  let sequence = 0;
  let lastSentAt = 0;
  let running = false;

  // Touch devices get a virtual joystick anchored where the finger lands;
  // absolute pointing works with a mouse but is unusable when the thumb is
  // covering the snake.
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);

  let joystickOrigin: { x: number; y: number } | null = null;

  const setFromPointer = (x: number, y: number, camera?: CameraState): void => {
    pointerX = x;
    pointerY = y;
    if (joystickOrigin) {
      const dx = x - joystickOrigin.x;
      const dy = y - joystickOrigin.y;
      // A tiny drag is noise, not a turn; below the dead zone the heading holds.
      if (Math.hypot(dx, dy) > 12) angle = Math.atan2(dy, dx);
    } else if (camera) {
      angle = headingFromScreen(camera, x, y);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointerX = event.clientX - rect.left;
    pointerY = event.clientY - rect.top;
    if (joystickOrigin) setFromPointer(pointerX, pointerY);
  };

  const onPointerDown = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (isTouch) {
      joystickOrigin = { x, y };
      // Second finger boosts, so steering and boosting are independent.
      if (event.isPrimary === false) boost = true;
    } else if (event.button === 0) {
      boost = true;
    }
    setFromPointer(x, y);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (isTouch) {
      if (event.isPrimary) joystickOrigin = null;
      else boost = false;
    } else if (event.button === 0) {
      boost = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space' || event.code === 'ShiftLeft') {
      boost = true;
      // Space scrolls the page otherwise, which yanks the canvas out of view.
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space' || event.code === 'ShiftLeft') boost = false;
  };

  const onContextMenu = (event: Event): void => event.preventDefault();
  const onBlur = (): void => {
    // Without this a tab switch mid-boost leaves the snake boosting forever.
    boost = false;
    joystickOrigin = null;
  };

  return {
    isTouch,

    start(): void {
      if (running) return;
      running = true;

      canvas.addEventListener('pointermove', onPointerMove, { passive: true });
      canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('blur', onBlur);
    },

    stop(): void {
      running = false;
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
    },

    poll(camera, nowMs): InputCommand | null {
      if (!joystickOrigin && !isTouch) {
        // Mouse heading depends on the camera, which moves even when the
        // pointer does not — so it is recomputed on every sample.
        angle = headingFromScreen(camera, pointerX, pointerY);
      }

      if (nowMs - lastSentAt < SEND_INTERVAL_MS) return null;

      const dt = Math.min(250, nowMs - lastSentAt);
      lastSentAt = nowMs;
      sequence += 1;

      return { seq: sequence, angle, boost, dt };
    },

    current(): InputState {
      return { angle, boost };
    },
  };
}
