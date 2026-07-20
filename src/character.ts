import { SWING_DURATION_TICKS, type Grid, type PlayerId, type PlayerState } from "@particle-sim/shared";
import type { InputEdgeBuffer } from "./input-buffer";
import { getLocalPlayer } from "./state";

let inputBuffer: InputEdgeBuffer | null = null;
let characterInputAttached = false;

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

const keyboardControls: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false, mine: false };
const touchControls: CharacterInput = { left: false, right: false, jump: false, crouch: false, lookUp: false, mine: false };
let mouseMineHeld = false;
let penMineHeld = false;
const touchMinePointers = new Set<number>();

function inputState(control: keyof CharacterInput): boolean {
  if (control === "mine") {
    return keyboardControls.mine || touchControls.mine || mouseMineHeld || penMineHeld || touchMinePointers.size > 0;
  }
  return keyboardControls[control] || touchControls[control];
}

function syncInputBuffer(control: "jump" | "mine"): void {
  if (!inputBuffer) return;
  if (control === "jump") {
    const aggregatePressed = keyboardControls.jump || touchControls.jump;
    if (aggregatePressed && !inputBuffer.heldJump) {
      inputBuffer.latchedJump = true;
    }
    inputBuffer.heldJump = aggregatePressed;
    return;
  }

  const aggregatePressed = keyboardControls.mine || touchControls.mine || mouseMineHeld || penMineHeld || touchMinePointers.size > 0;
  if (aggregatePressed && !inputBuffer.heldMine) {
    inputBuffer.latchedMine = true;
  }
  inputBuffer.heldMine = aggregatePressed;
}

export function setKeyboardControl(control: keyof CharacterInput, pressed: boolean): void {
  keyboardControls[control] = pressed;
  if (control === "jump" || control === "mine") {
    syncInputBuffer(control);
  }
}

export function setTouchControl(control: keyof CharacterInput, pressed: boolean): void {
  touchControls[control] = pressed;
  if (control === "jump" || control === "mine") {
    syncInputBuffer(control);
  }
}

function updateMinePointerSource(pointerType: string, pointerId: number, pressed: boolean): void {
  if (pointerType === "mouse") {
    mouseMineHeld = pressed;
  } else if (pointerType === "pen") {
    penMineHeld = pressed;
  } else if (pointerType === "touch") {
    if (pressed) {
      touchMinePointers.add(pointerId);
    } else {
      touchMinePointers.delete(pointerId);
    }
  }
  syncInputBuffer("mine");
}

function shouldHandleMinePointerEvent(pointerType: string | undefined, button: number | undefined): boolean {
  const resolvedPointerType = pointerType || "mouse";
  if (resolvedPointerType === "touch") {
    return true;
  }
  if (resolvedPointerType === "mouse" || resolvedPointerType === "pen") {
    return (button ?? 0) === 0;
  }
  return false;
}

export function setPointerControl(control: keyof CharacterInput, pressed: boolean): void {
  if (control !== "mine") return;
  mouseMineHeld = pressed;
  syncInputBuffer("mine");
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

export function resetCharacterInputState(): void {
  keyboardControls.left = false;
  keyboardControls.right = false;
  keyboardControls.jump = false;
  keyboardControls.crouch = false;
  keyboardControls.lookUp = false;
  keyboardControls.mine = false;
  touchControls.left = false;
  touchControls.right = false;
  touchControls.jump = false;
  touchControls.crouch = false;
  touchControls.lookUp = false;
  touchControls.mine = false;
  mouseMineHeld = false;
  penMineHeld = false;
  touchMinePointers.clear();
  if (inputBuffer) {
    inputBuffer.heldJump = false;
    inputBuffer.heldMine = false;
    inputBuffer.latchedJump = false;
    inputBuffer.latchedMine = false;
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function attachCharacterInput(buffer: InputEdgeBuffer): void {
  if (characterInputAttached) {
    inputBuffer = buffer;
    return;
  }
  characterInputAttached = true;
  inputBuffer = buffer;
  const setHeld = (control: keyof CharacterInput, pressed: boolean): void => {
    setKeyboardControl(control, pressed);
  };

  window.addEventListener("keydown", (e) => {
    if (isEditable(e.target)) return;
    let handled = false;
    if (e.key === "ArrowLeft" || e.key === "a") {
      setHeld("left", true);
      handled = true;
    }
    if (e.key === "ArrowRight" || e.key === "d") {
      setHeld("right", true);
      handled = true;
    }
    if (e.key === " ") {
      setHeld("jump", true);
      handled = true;
    }
    if (e.key === "ArrowUp" || e.key === "w") {
      setHeld("lookUp", true);
      handled = true;
    }
    if (e.key === "ArrowDown" || e.key === "s") {
      setHeld("crouch", true);
      handled = true;
    }
    if (e.key === "f") {
      setHeld("mine", true);
      handled = true;
    }
    if (handled) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => {
    if (isEditable(e.target)) return;
    if (e.key === "ArrowLeft" || e.key === "a") setHeld("left", false);
    if (e.key === "ArrowRight" || e.key === "d") setHeld("right", false);
    if (e.key === " ") setHeld("jump", false);
    if (e.key === "ArrowUp" || e.key === "w") setHeld("lookUp", false);
    if (e.key === "ArrowDown" || e.key === "s") setHeld("crouch", false);
    if (e.key === "f") setHeld("mine", false);
  });
  window.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      updateMinePointerSource("mouse", 0, true);
      e.preventDefault();
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) {
      updateMinePointerSource("mouse", 0, false);
      e.preventDefault();
    }
  });
  window.addEventListener("pointerdown", (e) => {
    if (!shouldHandleMinePointerEvent(e.pointerType, e.button)) return;
    updateMinePointerSource(e.pointerType || "mouse", e.pointerId, true);
    e.preventDefault();
  });
  window.addEventListener("pointerup", (e) => {
    if (!shouldHandleMinePointerEvent(e.pointerType, e.button)) return;
    updateMinePointerSource(e.pointerType || "mouse", e.pointerId, false);
    e.preventDefault();
  });
  window.addEventListener("pointercancel", (e) => {
    if (!shouldHandleMinePointerEvent(e.pointerType, e.button)) return;
    updateMinePointerSource(e.pointerType || "mouse", e.pointerId, false);
    e.preventDefault();
  });
  window.addEventListener("lostpointercapture", (e) => {
    if (!shouldHandleMinePointerEvent(e.pointerType, e.button)) return;
    updateMinePointerSource(e.pointerType || "mouse", e.pointerId, false);
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
