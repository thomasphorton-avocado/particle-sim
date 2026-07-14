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

// Generate a garden shears cursor as a PNG data URL via an offscreen canvas
function buildShearsCursor(): string {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;

  // Blades
  ctx.fillStyle = "#c0c0c0";
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(8, 1);
  ctx.lineTo(16, 13);
  ctx.lineTo(14, 15);
  ctx.lineTo(6, 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#d4d4d4";
  ctx.beginPath();
  ctx.moveTo(22, 1);
  ctx.lineTo(14, 13);
  ctx.lineTo(16, 15);
  ctx.lineTo(24, 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Pivot screw
  ctx.fillStyle = "#777";
  ctx.beginPath();
  ctx.arc(15, 14, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Left handle
  ctx.fillStyle = "#d06030";
  ctx.beginPath();
  ctx.moveTo(13, 16);
  ctx.quadraticCurveTo(9, 22, 7, 28);
  ctx.quadraticCurveTo(6, 31, 8, 31);
  ctx.quadraticCurveTo(11, 30, 13, 24);
  ctx.lineTo(15, 17);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Right handle
  ctx.fillStyle = "#c05020";
  ctx.beginPath();
  ctx.moveTo(17, 16);
  ctx.quadraticCurveTo(21, 22, 23, 28);
  ctx.quadraticCurveTo(24, 31, 22, 31);
  ctx.quadraticCurveTo(19, 30, 17, 24);
  ctx.lineTo(15, 17);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  return c.toDataURL("image/png");
}

const shearsDataUrl = buildShearsCursor();
const shearsCursor = `url(${shearsDataUrl}) 6 2, crosshair`;

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
