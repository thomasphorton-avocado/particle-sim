import { MaterialId } from "./materials";

export interface Inventory {
  flowers: number;
}

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
  inventory: Inventory;
  /** Active snip animation, if any. */
  snip: SnipAnimation | null;
}

export const state: SimState = {
  selectedMaterial: MaterialId.Sand,
  brushSize: 4,
  paused: false,
  hover: null,
  hoverPixel: null,
  inventory: { flowers: 0 },
  snip: null,
};
