import { MaterialId } from "./materials.js";

export interface InventoryCounts {
  flowers: number;
  [key: string]: number;
}

export type HotbarItem =
  | { kind: "pickaxe" }
  | { kind: "material"; materialId: MaterialId; count: number }
  | { kind: "empty" };

export function createDefaultInventory(): InventoryCounts {
  return { flowers: 0 };
}

export function cloneInventory(inventory: InventoryCounts): InventoryCounts {
  return { ...inventory };
}

export function createDefaultHotbar(): HotbarItem[] {
  return [
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

export function cloneHotbar(hotbar: HotbarItem[]): HotbarItem[] {
  return hotbar.map((item) => {
    if (item.kind === "material") {
      return { ...item };
    }
    return { ...item };
  });
}

const MAX_STACK = 1000;

export function addToHotbar(hotbar: HotbarItem[], materialId: MaterialId, amount = 1): boolean {
  let remaining = amount;

  for (let i = 0; i < hotbar.length && remaining > 0; i++) {
    const slot = hotbar[i];
    if (slot.kind === "material" && slot.materialId === materialId && slot.count < MAX_STACK) {
      const space = MAX_STACK - slot.count;
      const add = Math.min(remaining, space);
      slot.count += add;
      remaining -= add;
    }
  }

  for (let i = 0; i < hotbar.length && remaining > 0; i++) {
    if (hotbar[i].kind === "empty") {
      const add = Math.min(remaining, MAX_STACK);
      hotbar[i] = { kind: "material", materialId, count: add };
      remaining -= add;
    }
  }

  return remaining === 0;
}

export function removeFromHotbarSlot(hotbar: HotbarItem[], activeSlot: number): boolean {
  const slot = hotbar[activeSlot];
  if (slot?.kind !== "material") return false;
  slot.count -= 1;
  if (slot.count <= 0) {
    hotbar[activeSlot] = { kind: "empty" };
    for (let offset = 1; offset < hotbar.length; offset++) {
      const prev = activeSlot - offset;
      if (prev < 0) break;
      if (hotbar[prev].kind !== "empty") {
        return true;
      }
    }
  }
  return true;
}
