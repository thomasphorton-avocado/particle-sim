import "./style.css";
import { MATERIALS, MaterialId, createStarterWorld, findFlowerCluster } from "@particle-sim/shared";
import { Renderer } from "./renderer";
import { step } from "./simulation";
import { attachInput } from "./input";
import { buildUi } from "./ui";
import { state, getActiveHotbarMaterial, getLocalPlayer } from "./state";
import { createCharacter, attachCharacterInput, updateCharacter, drawCharacter } from "./character";
import { updateFallingObjects } from "./falling";

const CELL_SIZE = 5;

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

function loop(): void {
  const now = performance.now();
  const dt = (now - lastTime) / 1000; // seconds
  lastTime = now;

  if (!state.world.paused) {
    state.world.time.dayNightCycle += dt / 300;
    step(state.world);
    updateCharacter(getLocalPlayer(), runtime, grid, dt);
    updateFallingObjects(state.world, dt);
  }
  renderer.draw(grid);
  drawCharacter(renderer.getCtx(), getLocalPlayer(), runtime, CELL_SIZE);

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
requestAnimationFrame(loop);
