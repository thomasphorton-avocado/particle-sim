import { MaterialId } from "./materials";

export interface SimState {
  selectedMaterial: MaterialId;
  brushSize: number;
  paused: boolean;
  /** Grid-space cursor position, for the placement preview. Null when the pointer is off-canvas. */
  hover: { x: number; y: number } | null;
}

export const state: SimState = {
  selectedMaterial: MaterialId.Sand,
  brushSize: 4,
  paused: false,
  hover: null,
};
