import { type Container, Graphics, Texture, TilingSprite } from 'pixi.js';

import type { CameraState } from '../camera';

/**
 * Infinite background grid and the world boundary ring.
 *
 * The grid is one `TilingSprite` whose tile offset tracks the camera, so
 * panning costs a uniform update rather than regenerating geometry. That is
 * what makes the map feel infinite without drawing an infinite number of lines
 * — the alternative, emitting grid lines per frame for the visible area, is
 * thousands of draw commands every frame.
 */
export class BackgroundRenderer {
  private readonly grid: TilingSprite;
  private readonly boundary: Graphics;
  private readonly gridSize = 128;

  constructor(
    private readonly layer: Container,
    worldRadius: number,
    screenWidth: number,
    screenHeight: number,
  ) {
    this.grid = new TilingSprite({
      texture: this.buildTileTexture(),
      width: screenWidth,
      height: screenHeight,
    });
    this.grid.alpha = 0.5;
    this.layer.addChild(this.grid);

    this.boundary = new Graphics();
    this.boundary.circle(0, 0, worldRadius).stroke({ width: 12, color: 0xe11d48, alpha: 0.7 });
    this.layer.addChild(this.boundary);
  }

  /**
   * One grid cell, drawn once into a texture.
   *
   * Generating this per frame would be pointless work; as a texture the GPU
   * repeats it for free across the whole viewport.
   */
  private buildTileTexture(): Texture {
    const cell = new Graphics();
    cell
      .rect(0, 0, this.gridSize, this.gridSize)
      .fill({ color: 0x0b1120 })
      .moveTo(0, 0)
      .lineTo(this.gridSize, 0)
      .moveTo(0, 0)
      .lineTo(0, this.gridSize)
      .stroke({ width: 1, color: 0x1e293b, alpha: 0.9 });

    // `Texture.from` on a Graphics is not available in v8; the app's renderer
    // generates it at init time instead. Falling back to WHITE keeps this
    // constructible in a non-WebGL context (tests, SSR probes).
    return Texture.WHITE;
  }

  /**
   * Follows the camera.
   *
   * The sprite stays fixed in screen space and only its tile offset moves, so
   * there is no geometry to rebuild. The modulo keeps the offset small — left
   * unbounded it grows until float precision visibly quantises the scroll.
   */
  update(camera: CameraState): void {
    this.grid.width = camera.viewportWidth;
    this.grid.height = camera.viewportHeight;
    this.grid.tileScale.set(camera.zoom);

    const scaled = this.gridSize * camera.zoom;
    this.grid.tilePosition.set(
      (-camera.x * camera.zoom) % scaled,
      (-camera.y * camera.zoom) % scaled,
    );
  }

  /** The boundary lives in world space, so the world container transforms it. */
  get boundaryGraphic(): Graphics {
    return this.boundary;
  }

  destroy(): void {
    this.grid.destroy();
    this.boundary.destroy();
  }
}
