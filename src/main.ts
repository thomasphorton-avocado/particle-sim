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

// Seed the world with terrain, a faucet, and a drain
{
  // --- Terrain generation ---
  // Create several overlapping dirt slopes/hills using sine waves + noise
  const terrainHeight = new Float32Array(GRID_WIDTH);
  const baseLevel = GRID_HEIGHT - 20; // leave some room at bottom

  // Layer several sine waves for organic-looking terrain
  const hills = [
    { freq: 0.015, amp: 25, phase: 0 },
    { freq: 0.035, amp: 12, phase: 2.1 },
    { freq: 0.07, amp: 6, phase: 4.7 },
    { freq: 0.12, amp: 3, phase: 1.3 },
  ];

  // Simple seeded pseudo-random for reproducible terrain
  let seed = 42;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };

  for (let x = 0; x < GRID_WIDTH; x++) {
    let h = 0;
    for (const hill of hills) {
      h += Math.sin(x * hill.freq + hill.phase) * hill.amp;
    }
    // Add small random jitter
    h += (rand() - 0.5) * 4;
    terrainHeight[x] = Math.floor(baseLevel - Math.abs(h) - 15);
  }

  // Fill dirt from terrain surface down to bottom
  for (let x = 0; x < GRID_WIDTH; x++) {
    const top = Math.max(0, terrainHeight[x]);
    for (let y = top; y < GRID_HEIGHT; y++) {
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Dirt);
      }
    }
  }

  // --- Place a faucet near the top ---
  // Faucet is 10x6, place it centered near top-left area
  const faucetX = Math.floor(GRID_WIDTH * 0.3);
  const faucetY = 8;
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 10; dx++) {
      const x = faucetX + dx;
      const y = faucetY + dy;
      if (grid.inBounds(x, y)) {
        grid.set(x, y, MaterialId.Faucet);
      }
    }
  }

  // --- Place a drain at the bottom ---
  // Drain is 32x6, place it centered at the bottom
  const drainX = Math.floor(GRID_WIDTH / 2) - 16;
  const drainY = GRID_HEIGHT - 6;
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const x = drainX + dx;
      const y = drainY + dy;
      if (grid.inBounds(x, y)) {
        // Clear dirt first, then place drain
        grid.set(x, y, MaterialId.Drain);
      }
    }
  }

  // Carve out a small basin above the drain so water can reach it
  for (let dy = 1; dy <= 8; dy++) {
    const halfW = 16 + dy * 2; // wider at top
    for (let dx = -halfW; dx <= halfW; dx++) {
      const x = Math.floor(GRID_WIDTH / 2) + dx;
      const y = GRID_HEIGHT - 6 - dy;
      if (grid.inBounds(x, y) && grid.get(x, y) === MaterialId.Dirt) {
        grid.set(x, y, MaterialId.Empty);
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
