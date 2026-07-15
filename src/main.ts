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

// Seed the world with a starter layout (based on reference design)
{
  // --- Top sloped dirt shelf (river channel) ---
  // Slopes from upper-left (~x=10,y=22) to mid-right (~x=195,y=55)
  for (let x = 8; x < 200; x++) {
    const progress = (x - 8) / (200 - 8);
    const topY = Math.floor(22 + progress * 33); // slope from y=22 to y=55
    const thickness = Math.floor(14 + Math.sin(x * 0.05) * 4); // 10-18 cells thick
    for (let dy = 0; dy < thickness; dy++) {
      const y = topY + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Large middle platform ---
  // Flat shelf from about x=25 to x=215, top at y=95
  for (let x = 25; x < 215; x++) {
    const topY = 95 + Math.floor(Math.sin(x * 0.03) * 2); // slight waviness
    const thickness = 22;
    for (let dy = 0; dy < thickness; dy++) {
      const y = topY + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Stone boulder on middle platform ---
  // Blob centered around (95, 82), radius ~12
  const boulderCx = 95, boulderCy = 82, boulderR = 12;
  for (let y = boulderCy - boulderR; y <= boulderCy + boulderR; y++) {
    for (let x = boulderCx - boulderR; x <= boulderCx + boulderR; x++) {
      const dx = x - boulderCx, dy = y - boulderCy;
      // Slightly irregular shape
      const r = boulderR + Math.sin(Math.atan2(dy, dx) * 5) * 2;
      if (dx * dx + dy * dy <= r * r && grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Stone);
      }
    }
  }

  // --- Wood plank on the right ---
  // About x=200-250, y=105, size 48x6
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 48; dx++) {
      const x = 200 + dx, y = 105 + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Wood);
      }
    }
  }

  // --- Bottom terrain (diagonal slope) ---
  // Surface goes from about (0, 168) sloping down to (200, 195)
  for (let x = 0; x < 220; x++) {
    const progress = x / 220;
    const surfaceY = Math.floor(168 + progress * 27);
    for (let y = surfaceY; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Empty) {
        grid.set(x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Stone mountain (bottom-right) ---
  // Triangle peak at (265, 110), base from (230, 170) to (300, 170)
  const peakX = 265, peakY = 110, mtnBaseY = 172;
  const mtnHalfBase = 35;
  for (let y = peakY; y <= mtnBaseY; y++) {
    const progress = (y - peakY) / (mtnBaseY - peakY);
    const halfW = Math.floor(progress * mtnHalfBase);
    for (let x = peakX - halfW; x <= peakX + halfW; x++) {
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Stone);
      }
    }
  }
  // Dirt below the mountain base
  for (let x = peakX - mtnHalfBase; x <= peakX + mtnHalfBase; x++) {
    for (let y = mtnBaseY + 1; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Empty) {
        grid.set(x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Faucet at top-left ---
  // 10x6 object near top, start in full flow mode (vx=2)
  const faucetX = 18, faucetY = 2;
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 10; dx++) {
      const x = faucetX + dx, y = faucetY + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Faucet);
        grid.vx[y * GRID_WIDTH + x] = 2;
      }
    }
  }

  // --- Drain on the lower dirt section ---
  // Place on the surface of the bottom terrain so water collects there
  const drainX = 80, drainY = 163;
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 20; dx++) {
      const x = drainX + dx, y = drainY + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Drain);
      }
    }
  }

  // --- Sand patch near the drain ---
  for (let x = 20; x < 60; x++) {
    for (let y = GRID_HEIGHT - 15; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Dirt) {
        grid.set(x, y, MaterialId.Sand);
      }
    }
  }
}

const uiRoot = document.querySelector<HTMLDivElement>("#ui-root")!;
buildUi(uiRoot, grid);

const canvas = document.querySelector<HTMLCanvasElement>("#sim-canvas")!;
const renderer = new Renderer(canvas, grid, CELL_SIZE);
attachInput(canvas, grid, CELL_SIZE);

const character = createCharacter(grid);
state.character = character;
attachCharacterInput();

let lastTime = performance.now();

function loop(): void {
  const now = performance.now();
  const dt = (now - lastTime) / 1000; // seconds
  lastTime = now;

  if (!state.paused) {
    step(grid);
    updateCharacter(character, grid, dt);
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
  if (state.toolMode !== "pickaxe" && state.hover && !hoveringFaucet && !hoveredCluster && material.placement.kind === "object") {
    renderer.drawObjectPreview(state.hover.x, state.hover.y, material.placement, material.color);
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
