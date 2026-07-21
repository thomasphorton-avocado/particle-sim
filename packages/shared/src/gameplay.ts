import { addToHotbar } from "./inventory.js";
import { type Grid } from "./grid.js";
import { type PlayerId } from "./ids.js";
import { MATERIALS, MaterialId, MaterialPhase } from "./materials.js";
import { stepMaterial } from "./material-step.js";
import { type PlayerState, type WorldState } from "./world-state.js";

export const GAMEPLAY_HZ = 60;
export const GAMEPLAY_DT = 1 / GAMEPLAY_HZ;
export const DAY_NIGHT_CYCLE_TICKS = 18_000;
export const SWING_DURATION_TICKS = 15;
export const FAUCET_BUMP_COOLDOWN_TICKS = 18;
export const COYOTE_TICKS = 5;

export interface PlayerInputState {
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  crouchHeld: boolean;
  lookUpHeld: boolean;
  mineHeld: boolean;
}

const DEFAULT_PLAYER_INPUT: PlayerInputState = {
  left: false,
  right: false,
  jumpHeld: false,
  crouchHeld: false,
  lookUpHeld: false,
  mineHeld: false,
};

const GRAVITY = 0.4;
const TERMINAL_VY = 3;
const MOVE_SPEED = 1.2;
const JUMP_VELOCITY = -3.5;
const MAX_FALL = 5;
const SWIM_GRAVITY = 0.05;
const SWIM_MAX_FALL = 0.75;
const SWIM_MOVE_SPEED = 0.7;
const SWIM_UP_VELOCITY = -1;

function isSolid(grid: Grid, gx: number, gy: number): boolean {
  if (!grid.inBounds(gx, gy)) return true;
  const id = grid.get(gx, gy) as MaterialId;
  if (id === MaterialId.Empty) return false;
  if (id === MaterialId.Torch) return false;
  const mat = MATERIALS[id];
  return mat.phase === MaterialPhase.Solid || mat.phase === MaterialPhase.Powder;
}

function collidesAt(grid: Grid, x: number, y: number, w: number, h: number): boolean {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + w - 0.01);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + h - 0.01);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (isSolid(grid, gx, gy)) return true;
    }
  }
  return false;
}

function waterCellCount(grid: Grid, player: PlayerState): number {
  let count = 0;
  const x0 = Math.floor(player.x);
  const x1 = Math.floor(player.x + player.width - 0.01);
  const y0 = Math.floor(player.y);
  const y1 = Math.floor(player.y + player.height - 0.01);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (grid.inBounds(gx, gy) && grid.get(gx, gy) === MaterialId.Water) count += 1;
    }
  }
  return count;
}

function getPlayerInput(inputs: Readonly<Record<string, PlayerInputState>> | undefined, playerId: PlayerId): PlayerInputState {
  const candidate = inputs?.[playerId];
  if (!candidate) return DEFAULT_PLAYER_INPUT;
  return {
    left: Boolean(candidate.left),
    right: Boolean(candidate.right),
    jumpHeld: Boolean(candidate.jumpHeld),
    crouchHeld: Boolean(candidate.crouchHeld),
    lookUpHeld: Boolean(candidate.lookUpHeld),
    mineHeld: Boolean(candidate.mineHeld),
  };
}

function hasPickaxeEquipped(player: PlayerState): boolean {
  return player.hotbar[player.activeHotbarSlot]?.kind === "pickaxe";
}

function pickaxeHeadCells(player: PlayerState, angle: number, out: Map<string, [number, number]>): void {
  const tiltOffset = player.lookingUp ? -4 : player.crouching ? 3 : 0;
  const sx = player.x + (player.facing === 1 ? player.width : 0);
  const sy = player.y + 2.5 + tiltOffset;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const floorLimit = (!player.lookingUp && !player.crouching)
    ? Math.floor(player.y + player.height)
    : Infinity;
  for (let lx = 0.5; lx <= 4.5; lx += 0.5) {
    for (let ly = -0.8; ly <= 0.8; ly += 0.8) {
      const wx = Math.floor(sx + player.facing * (lx * cos - ly * sin));
      const wy = Math.floor(sy + (lx * sin + ly * cos));
      if (wy >= floorLimit) continue;
      out.set(`${wx},${wy}`, [wx, wy]);
    }
  }
}

function swingAngle(progress: number): number {
  const startAngle = -Math.PI * 0.6;
  const endAngle = Math.PI * 0.2;
  return startAngle + (endAngle - startAngle) * progress;
}

function mineCellAt(_world: WorldState, player: PlayerState, grid: Grid, x: number, y: number, mined: Set<number>): void {
  if (!grid.inBounds(x, y)) return;
  const key = y * grid.width + x;
  if (mined.has(key)) return;
  const id = grid.get(x, y) as MaterialId;
  if (id === MaterialId.Empty || id === MaterialId.Water) return;
  const material = MATERIALS[id];
  const objectId = grid.getObjectId(x, y);

  if (material.placement.kind === "object") {
    if (objectId) {
      for (let i = 0; i < grid.objectIds.length; i++) {
        if (grid.objectIds[i] === objectId) {
          const cx = i % grid.width;
          const cy = Math.floor(i / grid.width);
          grid.set(cx, cy, MaterialId.Empty);
          grid.markUpdated(cx, cy);
        }
      }
      addToHotbar(player.hotbar, id);
      const name = material.name.toLowerCase();
      player.inventory[name] = (player.inventory[name] || 0) + 1;
      return;
    }

    const queue: [number, number][] = [[x, y]];
    mined.add(key);
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!;
      grid.set(cx, cy, MaterialId.Empty);
      grid.markUpdated(cx, cy);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
        if (!grid.inBounds(nx, ny)) continue;
        const nextKey = ny * grid.width + nx;
        if (mined.has(nextKey)) continue;
        if (grid.get(nx, ny) === id && grid.getObjectId(nx, ny) === null) {
          mined.add(nextKey);
          queue.push([nx, ny]);
        }
      }
    }
    addToHotbar(player.hotbar, id);
    const name = material.name.toLowerCase();
    player.inventory[name] = (player.inventory[name] || 0) + 1;
    return;
  }

  mined.add(key);
  const name = material.name.toLowerCase();
  player.inventory[name] = (player.inventory[name] || 0) + 1;
  if (id !== MaterialId.Stem && id !== MaterialId.Flower && id !== MaterialId.Grass) {
    addToHotbar(player.hotbar, id);
  }
  grid.set(x, y, MaterialId.Empty);
  grid.markUpdated(x, y);
}

function sweepMiningArc(world: WorldState, player: PlayerState, fromProgress: number, toProgress: number): void {
  if (fromProgress >= toProgress) return;
  const swept = new Map<string, [number, number]>();
  const step = 1 / SWING_DURATION_TICKS;
  for (let progress = fromProgress; progress <= toProgress + 1e-9; progress += step) {
    pickaxeHeadCells(player, swingAngle(Math.min(progress, 1)), swept);
  }
  const mined = new Set<number>();
  for (const [gx, gy] of swept.values()) {
    mineCellAt(world, player, world.grid, gx, gy, mined);
  }
}

function handleSwing(world: WorldState, player: PlayerState, input: PlayerInputState): void {
  if (!hasPickaxeEquipped(player)) return;
  const active = player.swingElapsedTicks !== null;
  const previousElapsed = active ? player.swingElapsedTicks! : 0;
  const previousProgress = Math.min(previousElapsed / SWING_DURATION_TICKS, 1);
  const segments: Array<[number, number]> = [];

  if (!active && input.mineHeld) {
    player.swingElapsedTicks = 1;
    segments.push([0, 1 / SWING_DURATION_TICKS]);
  } else if (active) {
    const nextElapsed = previousElapsed + 1;
    if (nextElapsed >= SWING_DURATION_TICKS) {
      segments.push([previousProgress, 1]);
      if (input.mineHeld) {
        player.swingElapsedTicks = 1;
        segments.push([0, 1 / SWING_DURATION_TICKS]);
      } else {
        player.swingElapsedTicks = null;
      }
    } else {
      player.swingElapsedTicks = nextElapsed;
      segments.push([previousProgress, nextElapsed / SWING_DURATION_TICKS]);
    }
  }

  for (const [fromProgress, toProgress] of segments) {
    sweepMiningArc(world, player, fromProgress, toProgress);
  }
}

function checkFaucetBump(world: WorldState, player: PlayerState): void {
  if (player.faucetCooldownUntilTick > world.tick) return;
  const headY = Math.floor(player.y) - 1;
  if (headY < 0) return;
  const x0 = Math.floor(player.x);
  const x1 = Math.floor(player.x + player.width - 0.01);
  const checkedRows = [...new Set([headY, Math.floor(player.y)])];
  const seedCells: [number, number][] = [];
  for (const checkY of checkedRows) {
    for (let gx = x0; gx <= x1; gx++) {
      if (world.grid.inBounds(gx, checkY) && world.grid.get(gx, checkY) === MaterialId.Faucet) {
        seedCells.push([gx, checkY]);
      }
    }
  }
  if (seedCells.length === 0) return;
  const visited = new Set<number>();
  const visitedCells: [number, number][] = [];
  const queue = [...seedCells];
  while (queue.length > 0) {
    const [fx, fy] = queue.pop()!;
    const idx = fy * world.grid.width + fx;
    if (visited.has(idx)) continue;
    visited.add(idx);
    visitedCells.push([fx, fy]);
    for (const [nx, ny] of [[fx - 1, fy], [fx + 1, fy], [fx, fy - 1], [fx, fy + 1]] as const) {
      if (world.grid.inBounds(nx, ny) && world.grid.get(nx, ny) === MaterialId.Faucet && !visited.has(ny * world.grid.width + nx)) {
        queue.push([nx, ny]);
      }
    }
  }
  const firstCell = seedCells[0]!;
  const [firstX, firstY] = firstCell;
  const currentState = world.grid.getFaucetFlow(firstX, firstY);
  const newState = (currentState + 1) % 3;
  for (const [fx, fy] of visitedCells) {
    world.grid.setFaucetFlow(fx, fy, newState);
  }
  player.faucetCooldownUntilTick = world.tick + FAUCET_BUMP_COOLDOWN_TICKS;
}

function advancePlayer(world: WorldState, player: PlayerState, input: PlayerInputState): void {
  const grid = world.grid;
  const waterCells = waterCellCount(grid, player);
  player.swimming = waterCells >= 3;
  player.crouching = input.crouchHeld;
  player.lookingUp = input.lookUpHeld;

  const speed = player.swimming ? SWIM_MOVE_SPEED : MOVE_SPEED;
  let moveX = 0;
  if (input.left) {
    moveX -= speed;
    player.facing = -1;
  }
  if (input.right) {
    moveX += speed;
    player.facing = 1;
  }

  const gravity = player.swimming ? SWIM_GRAVITY : GRAVITY;
  const maxFall = player.swimming ? SWIM_MAX_FALL : MAX_FALL;
  player.vy += gravity;
  if (player.vy > maxFall) player.vy = maxFall;

  if (player.swimming) {
    const jumpPressed = input.jumpHeld && !player.previousJumpHeld;
    if (input.jumpHeld) {
      const headY = Math.floor(player.y);
      const x0 = Math.floor(player.x);
      const x1 = Math.floor(player.x + player.width - 0.01);
      let waterInTopRows = 0;
      for (let rowOff = 0; rowOff <= 1; rowOff++) {
        for (let gx = x0; gx <= x1; gx++) {
          if (grid.inBounds(gx, headY + rowOff) && grid.get(gx, headY + rowOff) === MaterialId.Water) {
            waterInTopRows += 1;
          }
        }
      }
      const topCellCount = (x1 - x0 + 1) * 2;
      if (jumpPressed && waterInTopRows <= topCellCount / 2) {
        player.vy = JUMP_VELOCITY;
      } else {
        player.vy = SWIM_UP_VELOCITY;
      }
    }
  } else {
    if (player.grounded) {
      player.airTicks = 0;
    } else {
      player.airTicks += 1;
    }
    const jumpPressed = input.jumpHeld && !player.previousJumpHeld;
    if (jumpPressed && (player.grounded || player.airTicks <= COYOTE_TICKS)) {
      player.vy = JUMP_VELOCITY;
      player.grounded = false;
      player.airTicks = COYOTE_TICKS + 1;
    }
  }

  const newX = player.x + moveX;
  if (!collidesAt(grid, newX, player.y, player.width, player.height)) {
    player.x = newX;
  } else if (player.swingElapsedTicks === null) {
    for (let stepUp = 1; stepUp <= 2; stepUp++) {
      if (!collidesAt(grid, newX, player.y - stepUp, player.width, player.height)) {
        player.x = newX;
        player.y -= stepUp;
        break;
      }
    }
  }

  const newY = player.y + player.vy;
  if (!collidesAt(grid, player.x, newY, player.width, player.height)) {
    player.y = newY;
    player.grounded = false;
  } else {
    if (player.vy > 0) {
      player.y = Math.floor(newY + player.height) - player.height;
      while (collidesAt(grid, player.x, player.y, player.width, player.height) && player.y > 0) {
        player.y -= 1;
      }
      player.grounded = true;
    } else {
      player.y = Math.ceil(newY);
      while (collidesAt(grid, player.x, player.y, player.width, player.height) && player.y < grid.height - player.height) {
        player.y += 1;
      }
      checkFaucetBump(world, player);
    }
    player.vy = 0;
  }

  if (player.x < 0) {
    player.x = 0;
  }
  if (player.x + player.width > grid.width) {
    player.x = grid.width - player.width;
  }
  if (player.y < 0) {
    player.y = 0;
    player.vy = 0;
  }
  if (player.y + player.height > grid.height) {
    player.y = grid.height - player.height;
    player.vy = 0;
    player.grounded = true;
  }

  handleSwing(world, player, input);
  player.previousJumpHeld = input.jumpHeld;
}

function advanceFallingObjects(world: WorldState): void {
  const grid = world.grid;
  const objectEntries = Object.entries(world.fallingObjects)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [objectId, objectState] of objectEntries) {
    objectState.vy = Math.min(objectState.vy + GRAVITY, TERMINAL_VY);
    objectState.y += objectState.vy;
    if (objectState.y >= objectState.restY) {
      for (const [dx, dy] of objectState.offsets) {
        const x = objectState.x + dx;
        const y = objectState.restY + dy;
        if (grid.inBounds(x, y)) {
          grid.set(x, y, objectState.materialId, { objectId: objectState.id });
          grid.markUpdated(x, y);
        }
      }
      delete world.fallingObjects[objectId];
    }
  }
}

export function advanceWorldTick(world: WorldState, inputs: Readonly<Record<string, PlayerInputState>> = {}): boolean {
  if (world.paused) return false;

  world.time.dayNightTick = (world.time.dayNightTick + 1) % DAY_NIGHT_CYCLE_TICKS;
  world.time.dayNightCycle = world.time.dayNightTick / DAY_NIGHT_CYCLE_TICKS;

  stepMaterial(world);

  const playerIds = Object.keys(world.players).sort((left, right) => left < right ? -1 : left > right ? 1 : 0) as PlayerId[];
  for (const playerId of playerIds) {
    const player = world.players[playerId];
    if (!player) continue;
    advancePlayer(world, player, getPlayerInput(inputs, playerId));
  }

  advanceFallingObjects(world);

  world.tick += 1;
  return true;
}

export function normalizePlayerInput(input: Partial<PlayerInputState> | undefined): PlayerInputState {
  const base = { ...DEFAULT_PLAYER_INPUT };
  if (!input) return base;
  return {
    left: Boolean(input.left),
    right: Boolean(input.right),
    jumpHeld: Boolean(input.jumpHeld),
    crouchHeld: Boolean(input.crouchHeld),
    lookUpHeld: Boolean(input.lookUpHeld),
    mineHeld: Boolean(input.mineHeld),
  };
}
