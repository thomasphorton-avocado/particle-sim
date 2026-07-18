import { SWING_DURATION_TICKS, type Grid, type PlayerId, type PlayerState } from "@particle-sim/shared";
import { getLocalPlayer } from "./state";

export interface CharacterRuntime {
  playerId: PlayerId;
}

export interface CharacterInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  lookUp: boolean;
  mine: boolean;
}

const keys: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false, mine: false };
const touchControls: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false, mine: false };

function inputState(control: keyof CharacterInput): boolean {
  return keys[control] || touchControls[control];
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
  player.airTicks = 0;
  player.previousJumpHeld = false;
  player.crouching = false;
  player.lookingUp = false;
  player.swimming = false;
  player.swingElapsedTicks = null;
  player.faucetCooldownUntilTick = 0;
  return {
    playerId: player.id,
  };
}

export function getCharacterInputState(): CharacterInput {
  return {
    left: inputState("left"),
    right: inputState("right"),
    jump: inputState("jump"),
    crouch: inputState("crouch"),
    lookUp: inputState("lookUp"),
    mine: inputState("mine"),
  };
}

export function setTouchControl(control: keyof CharacterInput, pressed: boolean): void {
  touchControls[control] = pressed;
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
    if (e.key === "f") {
      keys.mine = true;
      handled = true;
    }
    if (handled) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => {
    if (isEditable(e.target)) return;
    if (e.key === "ArrowLeft" || e.key === "a") keys.left = false;
    if (e.key === "ArrowRight" || e.key === "d") keys.right = false;
    if (e.key === " ") keys.jump = false;
    if (e.key === "ArrowUp" || e.key === "w") keys.lookUp = false;
    if (e.key === "ArrowDown" || e.key === "s") keys.crouch = false;
    if (e.key === "f") keys.mine = false;
  });
  window.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      keys.mine = true;
      e.preventDefault();
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) {
      keys.mine = false;
      e.preventDefault();
    }
  });
}

function swingAngle(progress: number): number {
  const startAngle = -Math.PI * 0.6;
  const endAngle = Math.PI * 0.2;
  return startAngle + (endAngle - startAngle) * progress;
}

function getSwingProgress(player: PlayerState): number {
  if (player.swingElapsedTicks === null) return 1;
  return Math.min(player.swingElapsedTicks / SWING_DURATION_TICKS, 1);
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  _runtime: CharacterRuntime,
  cellSize: number,
): void {
  const px = Math.round(player.x * cellSize);
  const py = Math.round(player.y * cellSize);
  const cs = cellSize;
  const skin = "#f5c5a3";
  const shirt = "#4488cc";
  const pants = "#3a5a3a";
  const hair = "#5a3322";

  const swingProgress = getSwingProgress(player);
  const angle = swingAngle(swingProgress);
  const pickaxeColor = "#8c8c8c";
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  ctx.fillStyle = hair;
  ctx.fillRect(px, py, cs * 3, cs);
  ctx.fillStyle = skin;
  ctx.fillRect(px, py + cs, cs * 3, cs);
  ctx.fillStyle = shirt;
  ctx.fillRect(px, py + cs * 2, cs * 3, cs * 2);
  ctx.fillStyle = pants;
  ctx.fillRect(px, py + cs * 4, cs * 3, cs);

  ctx.strokeStyle = pickaxeColor;
  ctx.lineWidth = Math.max(2, cs / 6);
  ctx.beginPath();
  ctx.moveTo(px + cs * 1.5, py + cs * 2.5);
  ctx.lineTo(px + cs * 1.5 + dx * cs * 2, py + cs * 2.5 + dy * cs * 2);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px + cs * 1.1, py + cs * 1.2, cs * 0.3, cs * 0.3);
  ctx.fillRect(px + cs * 1.6, py + cs * 1.2, cs * 0.3, cs * 0.3);
}
