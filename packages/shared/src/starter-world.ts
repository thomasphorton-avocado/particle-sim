import { Grid, placeWorldCell } from "./grid.js";
import { createGameplayRandomState } from "./random.js";
import { MaterialId } from "./materials.js";
import { createDefaultWorldState, type WorldState, allocateObjectId } from "./world-state.js";
import { createObjectId } from "./ids.js";

const GRID_WIDTH = 320;
const GRID_HEIGHT = 200;

export interface StarterWorldOptions {
  roomId?: string;
  seed?: number;
}

export function createStarterWorld(options: StarterWorldOptions = {}): WorldState {
  const world = createDefaultWorldState(options.roomId ?? "room_default", new Grid(GRID_WIDTH, GRID_HEIGHT));
  world.random = createGameplayRandomState(options.seed ?? 0);
  populateStarterWorld(world);
  return world;
}

function setWorldMaterial(world: WorldState, x: number, y: number, materialId: MaterialId, objectId?: string): void {
  const resolvedObjectId = objectId ? createObjectId(objectId) : undefined;
  placeWorldCell(world, x, y, materialId, { objectId: resolvedObjectId });
}

function setObjectMaterial(world: WorldState, x: number, y: number, materialId: MaterialId, objectId: string): void {
  setWorldMaterial(world, x, y, materialId, objectId);
}

export function populateStarterWorld(world: WorldState): void {
  const grid = world.grid;

  // --- Top sloped dirt shelf (river channel) ---
  // Slopes from upper-left (~x=10,y=22) to mid-right (~x=195,y=55)
  for (let x = 8; x < 200; x++) {
    const progress = (x - 8) / (200 - 8);
    const topY = Math.floor(22 + progress * 33); // slope from y=22 to y=55
    const thickness = Math.floor(14 + Math.sin(x * 0.05) * 4); // 10-18 cells thick
    for (let dy = 0; dy < thickness; dy++) {
      const y = topY + dy;
      if (grid.inBounds(x, y)) {
        setWorldMaterial(world, x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Large middle platform ---
  // Flat shelf from about x=25 to x=215, top at y=95
  for (let x = 25; x < 215; x++) {
    const topY = 95 + Math.floor(Math.sin(x * 0.03) * 2); // slight waviness
    const thickness = 22;
    for (let dy = 0; dy < thickness; dy++) {
      const y = topY + dy;
      if (grid.inBounds(x, y)) {
        setWorldMaterial(world, x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Stone boulder on middle platform ---
  // Blob centered around (95, 82), radius ~12
  const boulderCx = 95,
    boulderCy = 82,
    boulderR = 12;
  const boulderObjectId = allocateObjectId(world);
  for (let y = boulderCy - boulderR; y <= boulderCy + boulderR; y++) {
    for (let x = boulderCx - boulderR; x <= boulderCx + boulderR; x++) {
      const dx = x - boulderCx,
        dy = y - boulderCy;
      // Slightly irregular shape
      const r = boulderR + Math.sin(Math.atan2(dy, dx) * 5) * 2;
      if (dx * dx + dy * dy <= r * r && grid.inBounds(x, y)) {
        setObjectMaterial(world, x, y, MaterialId.Stone, boulderObjectId);
      }
    }
  }

  // --- Wood plank on the right ---
  // About x=200-250, y=105, size 48x6
  const plankObjectId = allocateObjectId(world);
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 48; dx++) {
      const x = 200 + dx,
        y = 105 + dy;
      if (grid.inBounds(x, y)) {
        setObjectMaterial(world, x, y, MaterialId.Wood, plankObjectId);
      }
    }
  }

  // --- Bottom terrain (diagonal slope) ---
  // Surface goes from about (0, 168) sloping down to (200, 195)
  for (let x = 0; x < 220; x++) {
    const progress = x / 220;
    const surfaceY = Math.floor(168 + progress * 27);
    for (let y = surfaceY; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Empty) {
        setWorldMaterial(world, x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Stone mountain (bottom-right) ---
  // Triangle peak at (265, 110), base from (230, 170) to (300, 170)
  const peakX = 265,
    peakY = 110,
    mtnBaseY = 172;
  const mtnHalfBase = 35;
  for (let y = peakY; y <= mtnBaseY; y++) {
    const progress = (y - peakY) / (mtnBaseY - peakY);
    const halfW = Math.floor(progress * mtnHalfBase);
    for (let x = peakX - halfW; x <= peakX + halfW; x++) {
      if (grid.inBounds(x, y)) {
        setWorldMaterial(world, x, y, MaterialId.Stone);
      }
    }
  }
  // Dirt below the mountain base
  for (let x = peakX - mtnHalfBase; x <= peakX + mtnHalfBase; x++) {
    for (let y = mtnBaseY + 1; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Empty) {
        setWorldMaterial(world, x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Faucet at top-left ---
  // 10x6 object near top, start in full flow mode (vx=2)
  const faucetX = 18,
    faucetY = 2;
  const faucetObjectId = allocateObjectId(world);
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 10; dx++) {
      const x = faucetX + dx,
        y = faucetY + dy;
      if (grid.inBounds(x, y)) {
        setObjectMaterial(world, x, y, MaterialId.Faucet, faucetObjectId);
        grid.setFaucetFlow(x, y, 2);
      }
    }
  }

  // --- Drain on the lower dirt section ---
  // Place on the surface of the bottom terrain so water collects there
  const drainX = 80,
    drainY = 171;
  const drainObjectId = allocateObjectId(world);
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 20; dx++) {
      const x = drainX + dx,
        y = drainY + dy;
      if (grid.inBounds(x, y)) {
        setObjectMaterial(world, x, y, MaterialId.Drain, drainObjectId);
      }
    }
  }

  // --- Sand patch near the drain ---
  for (let x = 20; x < 60; x++) {
    for (let y = GRID_HEIGHT - 15; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Dirt) {
        setWorldMaterial(world, x, y, MaterialId.Sand);
      }
    }
  }
}
