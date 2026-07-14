import { Grid } from "./grid";
import { MATERIALS, MaterialId } from "./materials";
import { state } from "./state";

const PALETTE: MaterialId[] = [
  MaterialId.Sand,
  MaterialId.Water,
  MaterialId.Dirt,
  MaterialId.Wall,
  MaterialId.Stone,
  MaterialId.Wood,
  MaterialId.Seed,
  MaterialId.Faucet,
  MaterialId.Sprinkler,
  MaterialId.Drain,
  MaterialId.Empty,
];

export function buildUi(root: HTMLElement, grid: Grid): void {
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const materialGroup = document.createElement("div");
  materialGroup.className = "material-group";

  const brushGroup = document.createElement("div");
  brushGroup.className = "brush-group";
  const brushLabel = document.createElement("label");
  brushLabel.textContent = "Brush";
  const brushInput = document.createElement("input");
  brushInput.type = "range";
  brushInput.min = "1";
  brushInput.max = "16";
  brushInput.value = String(state.brushSize);
  brushInput.addEventListener("input", () => {
    state.brushSize = Number(brushInput.value);
  });
  brushGroup.append(brushLabel, brushInput);

  const updateBrushAvailability = () => {
    const isObject = MATERIALS[state.selectedMaterial].placement.kind === "object";
    brushInput.disabled = isObject;
    brushGroup.classList.toggle("disabled", isObject);
  };

  const buttons = new Map<MaterialId, HTMLButtonElement>();
  for (const id of PALETTE) {
    const material = MATERIALS[id];
    const btn = document.createElement("button");
    btn.className = "material-btn";
    btn.title = material.name;
    btn.textContent = material.name;
    const [r, g, b] = material.color;
    btn.style.setProperty("--swatch", `rgb(${r}, ${g}, ${b})`);
    btn.addEventListener("click", () => {
      state.selectedMaterial = id;
      for (const [otherId, otherBtn] of buttons) {
        otherBtn.classList.toggle("active", otherId === id);
      }
      updateBrushAvailability();
    });
    buttons.set(id, btn);
    materialGroup.appendChild(btn);
  }
  buttons.get(state.selectedMaterial)?.classList.add("active");
  updateBrushAvailability();

  const actionGroup = document.createElement("div");
  actionGroup.className = "action-group";

  const pauseBtn = document.createElement("button");
  pauseBtn.textContent = "Pause";
  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  });

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => grid.clear());

  actionGroup.append(pauseBtn, clearBtn);

  // Inventory display
  const inventoryGroup = document.createElement("div");
  inventoryGroup.className = "inventory-group";
  const flowerCount = document.createElement("span");
  flowerCount.className = "inventory-item";
  flowerCount.textContent = "🌸 0";
  inventoryGroup.appendChild(flowerCount);

  // Poll inventory state each frame (cheap, no events needed)
  const updateInventory = () => {
    flowerCount.textContent = `🌸 ${state.inventory.flowers}`;
    requestAnimationFrame(updateInventory);
  };
  requestAnimationFrame(updateInventory);

  toolbar.append(materialGroup, brushGroup, actionGroup, inventoryGroup);
  root.appendChild(toolbar);
}
