import "./style.css";
import { MATERIALS, MaterialId, advanceWorldTick, createStarterWorld, findFlowerCluster, normalizePlayerInput, type PlayerInputState } from "@particle-sim/shared";
import { Renderer } from "./renderer";
import { attachInput } from "./input";
import { buildUi } from "./ui";
import { state, getActiveHotbarMaterial, getLocalPlayer } from "./state";
import { createCharacter, attachCharacterInput, getCharacterInputState, drawCharacter } from "./character";
import { createInputEdgeBuffer, consumeBufferedInputs, updateInputEdgeBuffer } from "./input-buffer";
import { createPresentationSnapshot, getInterpolatedPlayerSnapshot } from "./render-snapshots";

const CELL_SIZE = 5;
const TICK_MS = 1000 / 60;
const MAX_TICKS_PER_FRAME = 8;

state.world = createStarterWorld({ roomId: "room_default" });
const grid = state.world.grid;

const uiRoot = document.querySelector<HTMLDivElement>("#ui-root")!;
buildUi(uiRoot, grid);

const canvas = document.querySelector<HTMLCanvasElement>("#sim-canvas")!;
const renderer = new Renderer(canvas, grid, CELL_SIZE);
attachInput(canvas, state.world, CELL_SIZE);

const runtime = createCharacter(grid);
state.character = runtime;
attachCharacterInput();

let lastTime = performance.now();
let accumulatorMs = 0;
let wasPaused = state.world.paused;
let hidden = document.hidden;
const inputBuffer = createInputEdgeBuffer();
let previousPresentationSnapshot = createPresentationSnapshot(state.world);
let currentPresentationSnapshot = createPresentationSnapshot(state.world);

function getBufferedInputs(): Record<string, PlayerInputState> {
  const localInput = getCharacterInputState();
  updateInputEdgeBuffer(inputBuffer, { jump: localInput.jump, mine: localInput.mine });
  const bufferedInputs = consumeBufferedInputs(inputBuffer);
  return {
    [state.localPlayerId]: normalizePlayerInput({
      left: localInput.left,
      right: localInput.right,
      jumpHeld: bufferedInputs.jumpHeld,
      crouchHeld: localInput.crouch,
      lookUpHeld: localInput.lookUp,
      mineHeld: bufferedInputs.mineHeld,
    }),
  };
}

function loop(): void {
  const now = performance.now();
  const frameDeltaMs = now - lastTime;
  lastTime = now;

  const paused = state.world.paused;
  if (paused !== wasPaused) {
    lastTime = now;
    wasPaused = paused;
  }

  if (hidden || paused) {
    accumulatorMs = 0;
  } else {
    accumulatorMs += frameDeltaMs;
  }

  let ticksThisFrame = 0;
  while (accumulatorMs >= TICK_MS && ticksThisFrame < MAX_TICKS_PER_FRAME) {
    previousPresentationSnapshot = currentPresentationSnapshot;
    advanceWorldTick(state.world, getBufferedInputs());
    currentPresentationSnapshot = createPresentationSnapshot(state.world);
    accumulatorMs -= TICK_MS;
    ticksThisFrame += 1;
  }

  renderer.draw(grid);
  const displayAlpha = accumulatorMs >= TICK_MS ? 1 : Math.min(Math.max(accumulatorMs / TICK_MS, 0), 1);
  const interpolatedPlayer = getInterpolatedPlayerSnapshot(
    previousPresentationSnapshot,
    currentPresentationSnapshot,
    state.localPlayerId,
    displayAlpha,
  );
  if (interpolatedPlayer) {
    drawCharacter(
      renderer.getCtx(),
      {
        ...getLocalPlayer(),
        x: interpolatedPlayer.x,
        y: interpolatedPlayer.y,
        vy: interpolatedPlayer.vy,
      },
      runtime,
      CELL_SIZE,
    );
  } else {
    drawCharacter(renderer.getCtx(), getLocalPlayer(), runtime, CELL_SIZE);
  }

  // Draw placement radius border (place mode, or play mode with material selected)
  const showRadius = state.toolMode === "place" || (state.toolMode === "play" && getActiveHotbarMaterial() != null);
  if (showRadius) {
    const ctx = renderer.getCtx();
    const player = getLocalPlayer();
    const charCx = (player.x + player.width / 2) * CELL_SIZE;
    const charCy = (player.y + player.height / 2) * CELL_SIZE;
    const t = performance.now() / 1000;
    const radius = 30 * CELL_SIZE;
    const alpha = 0.2 + Math.sin(t * 1.5) * 0.1;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -t * 20;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(charCx, charCy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Highlight hovered flower/stem cluster
  let hoveredCluster: Set<number> | null = null;
  if (state.hover) {
    hoveredCluster = findFlowerCluster(grid, state.hover.x, state.hover.y);
    // Only highlight clusters that contain at least one bloomed flower
    if (hoveredCluster) {
      let hasFlower = false;
      for (const idx of hoveredCluster) {
        if ((grid.ids[idx] as MaterialId) === MaterialId.Flower) {
          hasFlower = true;
          break;
        }
      }
      if (!hasFlower) hoveredCluster = null;
    }
  }
  // Determine if hovering a faucet
  const hoveringFaucet = state.hover && grid.get(state.hover.x, state.hover.y) === MaterialId.Faucet;

  if (hoveredCluster) {
    renderer.drawClusterOutline(grid, hoveredCluster);
    canvas.style.cursor = "none";
    if (state.hoverPixel) {
      renderer.drawShears(state.hoverPixel.x, state.hoverPixel.y);
    }
  } else if (hoveringFaucet) {
    canvas.style.cursor = "pointer";
  } else {
    canvas.style.cursor = "";
  }

  // Snip animation: close over ~150ms at the click position (cursor reverts immediately)
  if (state.snip) {
    const SNIP_DURATION = 150;
    const elapsed = performance.now() - state.snip.startTime;
    if (elapsed >= SNIP_DURATION) {
      state.snip = null;
    } else {
      const openness = 1 - elapsed / SNIP_DURATION;
      renderer.drawShears(state.snip.px, state.snip.py, openness);
    }
  }

  const material = MATERIALS[state.selectedMaterial];
  if (state.toolMode !== "play" && state.hover && !hoveringFaucet && !hoveredCluster && material.placement.kind === "object") {
    renderer.drawObjectPreview(state.hover.x, state.hover.y, material.placement, material.color);
  }

  // Draw inventory placement preview in play mode
  const hotbarMat = getActiveHotbarMaterial();
  if (state.toolMode === "play" && state.hover && hotbarMat) {
    const player = getLocalPlayer();
    const charCx = player.x + player.width / 2;
    const charCy = player.y + player.height / 2;
    renderer.drawInventoryPreview(
      state.hover.x, state.hover.y,
      hotbarMat.materialId,
      charCx, charCy,
      30, // PLACEMENT_RADIUS
      state.brushSize,
    );
  }

  requestAnimationFrame(loop);
}

function updateVisibility(): void {
  hidden = document.hidden;
  if (!hidden) {
    lastTime = performance.now();
    accumulatorMs = 0;
  }
}

document.addEventListener("visibilitychange", updateVisibility);
requestAnimationFrame(loop);
