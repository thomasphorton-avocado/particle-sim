import { Grid } from "./grid";
import { MATERIALS, MaterialId } from "./materials";
import { setDayNightPreset, state } from "./state";
import type { HotbarItem } from "./state";
import { setTouchControl } from "./character";

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
  MaterialId.Torch,
  MaterialId.Clock,
  MaterialId.Empty,
];

export function buildUi(root: HTMLElement, grid: Grid): void {
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const materialGroup = document.createElement("div");
  materialGroup.className = "material-group";

  const brushGroup = document.createElement("div");
  brushGroup.className = "brush-group";
  const brushInput = document.createElement("input");
  brushInput.type = "range";
  brushInput.min = "1";
  brushInput.max = "16";
  brushInput.value = String(state.brushSize);
  brushInput.addEventListener("input", () => {
    state.brushSize = Number(brushInput.value);
  });
  brushGroup.append(brushInput);

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

  // Time-of-day presets (edit mode only)
  const timeGroup = document.createElement("div");
  timeGroup.className = "time-group";
  const timePresets = [
    { label: "Morning", preset: "morning" as const },
    { label: "Day", preset: "day" as const },
    { label: "Dusk", preset: "dusk" as const },
    { label: "Night", preset: "night" as const },
  ];
  const timeButtons: HTMLButtonElement[] = [];
  for (const { label, preset } of timePresets) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      setDayNightPreset(preset);
      for (const b of timeButtons) b.classList.toggle("active", b === btn);
    });
    timeButtons.push(btn);
    timeGroup.appendChild(btn);
  }

  // Edit panel: material palette, brush size, and time presets.
  // Only visible in Edit mode.
  const makeSection = (title: string, body: HTMLElement): HTMLDivElement => {
    const section = document.createElement("div");
    section.className = "edit-section";
    const heading = document.createElement("span");
    heading.className = "edit-section-title";
    heading.textContent = title;
    section.append(heading, body);
    return section;
  };
  const editPanel = document.createElement("div");
  editPanel.className = "edit-panel";
  editPanel.append(
    makeSection("Materials", materialGroup),
    makeSection("Brush", brushGroup),
    makeSection("Time of day", timeGroup),
  );

  // Tool mode toggle
  const toolGroup = document.createElement("div");
  toolGroup.className = "tool-group";
  const editorBtn = document.createElement("button");
  editorBtn.textContent = "🗺️ Edit";
  const pickaxeBtn = document.createElement("button");
  pickaxeBtn.textContent = "🎮 Play";

  const toolBtns = [editorBtn, pickaxeBtn];
  const setToolMode = (mode: typeof state.toolMode, active: HTMLButtonElement) => {
    state.toolMode = mode;
    for (const btn of toolBtns) btn.classList.toggle("active", btn === active);
    const showPalette = mode === "editor";
    editPanel.style.display = showPalette ? "" : "none";
    if (showPalette) {
      buttons.get(state.selectedMaterial)?.classList.add("active");
    } else {
      for (const [, btn] of buttons) btn.classList.remove("active");
    }
  };
  editorBtn.addEventListener("click", () => setToolMode("editor", editorBtn));
  pickaxeBtn.addEventListener("click", () => setToolMode("play", pickaxeBtn));
  toolGroup.append(editorBtn, pickaxeBtn);

  // Flower counter
  const flowerCounter = document.createElement("span");
  flowerCounter.className = "flower-counter";
  flowerCounter.textContent = "🌸 0";
  const updateFlowerCounter = () => {
    flowerCounter.textContent = `🌸 ${state.inventory.flowers}`;
    requestAnimationFrame(updateFlowerCounter);
  };
  requestAnimationFrame(updateFlowerCounter);

  toolbar.append(toolGroup, actionGroup, flowerCounter);
  root.append(toolbar, editPanel);

  const touchHost = root.parentElement ?? root;
  const supportsTouch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  if (supportsTouch) {
    const touchOverlay = document.createElement("div");
    touchOverlay.className = "touch-controls";

    const bindTouchButton = (control: "left" | "right" | "jump", label: string, className: string) => {
      const button = document.createElement("button");
      button.className = `touch-btn ${className}`;
      button.type = "button";
      button.textContent = label;
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.setPointerCapture(event.pointerId);
        button.classList.add("active");
        setTouchControl(control, true);
      });
      button.addEventListener("pointerup", (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.remove("active");
        setTouchControl(control, false);
      });
      button.addEventListener("pointerleave", (event) => {
        if (button.hasPointerCapture(event.pointerId)) {
          button.classList.remove("active");
          setTouchControl(control, false);
        }
      });
      button.addEventListener("pointercancel", () => {
        button.classList.remove("active");
        setTouchControl(control, false);
      });
      return button;
    };

    const moveGroup = document.createElement("div");
    moveGroup.className = "touch-control-group";
    moveGroup.append(
      bindTouchButton("left", "◀", "touch-btn-left"),
      bindTouchButton("right", "▶", "touch-btn-right"),
    );

    const jumpGroup = document.createElement("div");
    jumpGroup.className = "touch-control-group";
    jumpGroup.append(bindTouchButton("jump", "⤴", "touch-btn-jump"));

    touchOverlay.append(moveGroup, jumpGroup);
    touchHost.appendChild(touchOverlay);
  }

  // Apply initial mode visibility and button states
  setToolMode(state.toolMode, pickaxeBtn);

  // --- Hotbar (below canvas) ---
  const hotbar = document.createElement("div");
  hotbar.className = "hotbar";

  const MATERIAL_EMOJI: Partial<Record<MaterialId, string>> = {
    [MaterialId.Sand]: "🟡",
    [MaterialId.Water]: "💧",
    [MaterialId.Dirt]: "🟤",
    [MaterialId.Wall]: "⬜",
    [MaterialId.Stone]: "🪨",
    [MaterialId.Wood]: "🪵",
    [MaterialId.Seed]: "🌱",
    [MaterialId.Faucet]: "🚰",
    [MaterialId.Sprinkler]: "💦",
    [MaterialId.Drain]: "🕳️",
    [MaterialId.Torch]: "🔥",
    [MaterialId.Clock]: "🕰️",
  };

  function slotLabel(item: HotbarItem): string {
    if (item.kind === "pickaxe") return "⛏️";
    if (item.kind === "material") return MATERIAL_EMOJI[item.materialId] ?? "▪️";
    return "";
  }

  function slotCount(item: HotbarItem): string {
    if (item.kind === "material" && item.count > 1) return String(item.count);
    return "";
  }

  const slotElements: HTMLButtonElement[] = [];
  const iconElements: HTMLSpanElement[] = [];
  const countElements: HTMLSpanElement[] = [];

  for (let i = 0; i < 10; i++) {
    const slot = document.createElement("button");
    slot.className = "hotbar-slot";
    const keyLabel = document.createElement("span");
    keyLabel.className = "hotbar-key";
    keyLabel.textContent = String((i + 1) % 10);
    const icon = document.createElement("span");
    icon.className = "hotbar-icon";
    const count = document.createElement("span");
    count.className = "hotbar-count";
    slot.append(keyLabel, icon, count);
    slot.addEventListener("click", () => selectSlot(i));
    slotElements.push(slot);
    iconElements.push(icon);
    countElements.push(count);
    hotbar.appendChild(slot);
  }

  function refreshHotbarSlots(): void {
    for (let i = 0; i < 10; i++) {
      const item = state.hotbar[i];
      iconElements[i].textContent = slotLabel(item);
      countElements[i].textContent = slotCount(item);
      slotElements[i].classList.toggle("active", i === state.activeSlot);
    }
  }

  function selectSlot(index: number): void {
    state.activeSlot = index;
    for (let j = 0; j < slotElements.length; j++) {
      slotElements[j].classList.toggle("active", j === index);
    }
    // Auto-switch tool mode based on item
    const item = state.hotbar[index];
    if (item.kind === "pickaxe" || item.kind === "material") {
      setToolMode("play", pickaxeBtn);
    }
  }

  // Refresh hotbar display each frame
  const updateHotbar = () => {
    refreshHotbarSlots();
    requestAnimationFrame(updateHotbar);
  };
  requestAnimationFrame(updateHotbar);

  // Initial selection
  selectSlot(state.activeSlot);

  // Number keys 1-0 select hotbar slots
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    const key = e.key;
    if (key >= "1" && key <= "9") {
      selectSlot(parseInt(key) - 1);
      e.preventDefault();
    } else if (key === "0") {
      selectSlot(9);
      e.preventDefault();
    }
  });

  // Scroll wheel cycles hotbar slots
  window.addEventListener("wheel", (e) => {
    const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const next = ((state.activeSlot + dir) % 10 + 10) % 10;
    selectSlot(next);
  }, { passive: false });

  // Insert hotbar after canvas
  const canvas = document.querySelector("#sim-canvas");
  if (canvas && canvas.parentElement) {
    canvas.parentElement.insertBefore(hotbar, canvas.nextSibling);
  }
}
