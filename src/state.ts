import {
  MaterialId,
  LocalTransport,
  addToHotbar as addToHotbarHelper,
  cloneHotbar,
  cloneInventory,
  createDefaultHotbar,
  createDefaultInventory,
  createDefaultPlayerState,
  createDefaultWorldState,
  createPlayerId,
  removeFromHotbarSlot as removeFromHotbarSlotHelper,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from "@particle-sim/shared";
import type { CharacterRuntime } from "./character";

export type ToolMode = "editor" | "place" | "play";
export type DayNightPreset = "morning" | "day" | "dusk" | "night";

export interface SnipAnimation {
  px: number;
  py: number;
  startTime: number;
}

export interface SimState {
  world: WorldState;
  transport: LocalTransport;
  localPlayerId: PlayerId;
  selectedMaterial: MaterialId;
  brushSize: number;
  /** Grid-space cursor position, for the placement preview. Null when the pointer is off-canvas. */
  hover: { x: number; y: number } | null;
  /** Raw pixel position on the canvas element, for drawing custom cursors. */
  hoverPixel: { x: number; y: number } | null;
  /** Active snip animation, if any. */
  snip: SnipAnimation | null;
  /** The player character runtime. */
  character: CharacterRuntime | null;
  /** Current tool mode. */
  toolMode: ToolMode;
}

function getLocalPlayerState(): PlayerState {
  let player = currentWorld.players[state.localPlayerId];
  if (!player) {
    player = createDefaultPlayerState(state.localPlayerId);
    currentWorld.players[state.localPlayerId] = player;
  }
  return player;
}

function syncWorldDefaults(): void {
  const defaults = createDefaultInventory();
  const player = getLocalPlayerState();
  const nextInventory = { ...defaults, ...cloneInventory(player.inventory) };
  const nextHotbar = player.hotbar.length === 10 ? cloneHotbar(player.hotbar) : createDefaultHotbar();
  player.inventory = nextInventory;
  player.hotbar = nextHotbar;
  transport.createEditorAccess().mutateWorld((world) => {
    const worldPlayer = world.players[state.localPlayerId];
    if (!worldPlayer) return;
    worldPlayer.inventory = { ...defaults, ...cloneInventory(worldPlayer.inventory) };
    worldPlayer.hotbar = worldPlayer.hotbar.length === 10 ? cloneHotbar(worldPlayer.hotbar) : createDefaultHotbar();
  });
}

const defaultWorld = createDefaultWorldState("room_default");
let transport = new LocalTransport(defaultWorld);
let currentWorld: WorldState = transport.getClientWorld();
let unsubscribeTransport: (() => void) | null = null;

function installTransport(nextTransport: LocalTransport): void {
  if (unsubscribeTransport) {
    unsubscribeTransport();
  }
  transport = nextTransport;
  currentWorld = nextTransport.getClientWorld();
  unsubscribeTransport = nextTransport.subscribe((view) => {
    currentWorld = view.clientWorld;
  });
}

const stateBase: SimState = {
  world: currentWorld,
  transport,
  localPlayerId: createPlayerId("player_1"),
  selectedMaterial: MaterialId.Sand,
  brushSize: 4,
  hover: null,
  hoverPixel: null,
  snip: null,
  character: null,
  toolMode: "play",
};

Object.defineProperty(stateBase, "world", {
  get() {
    return currentWorld;
  },
  set(nextWorld: WorldState) {
    currentWorld = nextWorld;
    transport.createEditorAccess().replaceWorld(nextWorld);
  },
  enumerable: true,
  configurable: true,
});

Object.defineProperty(stateBase, "transport", {
  get() {
    return transport;
  },
  set(nextTransport: LocalTransport) {
    installTransport(nextTransport);
  },
  enumerable: true,
  configurable: true,
});

export const state = stateBase;

installTransport(transport);
syncWorldDefaults();

export function getLocalPlayer(): PlayerState {
  return getLocalPlayerState();
}

export function setDayNightPreset(preset: DayNightPreset): void {
  state.transport.enqueueCommand({
    type: "set_time_preset",
    preset,
    expectedWorldRevision: state.world.worldRevision,
  });
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
  return addToHotbarHelper(player.hotbar, materialId, amount);
}

/**
 * Remove one unit from the active hotbar slot (must be a material slot).
 * Clears the slot to empty when count reaches 0. Returns true if successful.
 */
export function removeFromActiveSlot(): boolean {
  const player = getLocalPlayer();
  const success = removeFromHotbarSlotHelper(player.hotbar, player.activeHotbarSlot);
  if (!success) return false;
  if (player.hotbar[player.activeHotbarSlot]?.kind === "empty") {
   for (let offset = 1; offset < player.hotbar.length; offset++) {
     const prev = player.activeHotbarSlot - offset;
     if (prev < 0) break;
     if (player.hotbar[prev].kind !== "empty") {
       player.activeHotbarSlot = prev;
       break;
     }
   }
  }
  return true;
}
