import { MaterialId } from "./materials";
import type { Character } from "./character";

export type ToolMode = "editor" | "place" | "play";

export interface InventoryCounts {
  flowers: number;
  [key: string]: number; // dynamic material inventory
}

const MAX_STACK = 1000;

export type HotbarItem =
  | { kind: "pickaxe" }
  | { kind: "material"; materialId: MaterialId; count: number }
  | { kind: "empty" };

export interface SnipAnimation {
  px: number;
  py: number;
  startTime: number;
}

export interface SimState {
  selectedMaterial: MaterialId;
  brushSize: number;
  paused: boolean;
  /** Grid-space cursor position, for the placement preview. Null when the pointer is off-canvas. */
  hover: { x: number; y: number } | null;
  /** Raw pixel position on the canvas element, for drawing custom cursors. */
  hoverPixel: { x: number; y: number } | null;
  inventory: InventoryCounts;
  /** 10-slot hotbar. */
  hotbar: HotbarItem[];
  /** Currently selected hotbar slot (0-9). */
  activeSlot: number;
  /** Active snip animation, if any. */
  snip: SnipAnimation | null;
  /** The player character. */
  character: Character | null;
  /** Current tool mode. */
  toolMode: ToolMode;
}

export const state: SimState = {
  selectedMaterial: MaterialId.Sand,
  brushSize: 4,
  paused: false,
  hover: null,
  hoverPixel: null,
  inventory: { flowers: 0 },
  hotbar: [
    { kind: "pickaxe" },
    { kind: "material", materialId: MaterialId.Seed, count: 5 },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
  ],
  activeSlot: 0,
  snip: null,
  character: null,
  toolMode: "play",
};

/** Returns true if the currently selected hotbar item is a pickaxe. */
export function hasPickaxeEquipped(): boolean {
  return state.hotbar[state.activeSlot]?.kind === "pickaxe";
}

/** Returns the material item in the active slot, or null. */
export function getActiveHotbarMaterial(): (HotbarItem & { kind: "material" }) | null {
  const item = state.hotbar[state.activeSlot];
  return item?.kind === "material" ? item : null;
}

/**
 * Add mined material to the hotbar. Stacks into existing slots of the same
 * material (up to MAX_STACK), then fills the first empty slot.
 * Returns false if inventory is full.
 */
export function addToHotbar(materialId: MaterialId, amount: number = 1): boolean {
  let remaining = amount;

  // First pass: stack into existing slots of same material
  for (let i = 0; i < state.hotbar.length && remaining > 0; i++) {
    const slot = state.hotbar[i];
    if (slot.kind === "material" && slot.materialId === materialId && slot.count < MAX_STACK) {
      const space = MAX_STACK - slot.count;
      const add = Math.min(remaining, space);
      slot.count += add;
      remaining -= add;
    }
  }

  // Second pass: fill empty slots
  for (let i = 0; i < state.hotbar.length && remaining > 0; i++) {
    if (state.hotbar[i].kind === "empty") {
      const add = Math.min(remaining, MAX_STACK);
      state.hotbar[i] = { kind: "material", materialId, count: add };
      remaining -= add;
    }
  }

  return remaining === 0;
}

/**
 * Remove one unit from the active hotbar slot (must be a material slot).
 * Clears the slot to empty when count reaches 0. Returns true if successful.
 */
export function removeFromActiveSlot(): boolean {
  const slot = state.hotbar[state.activeSlot];
  if (slot?.kind !== "material") return false;
  slot.count -= 1;
  if (slot.count <= 0) {
    state.hotbar[state.activeSlot] = { kind: "empty" };
    // Auto-select closest previous slot that has an item
    for (let offset = 1; offset < state.hotbar.length; offset++) {
      const prev = state.activeSlot - offset;
      if (prev < 0) break;
      if (state.hotbar[prev].kind !== "empty") {
        state.activeSlot = prev;
        return true;
      }
    }
  }
  return true;
}
