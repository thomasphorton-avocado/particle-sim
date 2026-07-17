import {
  MaterialId,
  createDefaultPlayerState,
  createDefaultWorldState,
  createPlayerId,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from "@particle-sim/shared";
import type { Character } from "./character";

export type ToolMode = "editor" | "place" | "play";
export type DayNightPreset = "morning" | "day" | "dusk" | "night";

export interface SnipAnimation {
  px: number;
  py: number;
  startTime: number;
}

export interface SimState {
  world: WorldState;
  localPlayerId: PlayerId;
  selectedMaterial: MaterialId;
  brushSize: number;
  /** Grid-space cursor position, for the placement preview. Null when the pointer is off-canvas. */
  hover: { x: number; y: number } | null;
  /** Raw pixel position on the canvas element, for drawing custom cursors. */
  hoverPixel: { x: number; y: number } | null;
  /** Active snip animation, if any. */
  snip: SnipAnimation | null;
  /** The player character. */
  character: Character | null;
  /** Current tool mode. */
  toolMode: ToolMode;
}

function getLocalPlayerState(): PlayerState {
  const player = state.world.players[state.localPlayerId];
  if (!player) {
   const created = createDefaultPlayerState(state.localPlayerId);
   state.world.players[state.localPlayerId] = created;
   return created;
  }
  return player;
}

function syncWorldDefaults(): void {
  const player = getLocalPlayerState();
  if (!player.hotbar || player.hotbar.length !== 10) {
   player.hotbar = [
     { kind: "pickaxe" },
     { kind: "material", materialId: MaterialId.Seed, count: 5 },
     { kind: "material", materialId: MaterialId.Torch, count: 5 },
     { kind: "material", materialId: MaterialId.Clock, count: 1 },
     { kind: "empty" },
     { kind: "empty" },
     { kind: "empty" },
     { kind: "empty" },
     { kind: "empty" },
     { kind: "empty" },
   ];
  }
  if (!player.inventory || typeof player.inventory.flowers !== "number") {
   player.inventory = { flowers: 0 };
  }
}

export const state: SimState = {
  world: createDefaultWorldState("room_default"),
  localPlayerId: createPlayerId("player_1"),
  selectedMaterial: MaterialId.Sand,
  brushSize: 4,
  hover: null,
  hoverPixel: null,
  snip: null,
  character: null,
  toolMode: "play",
};

syncWorldDefaults();

export function getLocalPlayer(): PlayerState {
  return getLocalPlayerState();
}

export function setDayNightPreset(preset: DayNightPreset): void {
  const presets: Record<DayNightPreset, number> = {
   morning: 0.0,
   day: 0.25,
   dusk: 0.5,
   night: 0.75,
  };
  state.world.time.dayNightCycle = presets[preset];
}

/** Returns true if the currently selected hotbar item is a pickaxe. */
export function hasPickaxeEquipped(): boolean {
  const player = getLocalPlayer();
  return player.hotbar[player.activeHotbarSlot]?.kind === "pickaxe";
}

/** Returns the material item in the active slot, or null. */
export function getActiveHotbarMaterial(): (NonNullable<PlayerState["hotbar"][number]> & { kind: "material" }) | null {
  const player = getLocalPlayer();
  const item = player.hotbar[player.activeHotbarSlot];
  return item?.kind === "material" ? item : null;
}

/**
 * Add mined material to the hotbar. Stacks into existing slots of the same
 * material (up to MAX_STACK), then fills the first empty slot.
 * Returns false if inventory is full.
 */
export function addToHotbar(materialId: MaterialId, amount: number = 1): boolean {
  const player = getLocalPlayer();
  let remaining = amount;

  for (let i = 0; i < player.hotbar.length && remaining > 0; i++) {
   const slot = player.hotbar[i];
   if (slot.kind === "material" && slot.materialId === materialId && slot.count < 1000) {
     const space = 1000 - slot.count;
     const add = Math.min(remaining, space);
     slot.count += add;
     remaining -= add;
   }
  }

  for (let i = 0; i < player.hotbar.length && remaining > 0; i++) {
   if (player.hotbar[i].kind === "empty") {
     const add = Math.min(remaining, 1000);
     player.hotbar[i] = { kind: "material", materialId, count: add };
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
  const player = getLocalPlayer();
  const slot = player.hotbar[player.activeHotbarSlot];
  if (slot?.kind !== "material") return false;
  slot.count -= 1;
  if (slot.count <= 0) {
   player.hotbar[player.activeHotbarSlot] = { kind: "empty" };
   for (let offset = 1; offset < player.hotbar.length; offset++) {
     const prev = player.activeHotbarSlot - offset;
     if (prev < 0) break;
     if (player.hotbar[prev].kind !== "empty") {
       player.activeHotbarSlot = prev;
       return true;
     }
   }
  }
  return true;
}
