import "./style.css";
import { Grid } from "./grid";
import { Renderer } from "./renderer";
import { step } from "./simulation";
import { attachInput } from "./input";
import { buildUi } from "./ui";
import { state } from "./state";
import { MATERIALS, MaterialId } from "./materials";
import { findFlowerCluster } from "./harvest";

const CELL_SIZE = 5;
const GRID_WIDTH = 320;
const GRID_HEIGHT = 200;

const grid = new Grid(GRID_WIDTH, GRID_HEIGHT);
seedObstacles(grid);

const uiRoot = document.querySelector<HTMLDivElement>("#ui-root")!;
buildUi(uiRoot, grid);

const canvas = document.querySelector<HTMLCanvasElement>("#sim-canvas")!;
const renderer = new Renderer(canvas, grid, CELL_SIZE);
attachInput(canvas, grid, CELL_SIZE);

// Garden shears SVG cursor (32×32, hotspot at 6,2)
const SHEARS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <!-- Blades -->
  <path d="M6 2 L16 14 L18 12 L8 0 Z" fill="#c0c0c0" stroke="#333" stroke-width="0.5"/>
  <path d="M22 2 L12 14 L10 12 L20 0 Z" fill="#d0d0d0" stroke="#333" stroke-width="0.5"/>
  <!-- Pivot -->
  <circle cx="14" cy="13" r="2" fill="#888" stroke="#333" stroke-width="0.5"/>
  <!-- Handles -->
  <path d="M12 15 Q8 22 6 28 Q5 30 7 30 Q10 30 12 24 Q13 20 14 16 Z" fill="#e07040" stroke="#333" stroke-width="0.5"/>
  <path d="M16 15 Q20 22 22 28 Q23 30 21 30 Q18 30 16 24 Q15 20 14 16 Z" fill="#d06030" stroke="#333" stroke-width="0.5"/>
</svg>`;
const shearsCursor = `url("data:image/svg+xml,${encodeURIComponent(SHEARS_SVG)}") 6 2, pointer`;

function loop(): void {
  if (!state.paused) {
    step(grid);
  }
  renderer.draw(grid);

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
  if (hoveredCluster) {
    renderer.drawClusterOutline(grid, hoveredCluster);
    canvas.style.cursor = shearsCursor;
  } else {
    canvas.style.cursor = "";
  }

  const material = MATERIALS[state.selectedMaterial];
  if (state.hover && material.placement.kind === "object") {
    renderer.drawObjectPreview(state.hover.x, state.hover.y, material.placement, material.color);
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/** A couple of starter ledges so particles have something to collide with right away. */
function seedObstacles(g: Grid): void {
  const ledgeY = Math.floor(g.height * 0.55);
  for (let x = Math.floor(g.width * 0.1); x < Math.floor(g.width * 0.45); x++) {
    g.set(x, ledgeY, MaterialId.Wood);
  }
  const ledgeY2 = Math.floor(g.height * 0.8);
  for (let x = Math.floor(g.width * 0.55); x < Math.floor(g.width * 0.9); x++) {
    g.set(x, ledgeY2, MaterialId.Wood);
  }
}
