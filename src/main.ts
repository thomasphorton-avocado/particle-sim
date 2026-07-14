import "./style.css";
import { Grid } from "./grid";
import { Renderer } from "./renderer";
import { step } from "./simulation";
import { attachInput } from "./input";
import { buildUi } from "./ui";
import { state } from "./state";
import { MATERIALS, MaterialId } from "./materials";

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

function loop(): void {
  if (!state.paused) {
    step(grid);
  }
  renderer.draw(grid);

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
