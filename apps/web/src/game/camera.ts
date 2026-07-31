/**
 * Camera.
 *
 * Follows the player with easing, zooms out as they grow, and exposes the
 * visible world rectangle so the renderers can cull. Pure maths — no Pixi — so
 * the follow and zoom behaviour is testable without a browser.
 */

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 1.35;

export function createCamera(viewportWidth: number, viewportHeight: number): CameraState {
  return { x: 0, y: 0, zoom: 1, viewportWidth, viewportHeight };
}

/**
 * Zoom for a given mass.
 *
 * Zooming out as the snake grows keeps roughly the same fraction of the body on
 * screen. Without it a large snake fills the viewport and the player can no
 * longer see what they are about to hit.
 */
export function zoomForMass(mass: number): number {
  const zoom = 1.15 / (1 + Math.max(0, mass - 10) / 900);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Moves the camera toward the target.
 *
 * `factor` is scaled by frame time rather than applied per frame, so the follow
 * feels identical at 30 fps and 144 fps. A raw per-frame lerp makes the camera
 * lag noticeably more on a slow device — a gameplay difference caused purely by
 * hardware.
 */
export function followTarget(
  camera: CameraState,
  target: { x: number; y: number },
  targetZoom: number,
  deltaMs: number,
  responsiveness = 8,
): CameraState {
  const t = 1 - Math.exp((-responsiveness * deltaMs) / 1_000);

  camera.x += (target.x - camera.x) * t;
  camera.y += (target.y - camera.y) * t;
  // Zoom eases more slowly; a snappy zoom on every pellet eaten is nauseating.
  camera.zoom += (targetZoom - camera.zoom) * t * 0.35;

  return camera;
}

export function resizeCamera(camera: CameraState, width: number, height: number): CameraState {
  camera.viewportWidth = width;
  camera.viewportHeight = height;
  return camera;
}

/**
 * The world rectangle currently visible, padded so entities partly on screen
 * are not culled at the edges.
 */
export function visibleBounds(camera: CameraState, padding = 200): CameraBounds {
  const halfWidth = camera.viewportWidth / 2 / camera.zoom;
  const halfHeight = camera.viewportHeight / 2 / camera.zoom;

  return {
    minX: camera.x - halfWidth - padding,
    maxX: camera.x + halfWidth + padding,
    minY: camera.y - halfHeight - padding,
    maxY: camera.y + halfHeight + padding,
  };
}

export function isVisible(bounds: CameraBounds, x: number, y: number, radius = 0): boolean {
  return (
    x + radius >= bounds.minX &&
    x - radius <= bounds.maxX &&
    y + radius >= bounds.minY &&
    y - radius <= bounds.maxY
  );
}

export function worldToScreen(camera: CameraState, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.x) * camera.zoom + camera.viewportWidth / 2,
    y: (y - camera.y) * camera.zoom + camera.viewportHeight / 2,
  };
}

export function screenToWorld(camera: CameraState, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.viewportWidth / 2) / camera.zoom + camera.x,
    y: (y - camera.viewportHeight / 2) / camera.zoom + camera.y,
  };
}

/**
 * Angle from the viewport centre to a screen point.
 *
 * The heading the player is asking for is defined by where they point relative
 * to their snake, which is always centred — so this needs no world conversion
 * and stays correct at any zoom.
 */
export function headingFromScreen(camera: CameraState, screenX: number, screenY: number): number {
  return Math.atan2(screenY - camera.viewportHeight / 2, screenX - camera.viewportWidth / 2);
}
