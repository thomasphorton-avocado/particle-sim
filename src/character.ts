import { Grid, MATERIALS, MaterialId, MaterialPhase, type PlayerId, type PlayerState } from "@particle-sim/shared";
import { state, addToHotbar, getLocalPlayer, hasPickaxeEquipped } from "./state";

// Pickaxe swing animation + mining arc (shared by update/mining and draw)
const SWING_DURATION = 250; // ms
const SWING_START_ANGLE = -Math.PI * 0.6; // raised, up-and-back
const SWING_END_ANGLE = Math.PI * 0.2; // forward-and-down
function swingAngle(progress: number): number {
  return SWING_START_ANGLE + (SWING_END_ANGLE - SWING_START_ANGLE) * progress;
}

export interface CharacterRuntime {
  playerId: PlayerId;
  /** Pickaxe swing animation start time, null if not swinging. */
  swingStart: number | null;
  /** Swing progress (0..1) already processed for mining, to sweep the arc across frames. */
  swingMinedProgress: number;
  /** Whether the mine button is held, to auto-repeat swings. */
  swingHeld: boolean;
}

// Physics constants (tuned at 60 fps baseline).
// dt is normalized to frame-units so these stay as originally tuned.
const BASE_FPS = 60;
const GRAVITY = 0.4; // cells/frame²
const MOVE_SPEED = 1.2; // cells/frame
const JUMP_VELOCITY = -3.5; // cells/frame (impulse)
const MAX_FALL = 5; // cells/frame (terminal velocity)
const COYOTE_TIME_S = 5 / BASE_FPS; // ~83ms coyote window

// Swimming constants
const SWIM_GRAVITY = 0.05; // reduced gravity underwater
const SWIM_MAX_FALL = 0.75; // slower sinking
const SWIM_MOVE_SPEED = 0.7; // slower horizontal movement
const SWIM_UP_VELOCITY = -1.0; // swim upward impulse (repeatable)

/** Returns true if the given grid cell is solid ground the character can stand on. */
function isSolid(grid: Grid, gx: number, gy: number): boolean {
  if (!grid.inBounds(gx, gy)) return true; // treat OOB as solid (floor/walls)
  const id = grid.get(gx, gy) as MaterialId;
  if (id === MaterialId.Empty) return false;
  if (id === MaterialId.Torch) return false; // torches are walk-through decorations
  const mat = MATERIALS[id];
  // Solid phase or powder (sand) counts as ground
  return mat.phase === MaterialPhase.Solid || mat.phase === MaterialPhase.Powder;
}

/** Check if a rectangular area collides with any solid cell. */
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

export function createCharacter(grid: Grid): CharacterRuntime {
  const player = getLocalPlayer();
  player.x = Math.floor(grid.width / 2) - 1;
  player.y = 10;
  player.vx = 0;
  player.vy = 0;
  player.width = 3;
  player.height = 5;
  player.grounded = false;
  player.facing = 1;
  player.airTime = 0;
  player.crouching = false;
  player.lookingUp = false;
  player.swimming = false;
  return {
    playerId: player.id,
    swingStart: null,
    swingMinedProgress: 0,
    swingHeld: false,
  };
}

export interface CharacterInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  lookUp: boolean;
}

const keys: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false };
const touchControls: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false };
let jumpHeld = false;

function inputState(control: keyof CharacterInput): boolean {
  return keys[control] || touchControls[control];
}

export function setTouchControl(control: keyof CharacterInput, pressed: boolean): void {
  touchControls[control] = pressed;
  if (control === "jump" && !pressed) {
    jumpHeld = false;
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function attachCharacterInput(): void {
  window.addEventListener("keydown", (e) => {
    if (isEditable(e.target)) return;
    let handled = false;
    if (e.key === "ArrowLeft" || e.key === "a") {
      keys.left = true;
      handled = true;
    }
    if (e.key === "ArrowRight" || e.key === "d") {
      keys.right = true;
      handled = true;
    }
    if (e.key === " ") {
      keys.jump = true;
      handled = true;
    }
    if (e.key === "ArrowUp" || e.key === "w") {
      keys.lookUp = true;
      handled = true;
    }
    if (e.key === "ArrowDown" || e.key === "s") {
      keys.crouch = true;
      handled = true;
    }
    if (handled) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => {
    if (isEditable(e.target)) return;
    if (e.key === "ArrowLeft" || e.key === "a") keys.left = false;
    if (e.key === "ArrowRight" || e.key === "d") keys.right = false;
    if (e.key === " ") {
      keys.jump = false;
      jumpHeld = false;
    }
    if (e.key === "ArrowUp" || e.key === "w") keys.lookUp = false;
    if (e.key === "ArrowDown" || e.key === "s") keys.crouch = false;
  });
}

let lastFaucetBumpTime = 0;

/** When the character bumps its head, check for faucet cells above and cycle their state. */
function checkFaucetBump(grid: Grid, player: PlayerState): void {
  // Debounce: only trigger once per 300ms
  const now = performance.now();
  if (now - lastFaucetBumpTime < 300) return;

  const headY = Math.floor(player.y) - 1; // row just above head
  if (headY < 0) return;
  const x0 = Math.floor(player.x);
  const x1 = Math.floor(player.x + player.width - 0.01);
  const checkedRows = [...new Set([headY, Math.floor(player.y)])];
  const seedCells: [number, number][] = [];
  // Check the row above and the row at the very top of hitbox
  for (const checkY of checkedRows) {
    for (let gx = x0; gx <= x1; gx++) {
      if (grid.inBounds(gx, checkY) && grid.get(gx, checkY) === MaterialId.Faucet) {
        seedCells.push([gx, checkY]);
      }
    }
  }
  if (seedCells.length === 0) return;
  // Cycle all connected faucet cells: 0→1→2→0
  const visited = new Set<number>();
  const visitedCells: [number, number][] = [];
  const queue = [...seedCells];
  while (queue.length > 0) {
    const [fx, fy] = queue.pop()!;
    const idx = fy * grid.width + fx;
    if (visited.has(idx)) continue;
    visited.add(idx);
    visitedCells.push([fx, fy]);
    // Check neighbors
    for (const [nx, ny] of [[fx - 1, fy], [fx + 1, fy], [fx, fy - 1], [fx, fy + 1]]) {
      if (grid.inBounds(nx, ny) && grid.get(nx, ny) === MaterialId.Faucet && !visited.has(ny * grid.width + nx)) {
        queue.push([nx, ny]);
      }
    }
  }
  // Get current state from any cell and cycle
  const firstCell = seedCells[0]!;
  const [firstX, firstY] = firstCell;
  const currentState = grid.getFaucetFlow(firstX, firstY);
  const newState = (currentState + 1) % 3;
  for (const [fx, fy] of visitedCells) {
    grid.setFaucetFlow(fx, fy, newState);
  }
  lastFaucetBumpTime = now;
}

/** Check how many cells in the character's hitbox are water. */
function waterCellCount(grid: Grid, player: PlayerState): number {
  let count = 0;
  const x0 = Math.floor(player.x);
  const x1 = Math.floor(player.x + player.width - 0.01);
  const y0 = Math.floor(player.y);
  const y1 = Math.floor(player.y + player.height - 0.01);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (grid.inBounds(gx, gy) && grid.get(gx, gy) === MaterialId.Water) {
        count++;
      }
    }
  }
  return count;
}

export function updateCharacter(player: PlayerState, runtime: CharacterRuntime, grid: Grid, dt: number): void {
  // Normalize dt to frame-units (1.0 = one 60fps frame) and clamp for tab-switch
  const dtFrames = Math.min(dt * BASE_FPS, 3);

  // Detect swimming: submerged if 3+ cells are water (~20% of the 3×5 hitbox; feet/lower body in water)
  const waterCells = waterCellCount(grid, player);
  player.swimming = waterCells >= 3;

  // Crouch / look up state
  player.crouching = inputState("crouch");
  player.lookingUp = inputState("lookUp");

  // Horizontal movement (slower in water)
  const speed = player.swimming ? SWIM_MOVE_SPEED : MOVE_SPEED;
  let moveX = 0;
  if (inputState("left")) { moveX -= speed * dtFrames; player.facing = -1; }
  if (inputState("right")) { moveX += speed * dtFrames; player.facing = 1; }

  // Apply gravity (reduced in water)
  const gravity = player.swimming ? SWIM_GRAVITY : GRAVITY;
  const maxFall = player.swimming ? SWIM_MAX_FALL : MAX_FALL;
  player.vy += gravity * dtFrames;
  if (player.vy > maxFall) player.vy = maxFall;

  // Swimming: space to swim upward (repeatable, no jumpHeld gate)
  if (player.swimming && inputState("jump")) {
    // Check if near the surface (top 2 rows of character are not fully submerged)
    const headY = Math.floor(player.y);
    const x0 = Math.floor(player.x);
    const x1 = Math.floor(player.x + player.width - 0.01);
    let waterInTopRows = 0;
    for (let rowOff = 0; rowOff <= 1; rowOff++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (grid.inBounds(gx, headY + rowOff) && grid.get(gx, headY + rowOff) === MaterialId.Water) {
          waterInTopRows++;
        }
      }
    }
    // Near surface if fewer than half of top 2 rows are water
    const topCellCount = (x1 - x0 + 1) * 2;
    if (waterInTopRows <= topCellCount / 2 && !jumpHeld) {
      // Near surface — do a full jump out of the water
      player.vy = JUMP_VELOCITY;
      jumpHeld = true;
    } else {
      player.vy = SWIM_UP_VELOCITY;
    }
  } else {
    // Track air time for coyote time (in seconds)
    if (player.grounded) {
      player.airTime = 0;
    } else {
      player.airTime += dt;
    }

    // Jump (with coyote time) - only when not swimming
    if (!player.swimming && inputState("jump") && !jumpHeld && (player.grounded || player.airTime <= COYOTE_TIME_S)) {
      player.vy = JUMP_VELOCITY;
      player.grounded = false;
      player.airTime = COYOTE_TIME_S + 1; // prevent double-jump
      jumpHeld = true;
    }
  }

  // Move horizontally with collision
  const newX = player.x + moveX;
  if (!collidesAt(grid, newX, player.y, player.width, player.height)) {
    player.x = newX;
  } else if (runtime.swingStart === null) {
    // Try to step up 1-2 cells (slope/stair climbing).
    // Disabled while swinging so you mine into ledges instead of climbing them.
    for (let stepUp = 1; stepUp <= 2; stepUp++) {
      if (!collidesAt(grid, newX, player.y - stepUp, player.width, player.height)) {
        player.x = newX;
        player.y -= stepUp;
        break;
      }
    }
  }

  // Move vertically with collision
  const newY = player.y + player.vy * dtFrames;
  if (!collidesAt(grid, player.x, newY, player.width, player.height)) {
    player.y = newY;
    player.grounded = false;
  } else {
    // Resolve: find the nearest non-colliding position
    if (player.vy > 0) {
      // Falling — snap to top of ground
      player.y = Math.floor(newY + player.height) - player.height;
      // Fine adjustment: move up until not colliding
      while (collidesAt(grid, player.x, player.y, player.width, player.height) && player.y > 0) {
        player.y -= 1;
      }
      player.grounded = true;
    } else {
      // Hitting ceiling — snap below the ceiling
      player.y = Math.ceil(newY);
      while (collidesAt(grid, player.x, player.y, player.width, player.height) && player.y < grid.height - player.height) {
        player.y += 1;
      }
      // Check if we hit a faucet after resolving the final head position.
      checkFaucetBump(grid, player);
    }
    player.vy = 0;
  }

  // Clamp to grid bounds
  if (player.x < 0) player.x = 0;
  if (player.x + player.width > grid.width) player.x = grid.width - player.width;
  if (player.y < 0) { player.y = 0; player.vy = 0; }
  if (player.y + player.height > grid.height) {
    player.y = grid.height - player.height;
    player.vy = 0;
    player.grounded = true;
  }

  // Pickaxe arc mining: sweep the head through the animation, following the
  // character's live position so blocks hit while jumping/falling are included.
  mineSwingArc(player, runtime, grid);

  // Swing lifecycle. While the mine button is held, keep swinging continuously —
  // this is independent of movement, jumping, or head tilt, so those never
  // interrupt a held swing. updateCharacter fully owns swingStart (draw only reads it).
  const swinging = runtime.swingStart !== null;
  const swingDone = swinging && performance.now() - runtime.swingStart! >= SWING_DURATION;
  if (runtime.swingHeld && state.toolMode === "play" && hasPickaxeEquipped()) {
    if (!swinging || swingDone) {
      runtime.swingStart = performance.now();
      runtime.swingMinedProgress = 0;
    }
  } else if (swingDone) {
    runtime.swingStart = null;
  }
}

/** Mine a single grid cell, handling object flood-fill, inventory and hotbar. */
export function mineCellAt(grid: Grid, x: number, y: number, mined: Set<number>, player: PlayerState): void {
  if (!grid.inBounds(x, y)) return;
  const key = y * grid.width + x;
  if (mined.has(key)) return;
  const id = grid.get(x, y) as MaterialId;
  if (id === MaterialId.Empty || id === MaterialId.Water) return;
  const mat = MATERIALS[id];
  const objectId = grid.getObjectId(x, y);

  if (mat.placement.kind === "object") {
    if (objectId) {
      for (let i = 0; i < grid.objectIds.length; i++) {
        if (grid.objectIds[i] === objectId) {
          const cx = i % grid.width;
          const cy = Math.floor(i / grid.width);
          grid.set(cx, cy, MaterialId.Empty);
          grid.markUpdated(cx, cy);
        }
      }
      addToHotbar(id);
      const name = mat.name.toLowerCase();
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
        const k = ny * grid.width + nx;
        if (mined.has(k)) continue;
        if (grid.get(nx, ny) === id && grid.getObjectId(nx, ny) === null) {
          mined.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    addToHotbar(id);
    const name = mat.name.toLowerCase();
    player.inventory[name] = (player.inventory[name] || 0) + 1;
    return;
  }

  mined.add(key);
  const name = mat.name.toLowerCase();
  player.inventory[name] = (player.inventory[name] || 0) + 1;
  // Add minable materials to hotbar (skip non-placeable things like stems/flowers/grass)
  if (id !== MaterialId.Stem && id !== MaterialId.Flower && id !== MaterialId.Grass) {
    addToHotbar(id);
  }
  grid.set(x, y, MaterialId.Empty);
  grid.markUpdated(x, y);
}

/** Grid cells covered by the pickaxe head for a given swing angle. */
function pickaxeHeadCells(player: PlayerState, angle: number, out: Map<string, [number, number]>): void {
  // Pivot at the shoulder (matches drawCharacter). Values in grid cells.
  // Shift the arc vertically to follow the head tilt: aim higher when looking
  // up, lower when crouching.
  const tiltOffset = player.lookingUp ? -4 : player.crouching ? 3 : 0;
  const sx = player.x + (player.facing === 1 ? player.width : 0);
  const sy = player.y + 2.5 + tiltOffset;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // For the normal (untilted) swing, don't mine below the player's feet so
  // you can mine straight left/right without digging out the floor you stand on.
  const floorLimit = (!player.lookingUp && !player.crouching)
    ? Math.floor(player.y + player.height)
    : Infinity;
  // Sample along the handle/head length and across the head's height (spikes).
  // Start near the shoulder (lx ~0.5) so the cells right in front of the player
  // are cleared too — otherwise you can't advance into what you're mining.
  for (let lx = 0.5; lx <= 4.5; lx += 0.5) {
    for (let ly = -0.8; ly <= 0.8; ly += 0.8) {
      const wx = Math.floor(sx + player.facing * (lx * cos - ly * sin));
      const wy = Math.floor(sy + (lx * sin + ly * cos));
      if (wy >= floorLimit) continue;
      out.set(`${wx},${wy}`, [wx, wy]);
    }
  }
}

/** Mine all cells the pickaxe head sweeps through since the last processed frame. */
function mineSwingArc(player: PlayerState, runtime: CharacterRuntime, grid: Grid): void {
  if (runtime.swingStart === null) return;
  const elapsed = performance.now() - runtime.swingStart;
  const progress = Math.min(elapsed / SWING_DURATION, 1);

  // Collect the swept cells between the last processed progress and now, sampling
  // finely so no cell is skipped even at low frame rates.
  const swept = new Map<string, [number, number]>();
  const from = runtime.swingMinedProgress;
  const STEP = 0.04;
  for (let p = from; p <= progress + 1e-6; p += STEP) {
    pickaxeHeadCells(player, swingAngle(Math.min(p, 1)), swept);
  }
  runtime.swingMinedProgress = progress;

  const mined = new Set<number>();
  for (const [gx, gy] of swept.values()) {
    mineCellAt(grid, gx, gy, mined, player);
  }
}

/** Draw a simple pixel-art character sprite. */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  runtime: CharacterRuntime,
  cellSize: number,
): void {
  const px = Math.round(player.x * cellSize);
  const py = Math.round(player.y * cellSize);
  const cs = cellSize;

  // Simple character: 3 wide x 5 tall
  // Head (row 0-1): skin colored
  // Body (row 2-3): shirt
  // Legs (row 4): pants

  const skin = "#f5c5a3";
  const shirt = "#4488cc";
  const pants = "#3a5a3a";
  const hair = "#5a3322";

  if (player.lookingUp || player.crouching) {
    // Rotate the head (top 2 rows): backward for look-up, forward for crouch
    const tiltDir = player.lookingUp ? -1 : 1;
    ctx.save();
    const headCx = px + cs * 1.5;
    const headCy = py + cs * 2; // pivot at neck
    ctx.translate(headCx, headCy);
    ctx.rotate(0.4 * tiltDir * player.facing);
    ctx.translate(-headCx, -headCy);
    ctx.fillStyle = hair;
    ctx.fillRect(px, py, cs * 3, cs);
    ctx.fillStyle = skin;
    ctx.fillRect(px, py + cs, cs * 3, cs);
    // Dark spot on back of head
    ctx.fillStyle = "#222";
    if (player.facing === 1) {
      ctx.fillRect(px, py + cs, cs, cs);
    } else {
      ctx.fillRect(px + cs * 2, py + cs, cs, cs);
    }
    ctx.restore();
  } else {
    // Hair (top of head)
    ctx.fillStyle = hair;
    ctx.fillRect(px, py, cs * 3, cs);

    // Face
    ctx.fillStyle = skin;
    ctx.fillRect(px, py + cs, cs * 3, cs);

    // Eyes — on the side we're facing
    ctx.fillStyle = "#222";
    if (player.facing === 1) {
      ctx.fillRect(px, py + cs, cs, cs);
    } else {
      ctx.fillRect(px + cs * 2, py + cs, cs, cs);
    }
  }

  // Body / shirt
  ctx.fillStyle = shirt;
  ctx.fillRect(px, py + cs * 2, cs * 3, cs * 2);

  // Legs / pants
  ctx.fillStyle = pants;
  ctx.fillRect(px, py + cs * 4, cs, cs);
  ctx.fillRect(px + cs * 2, py + cs * 4, cs, cs);

  // Pickaxe swing animation (read-only; updateCharacter owns the swing lifecycle)
  if (runtime.swingStart !== null) {
    const elapsed = performance.now() - runtime.swingStart;
    const progress = Math.min(elapsed / SWING_DURATION, 1);
    // Swing arc: starts raised, swings down
    const angle = swingAngle(progress);

    ctx.save();
    // Pivot at shoulder
    const shoulderX = px + (player.facing === 1 ? cs * 3 : 0);
    const shoulderY = py + cs * 2.5;
    ctx.translate(shoulderX, shoulderY);
    ctx.scale(player.facing, 1);
    ctx.rotate(angle);

    // Handle
    ctx.fillStyle = "#8B6914";
    ctx.fillRect(0, -cs * 0.4, cs * 4, cs * 0.8);

    // Pickaxe head
    ctx.fillStyle = "#666";
    ctx.fillRect(cs * 3.2, -cs * 1.2, cs * 1.2, cs * 0.8); // top spike
    ctx.fillRect(cs * 3.2, cs * 0.4, cs * 1.2, cs * 0.8); // bottom spike
    ctx.fillStyle = "#888";
    ctx.fillRect(cs * 3, -cs * 0.6, cs * 0.8, cs * 1.2); // head center

    ctx.restore();
  }
}

/** Trigger a pickaxe swing animation. */
export function startSwing(runtime: CharacterRuntime): void {
  runtime.swingStart = performance.now();
  runtime.swingMinedProgress = 0;
}

/** Set whether the mine button is held (enables auto-repeat swings). */
export function setSwingHeld(runtime: CharacterRuntime, held: boolean): void {
  runtime.swingHeld = held;
}
