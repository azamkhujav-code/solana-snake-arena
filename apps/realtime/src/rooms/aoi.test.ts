import { describe, expect, it } from 'vitest';

import { createAoiView, updateAoiView, withinRadius } from './aoi.js';

describe('withinRadius', () => {
  it('is true inside and false outside', () => {
    expect(withinRadius(0, 0, 3, 4, 5)).toBe(true);
    expect(withinRadius(0, 0, 3, 4, 4.9)).toBe(false);
  });

  it('is inclusive at the boundary', () => {
    expect(withinRadius(0, 0, 5, 0, 5)).toBe(true);
  });
});

describe('updateAoiView', () => {
  it('reports everything as entered on the first update', () => {
    const view = updateAoiView(createAoiView(), [1, 2, 3]);

    expect(view.entered.sort()).toEqual([1, 2, 3]);
    expect(view.exited).toHaveLength(0);
    expect([...view.visible].sort()).toEqual([1, 2, 3]);
  });

  it('reports only the delta on subsequent updates', () => {
    const view = createAoiView();
    updateAoiView(view, [1, 2, 3]);
    updateAoiView(view, [2, 3, 4]);

    expect(view.entered).toEqual([4]);
    expect(view.exited).toEqual([1]);
  });

  it('reports nothing when the set is unchanged', () => {
    const view = createAoiView();
    updateAoiView(view, [1, 2]);
    updateAoiView(view, [1, 2]);

    expect(view.entered).toHaveLength(0);
    expect(view.exited).toHaveLength(0);
  });

  it('exits everything when the view empties', () => {
    // Without this the client keeps rendering snakes that walked off screen.
    const view = createAoiView();
    updateAoiView(view, [1, 2, 3]);
    updateAoiView(view, []);

    expect(view.exited.sort()).toEqual([1, 2, 3]);
    expect(view.visible.size).toBe(0);
  });

  it('reuses the same arrays across updates', () => {
    // Allocating per player per snapshot is enough garbage to cause GC pauses,
    // and a GC pause is a missed tick.
    const view = createAoiView();
    const entered = view.entered;
    const exited = view.exited;

    updateAoiView(view, [1]);
    updateAoiView(view, [2]);

    expect(view.entered).toBe(entered);
    expect(view.exited).toBe(exited);
  });
});
