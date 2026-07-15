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
  /** Frames since last grounded (for coyote time). */
  airFrames: number;
  /** Whether the character is crouching. */
  crouching: boolean;
  /** Whether the character is looking up. */
  lookingUp: boolean;
}

const GRAVITY = 0.4;
const MOVE_SPEED = 1.2;
const JUMP_VELOCITY = -3.5;
const MAX_FALL = 5;

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
    airFrames: 0,
    crouching: false,
    lookingUp: false,
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

export function attachCharacterInput(): void {
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a") keys.left = true;
    if (e.key === "ArrowRight" || e.key === "d") keys.right = true;
    if (e.key === " ") keys.jump = true;
    if (e.key === "ArrowUp" || e.key === "w") keys.lookUp = true;
    if (e.key === "ArrowDown" || e.key === "s") keys.crouch = true;
  });
  window.addEventListener("keyup", (e) => {
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

export function updateCharacter(char: Character, grid: Grid): void {
  // Crouch / look up state
  char.crouching = keys.crouch;
  char.lookingUp = keys.lookUp;

  // Horizontal movement
  let moveX = 0;
  if (keys.left) { moveX -= MOVE_SPEED; char.facing = -1; }
  if (keys.right) { moveX += MOVE_SPEED; char.facing = 1; }

  // Apply gravity
  char.vy += GRAVITY;
  if (char.vy > MAX_FALL) char.vy = MAX_FALL;

  // Track air frames for coyote time
  if (char.grounded) {
    char.airFrames = 0;
  } else {
    char.airFrames++;
  }

  // Jump (with coyote time: can jump within 5 frames of leaving ground)
  const COYOTE_FRAMES = 5;
  if (keys.jump && !jumpHeld && (char.grounded || char.airFrames <= COYOTE_FRAMES)) {
    char.vy = JUMP_VELOCITY;
    char.grounded = false;
    char.airFrames = COYOTE_FRAMES + 1; // prevent double-jump
    jumpHeld = true;
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
  const newY = char.y + char.vy;
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
      // Hitting ceiling
      char.y = Math.floor(char.y) + 1;
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
  let py = Math.round(char.y * cellSize);
  const cs = cellSize;

  // When crouching, shift body down by 1 cell and hide legs
  if (char.crouching) {
    py += cs;
  }

  // Simple character: 3 wide x 5 tall
  // Head (row 0-1): skin colored
  // Body (row 2-3): shirt
  // Legs (row 4): pants

  const skin = "#f5c5a3";
  const shirt = "#4488cc";
  const pants = "#3a5a3a";
  const hair = "#5a3322";

  // Head offset: tilts up when looking up
  const headOff = char.lookingUp ? -cs : 0;

  // Hair (top of head)
  ctx.fillStyle = hair;
  ctx.fillRect(px, py + headOff, cs * 3, cs);

  // Face
  ctx.fillStyle = skin;
  ctx.fillRect(px, py + cs + headOff, cs * 3, cs);

  // Eyes — on the side we're facing (move to top of face when looking up)
  ctx.fillStyle = "#222";
  if (char.lookingUp) {
    // Eyes on top edge of face when looking up
    ctx.fillRect(px + cs, py + cs + headOff, cs, cs);
  } else if (char.facing === 1) {
    ctx.fillRect(px, py + cs, cs, cs);
  } else {
    ctx.fillRect(px + cs * 2, py + cs, cs, cs);
  }

  // Body / shirt
  ctx.fillStyle = shirt;
  ctx.fillRect(px, py + cs * 2, cs * 3, cs * 2);

  // Legs / pants (hidden when crouching)
  if (!char.crouching) {
    ctx.fillStyle = pants;
    ctx.fillRect(px, py + cs * 4, cs, cs);
    ctx.fillRect(px + cs * 2, py + cs * 4, cs, cs);
  }

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
