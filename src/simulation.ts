import { Grid } from "./grid";
import { FLOWER_PALETTE, MATERIALS, MaterialId, MaterialPhase } from "./materials";

function randDir(): 1 | -1 {
  return Math.random() < 0.5 ? -1 : 1;
}

/** Runs one step of the cellular automaton over the whole grid. */
export function step(grid: Grid): void {
  grid.resetUpdated();

  // Bottom-to-top so a cell that falls this frame isn't re-processed lower down.
  for (let y = grid.height - 1; y >= 0; y--) {
    const leftToRight = Math.random() < 0.5;
    for (let i = 0; i < grid.width; i++) {
      const x = leftToRight ? i : grid.width - 1 - i;
      if (grid.wasUpdated(x, y)) continue;

      const id = grid.get(x, y);
      const material = MATERIALS[id];

      switch (material.phase) {
        case MaterialPhase.Powder:
          if (id === MaterialId.Seed) {
            updateSeed(grid, x, y, material.density);
          } else {
            updatePowder(grid, x, y, material.density);
          }
          break;
        case MaterialPhase.Liquid:
          updateLiquid(grid, x, y, material.density, material.flowRate ?? 3);
          break;
        case MaterialPhase.Solid:
          if (id === MaterialId.Stem) {
            updateStemGrowth(grid, x, y);
          } else if (id === MaterialId.Faucet) {
            updateFaucet(grid, x, y);
          }
          break;
        // Gas (empty) cells never act on their own.
      }
    }
  }
}

function canDisplace(target: MaterialId, movingDensity: number): boolean {
  if (target === MaterialId.Empty) return true;
  const targetMaterial = MATERIALS[target];
  return (
    targetMaterial.phase === MaterialPhase.Liquid &&
    movingDensity > targetMaterial.density
  );
}

// Generous upper bound on how many consecutive thin stems liquid will look past
// (comfortably taller than a fully grown stem) when finding where to flow.
const MAX_STEM_SKIP = 8;

/**
 * Walks from (x, y) in direction (dx, dy), skipping over any stem cells in the
 * way, and returns the first non-stem cell found. Stems are thin plant growth
 * and shouldn't dam up liquid, but liquid should never actually displace them.
 */
function skipStems(
  grid: Grid,
  x: number,
  y: number,
  dx: number,
  dy: number,
): { x: number; y: number; id: MaterialId } {
  let cx = x + dx;
  let cy = y + dy;
  for (let i = 0; i < MAX_STEM_SKIP; i++) {
    const id = grid.get(cx, cy);
    if (id !== MaterialId.Stem) return { x: cx, y: cy, id };
    cx += dx;
    cy += dy;
  }
  return { x: cx, y: cy, id: grid.get(cx, cy) };
}

function moveCell(grid: Grid, x: number, y: number, nx: number, ny: number): void {
  grid.swap(x, y, nx, ny);
  grid.markUpdated(nx, ny);
  grid.markUpdated(x, y);
}

/** Attempts to fall straight down or diagonally; returns whether it moved. */
function tryFallPowder(grid: Grid, x: number, y: number, density: number): boolean {
  const below = grid.get(x, y + 1);
  if (canDisplace(below, density)) {
    moveCell(grid, x, y, x, y + 1);
    return true;
  }

  const dir = randDir();
  for (const dx of [dir, -dir] as const) {
    const diag = grid.get(x + dx, y + 1);
    if (canDisplace(diag, density)) {
      moveCell(grid, x, y, x + dx, y + 1);
      return true;
    }
  }
  return false;
}

function updatePowder(grid: Grid, x: number, y: number, density: number): void {
  tryFallPowder(grid, x, y, density);
}

// Range of segments a stem grows before it blooms, randomized per seed so
// flowers end up a variety of heights rather than all identical.
const STEM_GROWTH_BUDGET_MIN = 4;
const STEM_GROWTH_BUDGET_MAX = 10;
// Per-step chance a growing tip attempts to grow, so stalks rise at a staggered, organic pace.
const STEM_GROW_CHANCE = 0.04;

function randomStemBudget(): number {
  const span = STEM_GROWTH_BUDGET_MAX - STEM_GROWTH_BUDGET_MIN + 1;
  return STEM_GROWTH_BUDGET_MIN + Math.floor(Math.random() * span);
}

const SEED_GERMINATION_NEIGHBORS: [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** Falls like sand; once settled, sprouts into a growing stem if touching water. */
function updateSeed(grid: Grid, x: number, y: number, density: number): void {
  if (tryFallPowder(grid, x, y, density)) return;

  for (const [dx, dy] of SEED_GERMINATION_NEIGHBORS) {
    if (grid.get(x + dx, y + dy) === MaterialId.Water) {
      grid.set(x + dx, y + dy, MaterialId.Empty);
      grid.set(x, y, MaterialId.Stem);
      grid.setVx(x, y, randomStemBudget());
      grid.markUpdated(x, y);
      return;
    }
  }
}

/** Grows a stem upward one segment at a time until its budget runs out, then blooms. */
function updateStemGrowth(grid: Grid, x: number, y: number): void {
  const budget = grid.getVx(x, y);
  if (budget <= 0) return;
  if (Math.random() >= STEM_GROW_CHANCE) return;

  const above = grid.get(x, y - 1);
  const canGrowInto = above === MaterialId.Empty || above === MaterialId.Water;

  if (budget <= 1 || !canGrowInto) {
    bloom(grid, x, y);
    return;
  }

  grid.set(x, y - 1, MaterialId.Stem);
  grid.setVx(x, y - 1, budget - 1);
  grid.markUpdated(x, y - 1);
  grid.setVx(x, y, 0);
}

/** Turns a stem tip into a small flower head, in a random color from FLOWER_PALETTE. */
function bloom(grid: Grid, x: number, y: number): void {
  const colorVariant = Math.floor(Math.random() * FLOWER_PALETTE.length);

  const place = (px: number, py: number, shade?: number) => {
    if (grid.get(px, py) === MaterialId.Empty) {
      grid.set(px, py, MaterialId.Flower, shade);
      grid.setVx(px, py, colorVariant);
    }
  };

  // Center — dark pistil
  grid.set(x, y, MaterialId.Flower, -40);
  grid.setVx(x, y, colorVariant);

  // Inner ring — standard brightness
  const inner: [number, number][] = [
    [-1, 0], [1, 0], [0, -1],
    [-1, -1], [1, -1],
  ];
  for (const [dx, dy] of inner) {
    place(x + dx, y + dy, ((Math.random() * 10) | 0) - 5);
  }

  // Outer petals — lighter tips for a softer edge
  const outer: [number, number][] = [
    [0, -2],
    [-2, -1], [2, -1],
    [-2, 0], [2, 0],
    [-1, 1], [1, 1],
  ];
  for (const [dx, dy] of outer) {
    place(x + dx, y + dy, 15 + ((Math.random() * 10) | 0));
  }
}

// Faucet flow states stored in vx: 0=off, 1=low, 2=high
const FAUCET_EMIT_CHANCES = [0, 0.15, 0.30];

/** Emits water below this faucet cell if it's at the bottom edge of the faucet body. */
function updateFaucet(grid: Grid, x: number, y: number): void {
  const flowState = grid.getVx(x, y);
  if (flowState <= 0) return;
  // Only emit from cells whose neighbor below isn't also faucet (bottom edge)
  if (grid.get(x, y + 1) === MaterialId.Faucet) return;
  const chance = FAUCET_EMIT_CHANCES[flowState] ?? 0;
  if (Math.random() >= chance) return;
  if (grid.get(x, y + 1) === MaterialId.Empty) {
    grid.set(x, y + 1, MaterialId.Water);
    grid.markUpdated(x, y + 1);
  }
}

// Chance a free-falling liquid cell nudges diagonally even with no prior
// drift, so long vertical drops fan out instead of staying a razor-straight line.
const FALL_TURBULENCE_CHANCE = 0.012;
// Chance inherited horizontal drift is actually applied on a given step,
// once present (keeps the effect subtle rather than drifting every frame).
const DRIFT_APPLY_CHANCE = 0.1;
// Chance inherited horizontal drift dies out on a given step, so streams
// eventually straighten out again rather than drifting forever.
const DRIFT_DECAY_CHANCE = 0.2;
// How fast the sideways-spread "last direction" memory fades. Kept much
// shorter-lived than fall drift so the anti-oscillation guard only blocks an
// immediate double-back, not normal back-and-forth leveling as a pool settles.
const SPREAD_MEMORY_DECAY_CHANCE = 0.75;
// Per-step chance a fully settled, exposed liquid cell evaporates. Only
// rolled once a cell has nowhere left to fall, slide, or spread to, so
// flowing water never evaporates mid-flow — only water that's come to rest.
const EVAPORATION_CHANCE = 0.0006;

const ORTHOGONAL_NEIGHBORS: [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** True if at least one neighbor isn't water — i.e. this cell is at a surface, not buried inside a pool. */
function isExposed(grid: Grid, x: number, y: number): boolean {
  for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
    if (grid.get(x + dx, y + dy) !== MaterialId.Water) return true;
  }
  return false;
}

function updateLiquid(
  grid: Grid,
  x: number,
  y: number,
  density: number,
  flowRate: number,
): void {
  // Water touching a drain is sucked away immediately, before any normal movement.
  for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
    if (grid.get(x + dx, y + dy) === MaterialId.Drain) {
      grid.set(x, y, MaterialId.Empty);
      grid.markUpdated(x, y);
      return;
    }
  }

  const below = skipStems(grid, x, y, 0, 1);
  if (canDisplace(below.id, density)) {
    const vx = grid.getVx(x, y);
    const driftDir = vx !== 0 ? (vx > 0 ? 1 : -1) : randDir();
    // Falling water keeps a little drift from how it was already flowing
    // (inertia from spreading along a ledge before it dropped), plus rare
    // random turbulence, instead of always snapping straight down.
    if ((vx !== 0 && Math.random() < DRIFT_APPLY_CHANCE) || Math.random() < FALL_TURBULENCE_CHANCE) {
      const diag = skipStems(grid, x, y, driftDir, 1);
      if (canDisplace(diag.id, density)) {
        moveCell(grid, x, y, diag.x, diag.y);
        grid.setVx(diag.x, diag.y, Math.random() < DRIFT_DECAY_CHANCE ? 0 : driftDir);
        return;
      }
    }
    moveCell(grid, x, y, below.x, below.y);
    grid.setVx(below.x, below.y, Math.random() < DRIFT_DECAY_CHANCE ? 0 : vx);
    return;
  }

  const dir = randDir();
  for (const dx of [dir, -dir] as const) {
    const diag = skipStems(grid, x, y, dx, 1);
    if (canDisplace(diag.id, density)) {
      moveCell(grid, x, y, diag.x, diag.y);
      // Decayed like the other fall-related writes, so a diagonal drop doesn't
      // leave behind a long-lived direction that later blocks sideways spread.
      grid.setVx(diag.x, diag.y, Math.random() < DRIFT_DECAY_CHANCE ? 0 : dx);
      return;
    }
  }

  // Spread sideways: find the farthest reachable empty cell in a random direction,
  // treating any stems in the way as see-through rather than a stopping obstacle.
  const lastJump = grid.getVx(x, y);
  for (const dx of [dir, -dir] as const) {
    let farthest = -1;
    for (let step = 1; step <= flowRate; step++) {
      const target = grid.get(x + dx * step, y);
      if (target === MaterialId.Empty) {
        farthest = step;
      } else if (target === MaterialId.Stem) {
        continue;
      } else {
        break;
      }
    }
    if (farthest <= 0) continue;

    const delta = dx * farthest;
    // Only refuse the exact move that would undo the jump that just brought
    // this cell here — a different-length or different-direction move is
    // still allowed. Without this a droplet with open space on both sides
    // (e.g. flanking a stem) can ping-pong back and forth forever; blocking
    // the whole direction (rather than just the exact undo) was overkill and
    // made normal pool leveling feel sticky.
    if (delta === -lastJump) continue;

    moveCell(grid, x, y, x + delta, y);
    grid.setVx(x + delta, y, Math.random() < SPREAD_MEMORY_DECAY_CHANCE ? 0 : delta);
    return;
  }

  // Nowhere left to go this step — fully settled. Only evaporates if exposed
  // to something other than water (air, a wall, a stem...); water buried
  // deep inside a pool, with water on every side, never evaporates.
  if (isExposed(grid, x, y) && Math.random() < EVAPORATION_CHANCE) {
    grid.set(x, y, MaterialId.Empty);
    grid.markUpdated(x, y);
  }
}
