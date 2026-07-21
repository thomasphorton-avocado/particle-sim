import { placeWorldCell, type WorldState } from "@particle-sim/shared";

// Match the character's gravity model so falling objects feel consistent.
const GRAVITY = 0.4; // cells / frame^2
const TERMINAL_VY = 3; // cells / frame

/**
 * Advance any objects currently falling from a mid-air placement toward the
 * ground. On landing, the object's footprint is stamped into the grid and the
 * entity is removed from the animation list.
 */
export function updateFallingObjects(world: WorldState, dt: number): void {
  const grid = world.grid;
  const fallingEntries = Object.entries(world.fallingObjects);
  if (fallingEntries.length === 0) return;
  const dtFrames = Math.min(dt * 60, 3);

  for (const [objectId, o] of fallingEntries) {
    o.vy = Math.min(o.vy + GRAVITY * dtFrames, TERMINAL_VY);
    o.y += o.vy * dtFrames;

    if (o.y >= o.restY) {
      // Landed: stamp the object's footprint centered on (o.x, restY).
      for (const [dx, dy] of o.offsets) {
        const x = o.x + dx;
        const y = o.restY + dy;
        if (grid.inBounds(x, y)) placeWorldCell(world, x, y, o.materialId, { objectId: o.id });
      }
      delete world.fallingObjects[objectId];
    }
  }
}
