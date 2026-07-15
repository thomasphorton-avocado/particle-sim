import "./style.css";
import { Grid } from "./grid";
import { Renderer } from "./renderer";
import { step } from "./simulation";
import { attachInput } from "./input";
import { buildUi } from "./ui";
import { state } from "./state";
import { MATERIALS, MaterialId } from "./materials";
import { findFlowerCluster } from "./harvest";
import { createCharacter, attachCharacterInput, updateCharacter, drawCharacter } from "./character";

const CELL_SIZE = 5;
const GRID_WIDTH = 320;
const GRID_HEIGHT = 200;

const grid = new Grid(GRID_WIDTH, GRID_HEIGHT);

const uiRoot = document.querySelector<HTMLDivElement>("#ui-root")!;
buildUi(uiRoot, grid);

const canvas = document.querySelector<HTMLCanvasElement>("#sim-canvas")!;
const renderer = new Renderer(canvas, grid, CELL_SIZE);
attachInput(canvas, grid, CELL_SIZE);

const character = createCharacter(grid);
state.character = character;
attachCharacterInput();

function loop(): void {
  if (!state.paused) {
    step(grid);
    updateCharacter(character, grid);
  }
  renderer.draw(grid);
  drawCharacter(renderer.getCtx(), character, CELL_SIZE);

  // Draw placement radius border (only in place mode)
  if (state.toolMode === "place") {
    const ctx = renderer.getCtx();
    const charCx = (character.x + character.width / 2) * CELL_SIZE;
    const charCy = (character.y + character.height / 2) * CELL_SIZE;
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
  if (state.hover && !hoveringFaucet && !hoveredCluster && material.placement.kind === "object") {
    renderer.drawObjectPreview(state.hover.x, state.hover.y, material.placement, material.color);
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
