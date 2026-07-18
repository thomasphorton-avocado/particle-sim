import { FLOWER_PALETTE, MATERIALS, MaterialId, MaterialPhase, type GameplayRandomState, type Grid, type WorldCellPlacementOptions, type WorldState, hashVisualShadeInRange, nextBool, nextFloat, nextInt, placeWorldCell } from "@particle-sim/shared";

function randDir(random: GameplayRandomState): 1 | -1 {
  return nextBool(random, 0.5) ? -1 : 1;
}

function setWorldCell(world: WorldState, grid: Grid, x: number, y: number, materialId: MaterialId, options?: WorldCellPlacementOptions): void {
  if (materialId === MaterialId.Empty) {
    grid.set(x, y, MaterialId.Empty);
    return;
  }
  placeWorldCell(world, x, y, materialId, options);
}

/** Runs one step of the cellular automaton over the whole grid. */
export function step(world: WorldState): void {
  const grid = world.grid;
  const random = world.random;
  grid.resetUpdated();

  // Bottom-to-top so a cell that falls this frame isn't re-processed lower down.
  for (let y = grid.height - 1; y >= 0; y--) {
    const leftToRight = nextBool(random, 0.5);
    for (let i = 0; i < grid.width; i++) {
      const x = leftToRight ? i : grid.width - 1 - i;
      if (grid.wasUpdated(x, y)) continue;

      const id = grid.get(x, y);
      const material = MATERIALS[id];

      switch (material.phase) {
        case MaterialPhase.Powder:
          if (id === MaterialId.Seed) {
            updateSeed(world, random, grid, x, y, material.density);
          } else {
            updatePowder(world, random, grid, x, y, material.density);
          }
          break;
        case MaterialPhase.Liquid:
          updateLiquid(world, random, grid, x, y, material.density, material.flowRate ?? 3);
          break;
        case MaterialPhase.Solid:
          if (id === MaterialId.Stem) {
            updateStemGrowth(world, random, grid, x, y);
          } else if (id === MaterialId.Faucet) {
            updateFaucet(world, random, grid, x, y);
          } else if (id === MaterialId.Sprinkler) {
            updateSprinkler(world, random, grid, x, y);
          } else if (id === MaterialId.Dirt) {
            updateDirt(world, random, grid, x, y);
          } else if (id === MaterialId.Grass) {
            updateGrass(world, random, grid, x, y);
          } else if (id === MaterialId.Flower) {
            updateFlower(world, random, grid, x, y);
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
 * Walks from (x, y) in direction (dx, dy), skipping over any permeable cells
 * in the way, and returns the first non-permeable cell found. Permeable solids
 * shouldn't dam up liquid, but liquid should never actually displace them.
 */
function skipPlants(
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
    if (!MATERIALS[id].permeable) return { x: cx, y: cy, id };
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
function tryFallPowder(random: GameplayRandomState, grid: Grid, x: number, y: number, density: number): boolean {
  const below = grid.get(x, y + 1);
  if (canDisplace(below, density)) {
    moveCell(grid, x, y, x, y + 1);
    return true;
  }

  const dir = randDir(random);
  for (const dx of [dir, -dir] as const) {
    const diag = grid.get(x + dx, y + 1);
    if (canDisplace(diag, density)) {
      moveCell(grid, x, y, x + dx, y + 1);
      return true;
    }
  }
  return false;
}

function updatePowder(_world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number, density: number): void {
  tryFallPowder(random, grid, x, y, density);
}

// Range of segments a stem grows before it blooms, randomized per seed so
// flowers end up a variety of heights rather than all identical.
const STEM_GROWTH_BUDGET_MIN = 4;
const STEM_GROWTH_BUDGET_MAX = 10;
// Per-step chance a growing tip attempts to grow, so stalks rise at a staggered, organic pace.
const STEM_GROW_CHANCE = 0.04;

function randomStemBudget(random: GameplayRandomState): number {
  const span = STEM_GROWTH_BUDGET_MAX - STEM_GROWTH_BUDGET_MIN + 1;
  return STEM_GROWTH_BUDGET_MIN + nextInt(random, span);
}

const SEED_GERMINATION_NEIGHBORS: [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

// Per-step chance a settled seed despawns if it can't germinate.
// ~0.003 gives an average lifespan of ~330 steps (~5-6 seconds at 60fps).
const SEED_DESPAWN_CHANCE = 0.003;

/** Falls like sand; once settled, sprouts in wet dirt or eventually despawns. */
function updateSeed(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number, density: number): void {
  if (tryFallPowder(random, grid, x, y, density)) return;

  // Seeds can push through grass — replace the grass cell below
  const below = grid.get(x, y + 1);
  if (below === MaterialId.Grass) {
    moveCell(grid, x, y, x, y + 1);
    // The grass cell is now at (x, y) — overwrite it with empty
    grid.set(x, y, MaterialId.Empty);
    grid.markUpdated(x, y);
    return;
  }

  // Check for adjacent wet dirt (or wet dirt through grass) to germinate
  for (const [dx, dy] of SEED_GERMINATION_NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    const nid = grid.get(nx, ny);
    if (nid === MaterialId.Dirt && grid.getDirtMoisture(nx, ny) > 0) {
      setWorldCell(world, grid, x, y, MaterialId.Stem);
      grid.setStemBudget(x, y, randomStemBudget(random));
      grid.markUpdated(x, y);
      return;
    }
    // Grass sitting on wet dirt also counts
    if (nid === MaterialId.Grass) {
      for (const [ddx, ddy] of ORTHOGONAL_NEIGHBORS) {
        const nnx = nx + ddx;
        const nny = ny + ddy;
        if (grid.get(nnx, nny) === MaterialId.Dirt && grid.getDirtMoisture(nnx, nny) > 0) {
          setWorldCell(world, grid, x, y, MaterialId.Stem);
          grid.setStemBudget(x, y, randomStemBudget(random));
          grid.markUpdated(x, y);
          return;
        }
      }
    }
  }

  // Despawn if sitting without wet dirt for too long
  if (nextBool(random, SEED_DESPAWN_CHANCE)) {
    grid.set(x, y, MaterialId.Empty);
    grid.markUpdated(x, y);
  }
}

/** BFS through connected stem/flower cells to find reachable dirt with moisture. */
function drainNearbyDirt(grid: Grid, x: number, y: number): boolean {
  // Direct neighbors first (fast path)
  for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (grid.get(nx, ny) === MaterialId.Dirt && grid.getDirtMoisture(nx, ny) > 0) {
      grid.setDirtMoisture(nx, ny, grid.getDirtMoisture(nx, ny) - 1);
      return true;
    }
  }
  // Walk through connected plant cells to reach distant dirt
  const visited = new Set<number>();
  const queue: number[] = [];
  const key = (cx: number, cy: number) => cy * grid.width + cx;
  const k0 = key(x, y);
  visited.add(k0);
  // Seed with adjacent stem/flower neighbors
  for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    const id = grid.get(nx, ny);
    if (id === MaterialId.Stem || id === MaterialId.Flower) {
      const k = key(nx, ny);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push(k);
      }
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const cx = cur % grid.width;
    const cy = (cur - cx) / grid.width;
    for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.inBounds(nx, ny)) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      const id = grid.get(nx, ny);
      if (id === MaterialId.Dirt && grid.getDirtMoisture(nx, ny) > 0) {
        grid.setDirtMoisture(nx, ny, grid.getDirtMoisture(nx, ny) - 1);
        return true;
      }
      if (id === MaterialId.Stem || id === MaterialId.Flower) {
        visited.add(k);
        queue.push(k);
      }
    }
  }
  return false;
}

/** Grows a stem upward one segment at a time until its budget runs out, then blooms. */
function updateStemGrowth(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  const budget = grid.getStemBudget(x, y);

  // Non-growing stem: no action needed
  if (budget <= 0) {
    return;
  }

  if (!nextBool(random, STEM_GROW_CHANCE)) return;

  // Growing stem consumes moisture to grow
  if (!drainNearbyDirt(grid, x, y)) return;

  const above = grid.get(x, y - 1);
  const canGrowInto = above === MaterialId.Empty || above === MaterialId.Water;

  if (budget <= 1 || !canGrowInto) {
    bloom(world, random, grid, x, y);
    return;
  }

  setWorldCell(world, grid, x, y - 1, MaterialId.Stem);
  grid.setStemBudget(x, y - 1, budget - 1);
  grid.markUpdated(x, y - 1);
  grid.setStemBudget(x, y, 0);
}

/** Turns a stem tip into a small flower head, in a random color from FLOWER_PALETTE. */
function bloom(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  const colorVariant = nextInt(random, FLOWER_PALETTE.length);

  const place = (px: number, py: number, shade?: number) => {
    if (grid.get(px, py) === MaterialId.Empty) {
      setWorldCell(world, grid, px, py, MaterialId.Flower, { shade });
      grid.setFlowerPalette(px, py, colorVariant);
    }
  };

  // Center — dark pistil
  setWorldCell(world, grid, x, y, MaterialId.Flower, { shade: -40 });
  grid.setFlowerPalette(x, y, colorVariant);

  // Inner ring — standard brightness
  const inner: [number, number][] = [
    [-1, 0], [1, 0], [0, -1],
    [-1, -1], [1, -1],
  ];
  for (const [dx, dy] of inner) {
    place(x + dx, y + dy, hashVisualShadeInRange(world.random.seed, x + dx, y + dy, MaterialId.Flower, colorVariant + 1, -5, 4));
  }

  // Outer petals — lighter tips for a softer edge
  const outer: [number, number][] = [
    [0, -2],
    [-2, -1], [2, -1],
    [-2, 0], [2, 0],
    [-1, 1], [1, 1],
  ];
  for (const [dx, dy] of outer) {
    place(x + dx, y + dy, hashVisualShadeInRange(world.random.seed, x + dx, y + dy, MaterialId.Flower, colorVariant + 2, 15, 24));
  }
}

/** Flower cells are now permanent — no withering. */
function updateFlower(_world: WorldState, _random: GameplayRandomState, _grid: Grid, _x: number, _y: number): void {
  // no-op: flowers no longer wilt
}

// Faucet flow states stored in vx: 0=off, 1=low, 2=high
const FAUCET_EMIT_CHANCES = [0, 0.15, 0.30];

/** Emits water below this faucet cell if it's at the bottom edge of the faucet body. */
function updateFaucet(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  const flowState = grid.getFaucetFlow(x, y);
  if (flowState <= 0) return;
  // Only emit from cells whose neighbor below isn't also faucet (bottom edge)
  if (grid.get(x, y + 1) === MaterialId.Faucet) return;
  const chance = FAUCET_EMIT_CHANCES[flowState] ?? 0;
  if (!nextBool(random, chance)) return;
  if (grid.get(x, y + 1) === MaterialId.Empty) {
    setWorldCell(world, grid, x, y + 1, MaterialId.Water);
    grid.markUpdated(x, y + 1);
  }
}

// Per-step chance a sprinkler top-edge cell emits a water droplet.
const SPRINKLER_EMIT_CHANCE = 0.04;

/** Emits water droplets upward in a parabolic arc from the top edge. */
function updateSprinkler(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  // Only act from the top edge
  if (grid.get(x, y - 1) === MaterialId.Sprinkler) return;
  if (!nextBool(random, SPRINKLER_EMIT_CHANCE)) return;

  // Simulate a point along a parabolic arc:
  // Pick a random "time" along the trajectory
  const dir = nextBool(random, 0.5) ? -1 : 1;
  const t = nextFloat(random);
  const range = 8 + nextInt(random, 16);
  const peakHeight = 6 + Math.floor(range * 0.3);

  const dx = Math.floor(t * range) * dir;
  // Parabolic height: peaks at t=0.3 (biased upward near source)
  const dy = -Math.floor(peakHeight * 4 * t * (1 - t));

  const tx = x + dx;
  const ty = y + dy;

  if (grid.inBounds(tx, ty) && grid.get(tx, ty) === MaterialId.Empty) {
    setWorldCell(world, grid, tx, ty, MaterialId.Water);
    // Give a small drift in spray direction so it flows outward
    grid.setWaterLiquidMemory(tx, ty, dir);
    grid.markUpdated(tx, ty);
  }
}

// Dirt moisture: vx stores moisture level 0 (dry) to DIRT_MAX_MOISTURE (saturated).
const DIRT_MAX_MOISTURE = 12;
// Per-step chance wet dirt wicks moisture to an adjacent dry dirt cell.
const DIRT_WICK_CHANCE = 0.04;
// Per-step chance wet dirt loses 1 moisture to evaporation.
const DIRT_DRY_CHANCE = 0.0025;
// Reduced evaporation rate when dirt is adjacent to grass.
const DIRT_DRY_CHANCE_GRASSED = 0.0008;

/** Absorbs adjacent water and wicks moisture to neighboring dry dirt. */
function updateDirt(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  const moisture = grid.getDirtMoisture(x, y);

  // Absorb adjacent water — dirt soaks it up and gains max moisture
  // Also looks through grass layers for water (grass is permeable)
  if (moisture < DIRT_MAX_MOISTURE) {
    for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nid = grid.get(nx, ny);
      if (nid === MaterialId.Water) {
        grid.set(nx, ny, MaterialId.Empty);
        grid.markUpdated(nx, ny);
        grid.setDirtMoisture(x, y, DIRT_MAX_MOISTURE);
        return;
      }
      // Check through grass: if neighbor is grass, look one cell further
      if (nid === MaterialId.Grass) {
        const fx = nx + dx;
        const fy = ny + dy;
        if (grid.get(fx, fy) === MaterialId.Water) {
          grid.set(fx, fy, MaterialId.Empty);
          grid.markUpdated(fx, fy);
          grid.setDirtMoisture(x, y, DIRT_MAX_MOISTURE);
          return;
        }
      }
    }
  }

  // Wick moisture to adjacent dry dirt (source loses 1, neighbor gains source-1)
  if (moisture > 2 && nextBool(random, DIRT_WICK_CHANCE)) {
    const dirs = [...ORTHOGONAL_NEIGHBORS];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = nextInt(random, i + 1);
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid.get(nx, ny) === MaterialId.Dirt && grid.getDirtMoisture(nx, ny) === 0) {
        grid.setDirtMoisture(nx, ny, moisture - 2);
        grid.setDirtMoisture(x, y, moisture - 1);
        grid.markUpdated(nx, ny);
        return;
      }
    }
  }

  // Slowly lose moisture over time (evaporation) — grass cover slows it
  if (moisture > 0) {
    let dryChance = DIRT_DRY_CHANCE;
    for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
      if (grid.get(x + dx, y + dy) === MaterialId.Grass) {
        dryChance = DIRT_DRY_CHANCE_GRASSED;
        break;
      }
    }
    if (nextBool(random, dryChance)) {
      grid.setDirtMoisture(x, y, moisture - 1);
    }
  }

  // Wet dirt can sprout grass on its top surface
  if (moisture >= 4 && nextBool(random, GRASS_SPROUT_CHANCE)) {
    const above = grid.get(x, y - 1);
    // Only on exposed top surface — block if standing water (water stacked 2+ deep)
    if (above === MaterialId.Empty ||
        (above === MaterialId.Water && grid.get(x, y - 2) !== MaterialId.Water)) {
      // Check this is actually the surface — dirt above means we're buried
      if (grid.get(x, y - 1) !== MaterialId.Dirt) {
        setWorldCell(world, grid, x, y, MaterialId.Grass);
        grid.markUpdated(x, y);
        // Preserve moisture — grass inherits it
        grid.setAuxiliaryValue(x, y, 0);
      }
    }
  }
}

// Per-step chance wet surface dirt converts to grass.
const GRASS_SPROUT_CHANCE = 0.001;

/** Grass can creep down into adjacent dirt (1-2 layers) and dies without moisture nearby. */
function updateGrass(world: WorldState, random: GameplayRandomState, grid: Grid, x: number, y: number): void {
  // Creep downward: convert dirt directly below into grass (max 2 deep)
  if (nextBool(random, 0.001)) {
    const below = grid.get(x, y + 1);
    if (below === MaterialId.Dirt && grid.getDirtMoisture(x, y + 1) > 0) {
      // Count how deep this grass layer already is
      let depth = 0;
      for (let dy = 0; dy <= 2; dy++) {
        if (grid.get(x, y - dy) === MaterialId.Grass) depth++;
        else break;
      }
      if (depth < 2) {
        setWorldCell(world, grid, x, y + 1, MaterialId.Grass);
        grid.markUpdated(x, y + 1);
      }
    }
  }

  // Die if no adjacent dirt has moisture and no adjacent grass is near moist dirt
  if (nextBool(random, 0.002)) {
    let hasMoisture = false;
    for (const [dx, dy] of ORTHOGONAL_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nid = grid.get(nx, ny);
      if (nid === MaterialId.Dirt && grid.getDirtMoisture(nx, ny) > 0) {
        hasMoisture = true;
        break;
      }
      // Adjacent grass counts if it's touching moist dirt
      if (nid === MaterialId.Grass) {
        for (const [ddx, ddy] of ORTHOGONAL_NEIGHBORS) {
          const nnid = grid.get(nx + ddx, ny + ddy);
          if (nnid === MaterialId.Dirt && grid.getDirtMoisture(nx + ddx, ny + ddy) > 0) {
            hasMoisture = true;
            break;
          }
        }
        if (hasMoisture) break;
      }
    }
    if (!hasMoisture) {
      setWorldCell(world, grid, x, y, MaterialId.Dirt);
      grid.setDirtMoisture(x, y, 0);
      grid.markUpdated(x, y);
    }
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
  _world: WorldState,
  random: GameplayRandomState,
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

  const below = skipPlants(grid, x, y, 0, 1);
  if (canDisplace(below.id, density)) {
    const vx = grid.getWaterLiquidMemory(x, y);
    const driftDir = vx !== 0 ? (vx > 0 ? 1 : -1) : randDir(random);
    // Falling water keeps a little drift from how it was already flowing
    // (inertia from spreading along a ledge before it dropped), plus rare
    // random turbulence, instead of always snapping straight down.
    let shouldTurbulence = false;
    if (vx !== 0) {
      if (nextBool(random, DRIFT_APPLY_CHANCE)) {
        shouldTurbulence = true;
      } else {
        shouldTurbulence = nextBool(random, FALL_TURBULENCE_CHANCE);
      }
    } else {
      shouldTurbulence = nextBool(random, FALL_TURBULENCE_CHANCE);
    }
    if (shouldTurbulence) {
      const diag = skipPlants(grid, x, y, driftDir, 1);
      if (canDisplace(diag.id, density)) {
        moveCell(grid, x, y, diag.x, diag.y);
        grid.setWaterLiquidMemory(diag.x, diag.y, nextBool(random, DRIFT_DECAY_CHANCE) ? 0 : driftDir);
        return;
      }
    }
    moveCell(grid, x, y, below.x, below.y);
    grid.setWaterLiquidMemory(below.x, below.y, nextBool(random, DRIFT_DECAY_CHANCE) ? 0 : vx);
    return;
  }

  const dir = randDir(random);
  for (const dx of [dir, -dir] as const) {
    const diag = skipPlants(grid, x, y, dx, 1);
    if (canDisplace(diag.id, density)) {
      moveCell(grid, x, y, diag.x, diag.y);
      // Decayed like the other fall-related writes, so a diagonal drop doesn't
      // leave behind a long-lived direction that later blocks sideways spread.
      grid.setWaterLiquidMemory(diag.x, diag.y, nextBool(random, DRIFT_DECAY_CHANCE) ? 0 : dx);
      return;
    }
  }

  // Spread sideways: find the farthest reachable empty cell in a random direction,
  // treating any stems in the way as see-through rather than a stopping obstacle.
  const lastJump = grid.getWaterLiquidMemory(x, y);
  for (const dx of [dir, -dir] as const) {
    let farthest = -1;
    for (let step = 1; step <= flowRate; step++) {
      const target = grid.get(x + dx * step, y);
      if (target === MaterialId.Empty) {
        farthest = step;
      } else if (MATERIALS[target].permeable) {
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
    grid.setWaterLiquidMemory(x + delta, y, nextBool(random, SPREAD_MEMORY_DECAY_CHANCE) ? 0 : delta);
    return;
  }

  // Nowhere left to go this step — fully settled. Only evaporates if exposed
  // to something other than water (air, a wall, a stem...); water buried
  // deep inside a pool, with water on every side, never evaporates.
  if (isExposed(grid, x, y) && nextBool(random, EVAPORATION_CHANCE)) {
    grid.set(x, y, MaterialId.Empty);
    grid.markUpdated(x, y);
  }
}
