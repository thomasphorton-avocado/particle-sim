import { Grid } from "./grid";
import { MATERIALS, MaterialId, MaterialPhase } from "./materials";
import { state, addToHotbar, hasPickaxeEquipped } from "./state";

// Pickaxe swing animation + mining arc (shared by update/mining and draw)
const SWING_DURATION = 250; // ms
const SWING_START_ANGLE = -Math.PI * 0.6; // raised, up-and-back
const SWING_END_ANGLE = Math.PI * 0.2;    // forward-and-down
function swingAngle(progress: number): number {
  return SWING_START_ANGLE + (SWING_END_ANGLE - SWING_START_ANGLE) * progress;
}

export interface Character {
  x: number; // grid position (float for smooth movement)
  y: number;
  vx: number;
  vy: number;
  width: number;  // hitbox in grid cells
  height: number;
  grounded: boolean;
  facing: -1 | 1;
  /** Pickaxe swing animation start time, null if not swinging. */
  swingStart: number | null;
  /** Swing progress (0..1) already processed for mining, to sweep the arc across frames. */
  swingMinedProgress: number;
  /** Whether the mine button is held, to auto-repeat swings. */
  swingHeld: boolean;
  /** Seconds since last grounded (for coyote time). */
  airTime: number;
  /** Whether the character is crouching. */
  crouching: boolean;
  /** Whether the character is looking up. */
  lookingUp: boolean;
  /** Whether the character is currently swimming (submerged in water). */
  swimming: boolean;
}

// Physics constants (tuned at 60 fps baseline).
// dt is normalized to frame-units so these stay as originally tuned.
const BASE_FPS = 60;
const GRAVITY = 0.4;       // cells/frame²
const MOVE_SPEED = 1.2;    // cells/frame
const JUMP_VELOCITY = -3.5; // cells/frame (impulse)
const MAX_FALL = 5;         // cells/frame (terminal velocity)
const COYOTE_TIME_S = 5 / BASE_FPS; // ~83ms coyote window

// Swimming constants
const SWIM_GRAVITY = 0.05;       // reduced gravity underwater
const SWIM_MAX_FALL = 0.75;      // slower sinking
const SWIM_MOVE_SPEED = 0.7;    // slower horizontal movement
const SWIM_UP_VELOCITY = -1.0;  // swim upward impulse (repeatable)

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

export function createCharacter(grid: Grid): Character {
  // Spawn at top-center, will fall to ground
  return {
    x: Math.floor(grid.width / 2) - 1,
    y: 10,
    vx: 0,
    vy: 0,
    width: 3,
    height: 5,
    grounded: false,
    facing: 1,
    swingStart: null,
    swingMinedProgress: 0,
    swingHeld: false,
    airTime: 0,
    crouching: false,
    lookingUp: false,
    swimming: false,
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
function checkFaucetBump(grid: Grid, char: Character): void {
  // Debounce: only trigger once per 300ms
  const now = performance.now();
  if (now - lastFaucetBumpTime < 300) return;

  const headY = Math.floor(char.y) - 1; // row just above head
  if (headY < 0) return;
  const x0 = Math.floor(char.x);
  const x1 = Math.floor(char.x + char.width - 0.01);
  const checkedRows = [...new Set([headY, Math.floor(char.y)])];
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
  const queue = [...seedCells];
  while (queue.length > 0) {
    const [fx, fy] = queue.pop()!;
    const idx = fy * grid.width + fx;
    if (visited.has(idx)) continue;
    visited.add(idx);
    // Check neighbors
    for (const [nx, ny] of [[fx-1,fy],[fx+1,fy],[fx,fy-1],[fx,fy+1]]) {
      if (grid.inBounds(nx, ny) && grid.get(nx, ny) === MaterialId.Faucet && !visited.has(ny * grid.width + nx)) {
        queue.push([nx, ny]);
      }
    }
  }
  // Get current state from any cell and cycle
  const firstIdx = visited.values().next().value!;
  const currentState = grid.vx[firstIdx];
  const newState = (currentState + 1) % 3;
  for (const idx of visited) {
    grid.vx[idx] = newState;
  }
  lastFaucetBumpTime = now;
}

/** Check how many cells in the character's hitbox are water. */
function waterCellCount(grid: Grid, char: Character): number {
  let count = 0;
  const x0 = Math.floor(char.x);
  const x1 = Math.floor(char.x + char.width - 0.01);
  const y0 = Math.floor(char.y);
  const y1 = Math.floor(char.y + char.height - 0.01);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (grid.inBounds(gx, gy) && grid.get(gx, gy) === MaterialId.Water) {
        count++;
      }
    }
  }
  return count;
}

export function updateCharacter(char: Character, grid: Grid, dt: number): void {
  // Normalize dt to frame-units (1.0 = one 60fps frame) and clamp for tab-switch
  const dtFrames = Math.min(dt * BASE_FPS, 3);

  // Detect swimming: submerged if 3+ cells are water (~20% of the 3×5 hitbox; feet/lower body in water)
  const waterCells = waterCellCount(grid, char);
  char.swimming = waterCells >= 3;

  // Crouch / look up state
  char.crouching = inputState("crouch");
  char.lookingUp = inputState("lookUp");

  // Horizontal movement (slower in water)
  const speed = char.swimming ? SWIM_MOVE_SPEED : MOVE_SPEED;
  let moveX = 0;
  if (inputState("left")) { moveX -= speed * dtFrames; char.facing = -1; }
  if (inputState("right")) { moveX += speed * dtFrames; char.facing = 1; }

  // Apply gravity (reduced in water)
  const gravity = char.swimming ? SWIM_GRAVITY : GRAVITY;
  const maxFall = char.swimming ? SWIM_MAX_FALL : MAX_FALL;
  char.vy += gravity * dtFrames;
  if (char.vy > maxFall) char.vy = maxFall;

  // Swimming: space to swim upward (repeatable, no jumpHeld gate)
  if (char.swimming && inputState("jump")) {
    // Check if near the surface (top 2 rows of character are not fully submerged)
    const headY = Math.floor(char.y);
    const x0 = Math.floor(char.x);
    const x1 = Math.floor(char.x + char.width - 0.01);
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
      char.vy = JUMP_VELOCITY;
      jumpHeld = true;
    } else {
      char.vy = SWIM_UP_VELOCITY;
    }
  } else {
    // Track air time for coyote time (in seconds)
    if (char.grounded) {
      char.airTime = 0;
    } else {
      char.airTime += dt;
    }

    // Jump (with coyote time) - only when not swimming
    if (!char.swimming && inputState("jump") && !jumpHeld && (char.grounded || char.airTime <= COYOTE_TIME_S)) {
      char.vy = JUMP_VELOCITY;
      char.grounded = false;
      char.airTime = COYOTE_TIME_S + 1; // prevent double-jump
      jumpHeld = true;
    }
  }

  // Move horizontally with collision
  const newX = char.x + moveX;
  if (!collidesAt(grid, newX, char.y, char.width, char.height)) {
    char.x = newX;
  } else if (char.swingStart === null) {
    // Try to step up 1-2 cells (slope/stair climbing).
    // Disabled while swinging so you mine into ledges instead of climbing them.
    for (let stepUp = 1; stepUp <= 2; stepUp++) {
      if (!collidesAt(grid, newX, char.y - stepUp, char.width, char.height)) {
        char.x = newX;
        char.y -= stepUp;
        break;
      }
    }
  }

  // Move vertically with collision
  const newY = char.y + char.vy * dtFrames;
  if (!collidesAt(grid, char.x, newY, char.width, char.height)) {
    char.y = newY;
    char.grounded = false;
  } else {
    // Resolve: find the nearest non-colliding position
    if (char.vy > 0) {
      // Falling — snap to top of ground
      char.y = Math.floor(newY + char.height) - char.height;
      // Fine adjustment: move up until not colliding
      while (collidesAt(grid, char.x, char.y, char.width, char.height) && char.y > 0) {
        char.y -= 1;
      }
      char.grounded = true;
    } else {
      // Hitting ceiling — snap below the ceiling
      char.y = Math.ceil(newY);
      while (collidesAt(grid, char.x, char.y, char.width, char.height) && char.y < grid.height - char.height) {
        char.y += 1;
      }
      // Check if we hit a faucet after resolving the final head position.
      checkFaucetBump(grid, char);
    }
    char.vy = 0;
  }

  // Clamp to grid bounds
  if (char.x < 0) char.x = 0;
  if (char.x + char.width > grid.width) char.x = grid.width - char.width;
  if (char.y < 0) { char.y = 0; char.vy = 0; }
  if (char.y + char.height > grid.height) {
    char.y = grid.height - char.height;
    char.vy = 0;
    char.grounded = true;
  }

  // Pickaxe arc mining: sweep the head through the animation, following the
  // character's live position so blocks hit while jumping/falling are included.
  mineSwingArc(char, grid);

  // Swing lifecycle. While the mine button is held, keep swinging continuously —
  // this is independent of movement, jumping, or head tilt, so those never
  // interrupt a held swing. updateCharacter fully owns swingStart (draw only reads it).
  const swinging = char.swingStart !== null;
  const swingDone = swinging && performance.now() - char.swingStart! >= SWING_DURATION;
  if (char.swingHeld && state.toolMode === "play" && hasPickaxeEquipped()) {
    if (!swinging || swingDone) {
      char.swingStart = performance.now();
      char.swingMinedProgress = 0;
    }
  } else if (swingDone) {
    char.swingStart = null;
  }
}

/** Mine a single grid cell, handling object flood-fill, inventory and hotbar. */
function mineCellAt(grid: Grid, x: number, y: number, mined: Set<number>): void {
  if (!grid.inBounds(x, y)) return;
  const key = y * grid.width + x;
  if (mined.has(key)) return;
  const id = grid.get(x, y) as MaterialId;
  if (id === MaterialId.Empty || id === MaterialId.Water) return;
  const mat = MATERIALS[id];

  // Object-type materials: flood-fill to remove the whole object as one item
  if (mat.placement.kind === "object") {
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
        if (grid.get(nx, ny) === id) {
          mined.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    addToHotbar(id);
    const name = mat.name.toLowerCase();
    state.inventory[name] = (state.inventory[name] || 0) + 1;
    return;
  }

  mined.add(key);
  const name = mat.name.toLowerCase();
  state.inventory[name] = (state.inventory[name] || 0) + 1;
  // Add minable materials to hotbar (skip non-placeable things like stems/flowers/grass)
  if (id !== MaterialId.Stem && id !== MaterialId.Flower && id !== MaterialId.Grass) {
    addToHotbar(id);
  }
  grid.set(x, y, MaterialId.Empty);
  grid.markUpdated(x, y);
}

/** Grid cells covered by the pickaxe head for a given swing angle. */
function pickaxeHeadCells(char: Character, angle: number, out: Map<string, [number, number]>): void {
  // Pivot at the shoulder (matches drawCharacter). Values in grid cells.
  // Shift the arc vertically to follow the head tilt: aim higher when looking
  // up, lower when crouching.
  const tiltOffset = char.lookingUp ? -4 : char.crouching ? 3 : 0;
  const sx = char.x + (char.facing === 1 ? char.width : 0);
  const sy = char.y + 2.5 + tiltOffset;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // For the normal (untilted) swing, don't mine below the character's feet so
  // you can mine straight left/right without digging out the floor you stand on.
  const floorLimit = (!char.lookingUp && !char.crouching)
    ? Math.floor(char.y + char.height)
    : Infinity;
  // Sample along the handle/head length and across the head's height (spikes).
  // Start near the shoulder (lx ~0.5) so the cells right in front of the player
  // are cleared too — otherwise you can't advance into what you're mining.
  for (let lx = 0.5; lx <= 4.5; lx += 0.5) {
    for (let ly = -0.8; ly <= 0.8; ly += 0.8) {
      const wx = Math.floor(sx + char.facing * (lx * cos - ly * sin));
      const wy = Math.floor(sy + (lx * sin + ly * cos));
      if (wy >= floorLimit) continue;
      out.set(`${wx},${wy}`, [wx, wy]);
    }
  }
}

/** Mine all cells the pickaxe head sweeps through since the last processed frame. */
function mineSwingArc(char: Character, grid: Grid): void {
  if (char.swingStart === null) return;
  const elapsed = performance.now() - char.swingStart;
  const progress = Math.min(elapsed / SWING_DURATION, 1);

  // Collect the swept cells between the last processed progress and now, sampling
  // finely so no cell is skipped even at low frame rates.
  const swept = new Map<string, [number, number]>();
  const from = char.swingMinedProgress;
  const STEP = 0.04;
  for (let p = from; p <= progress + 1e-6; p += STEP) {
    pickaxeHeadCells(char, swingAngle(Math.min(p, 1)), swept);
  }
  char.swingMinedProgress = progress;

  const mined = new Set<number>();
  for (const [gx, gy] of swept.values()) {
    mineCellAt(grid, gx, gy, mined);
  }
}

/** Draw a simple pixel-art character sprite. */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  char: Character,
  cellSize: number,
): void {
  const px = Math.round(char.x * cellSize);
  const py = Math.round(char.y * cellSize);
  const cs = cellSize;

  // Simple character: 3 wide x 5 tall
  // Head (row 0-1): skin colored
  // Body (row 2-3): shirt
  // Legs (row 4): pants

  const skin = "#f5c5a3";
  const shirt = "#4488cc";
  const pants = "#3a5a3a";
  const hair = "#5a3322";

  if (char.lookingUp || char.crouching) {
    // Rotate the head (top 2 rows): backward for look-up, forward for crouch
    const tiltDir = char.lookingUp ? -1 : 1;
    ctx.save();
    const headCx = px + cs * 1.5;
    const headCy = py + cs * 2; // pivot at neck
    ctx.translate(headCx, headCy);
    ctx.rotate(0.4 * tiltDir * char.facing);
    ctx.translate(-headCx, -headCy);
    ctx.fillStyle = hair;
    ctx.fillRect(px, py, cs * 3, cs);
    ctx.fillStyle = skin;
    ctx.fillRect(px, py + cs, cs * 3, cs);
    // Dark spot on back of head
    ctx.fillStyle = "#222";
    if (char.facing === 1) {
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
    if (char.facing === 1) {
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
  if (char.swingStart !== null) {
    const elapsed = performance.now() - char.swingStart;
    const progress = Math.min(elapsed / SWING_DURATION, 1);
    // Swing arc: starts raised, swings down
    const angle = swingAngle(progress);

    ctx.save();
    // Pivot at shoulder
    const shoulderX = px + (char.facing === 1 ? cs * 3 : 0);
    const shoulderY = py + cs * 2.5;
    ctx.translate(shoulderX, shoulderY);
    ctx.scale(char.facing, 1);
    ctx.rotate(angle);

    // Handle
    ctx.fillStyle = "#8B6914";
    ctx.fillRect(0, -cs * 0.4, cs * 4, cs * 0.8);

    // Pickaxe head
    ctx.fillStyle = "#666";
    ctx.fillRect(cs * 3.2, -cs * 1.2, cs * 1.2, cs * 0.8); // top spike
    ctx.fillRect(cs * 3.2, cs * 0.4, cs * 1.2, cs * 0.8);  // bottom spike
    ctx.fillStyle = "#888";
    ctx.fillRect(cs * 3, -cs * 0.6, cs * 0.8, cs * 1.2);   // head center

    ctx.restore();
  }
}

/** Trigger a pickaxe swing animation. */
export function startSwing(char: Character): void {
  char.swingStart = performance.now();
  char.swingMinedProgress = 0;
}

/** Set whether the mine button is held (enables auto-repeat swings). */
export function setSwingHeld(char: Character, held: boolean): void {
  char.swingHeld = held;
}
