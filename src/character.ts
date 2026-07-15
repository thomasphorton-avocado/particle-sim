import { Grid } from "./grid";
import { MATERIALS, MaterialId, MaterialPhase } from "./materials";

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
const SWIM_GRAVITY = 0.1;       // reduced gravity underwater
const SWIM_MAX_FALL = 1.5;      // slower sinking
const SWIM_MOVE_SPEED = 0.7;    // slower horizontal movement
const SWIM_UP_VELOCITY = -2.0;  // swim upward impulse (repeatable)

/** Returns true if the given grid cell is solid ground the character can stand on. */
function isSolid(grid: Grid, gx: number, gy: number): boolean {
  if (!grid.inBounds(gx, gy)) return true; // treat OOB as solid (floor/walls)
  const id = grid.get(gx, gy) as MaterialId;
  if (id === MaterialId.Empty) return false;
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
let jumpHeld = false;

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
  // Debounce: only trigger once per 500ms
  const now = performance.now();
  if (now - lastFaucetBumpTime < 500) return;

  const headY = Math.floor(char.y) - 1; // row just above head
  if (headY < 0) return;
  const x0 = Math.floor(char.x);
  const x1 = Math.floor(char.x + char.width - 0.01);
  let hitFaucet = false;
  for (let gx = x0; gx <= x1; gx++) {
    if (grid.inBounds(gx, headY) && grid.get(gx, headY) === MaterialId.Faucet) {
      hitFaucet = true;
      break;
    }
  }
  if (!hitFaucet) return;
  // Cycle all connected faucet cells: 0→1→2→0
  const visited = new Set<number>();
  const queue: [number, number][] = [];
  // Start flood-fill from the hit cells
  for (let gx = x0; gx <= x1; gx++) {
    if (grid.inBounds(gx, headY) && grid.get(gx, headY) === MaterialId.Faucet) {
      queue.push([gx, headY]);
    }
  }
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

  // Detect swimming: submerged if 3+ cells are water (about half the body)
  const waterCells = waterCellCount(grid, char);
  char.swimming = waterCells >= 3;

  // Crouch / look up state
  char.crouching = keys.crouch;
  char.lookingUp = keys.lookUp;

  // Horizontal movement (slower in water)
  const speed = char.swimming ? SWIM_MOVE_SPEED : MOVE_SPEED;
  let moveX = 0;
  if (keys.left) { moveX -= speed * dtFrames; char.facing = -1; }
  if (keys.right) { moveX += speed * dtFrames; char.facing = 1; }

  // Apply gravity (reduced in water)
  const gravity = char.swimming ? SWIM_GRAVITY : GRAVITY;
  const maxFall = char.swimming ? SWIM_MAX_FALL : MAX_FALL;
  char.vy += gravity * dtFrames;
  if (char.vy > maxFall) char.vy = maxFall;

  // Swimming: space to swim upward (repeatable, no jumpHeld gate)
  if (char.swimming && keys.jump) {
    char.vy = SWIM_UP_VELOCITY;
  } else {
    // Track air time for coyote time (in seconds)
    if (char.grounded) {
      char.airTime = 0;
    } else {
      char.airTime += dt;
    }

    // Jump (with coyote time) - only when not swimming
    if (!char.swimming && keys.jump && !jumpHeld && (char.grounded || char.airTime <= COYOTE_TIME_S)) {
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
  } else {
    // Try to step up 1-2 cells (slope/stair climbing)
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
      // Check if we hit a faucet — cycle its flow state
      checkFaucetBump(grid, char);
      char.y = Math.ceil(newY);
      while (collidesAt(grid, char.x, char.y, char.width, char.height) && char.y < grid.height - char.height) {
        char.y += 1;
      }
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

  // Pickaxe swing animation
  if (char.swingStart !== null) {
    const SWING_DURATION = 250;
    const elapsed = performance.now() - char.swingStart;
    if (elapsed >= SWING_DURATION) {
      char.swingStart = null;
    } else {
      const progress = elapsed / SWING_DURATION;
      // Swing arc: starts raised, swings down
      const startAngle = -Math.PI * 0.6;
      const endAngle = Math.PI * 0.2;
      const angle = startAngle + (endAngle - startAngle) * progress;

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
}

/** Trigger a pickaxe swing animation. */
export function startSwing(char: Character): void {
  char.swingStart = performance.now();
}
