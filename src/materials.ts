export const MaterialId = {
  Empty: 0,
  Sand: 1,
  Water: 2,
  Wall: 3,
  Stone: 4,
  Wood: 5,
  Seed: 6,
  Stem: 7,
  Flower: 8,
  Drain: 9,
  Faucet: 10,
  Dirt: 11,
  Sprinkler: 12,
} as const;
export type MaterialId = (typeof MaterialId)[keyof typeof MaterialId];

export const MaterialPhase = {
  Gas: 0,
  Powder: 1,
  Liquid: 2,
  Solid: 3,
} as const;
export type MaterialPhase = (typeof MaterialPhase)[keyof typeof MaterialPhase];

/** Painted freehand with the brush, one cell at a time along the drag path. */
export interface BrushPlacement {
  kind: "brush";
}

/** Stamped down as a whole fixed-size shape on click, rather than painted. */
export interface ObjectPlacement {
  kind: "object";
  shape: "rect" | "circle";
  width: number;
  height: number;
}

export type Placement = BrushPlacement | ObjectPlacement;

export interface Material {
  id: MaterialId;
  name: string;
  color: [number, number, number];
  colorVariance: number;
  phase: MaterialPhase;
  density: number;
  /** Liquids: how many cells sideways it may try to flow per step. */
  flowRate?: number;
  /** If true, liquid flows through this cell as if it were empty. */
  permeable?: boolean;
  placement: Placement;
}

export const MATERIALS: Record<MaterialId, Material> = {
  [MaterialId.Empty]: {
    id: MaterialId.Empty,
    name: "Eraser",
    color: [0, 0, 0],
    colorVariance: 0,
    phase: MaterialPhase.Gas,
    density: 0,
    placement: { kind: "brush" },
  },
  [MaterialId.Sand]: {
    id: MaterialId.Sand,
    name: "Sand",
    color: [237, 201, 175],
    colorVariance: 14,
    phase: MaterialPhase.Powder,
    density: 5,
    placement: { kind: "brush" },
  },
  [MaterialId.Water]: {
    id: MaterialId.Water,
    name: "Water",
    color: [64, 145, 235],
    colorVariance: 10,
    phase: MaterialPhase.Liquid,
    density: 2,
    flowRate: 4,
    placement: { kind: "brush" },
  },
  [MaterialId.Wall]: {
    id: MaterialId.Wall,
    name: "Wall",
    color: [90, 90, 100],
    colorVariance: 6,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "brush" },
  },
  [MaterialId.Stone]: {
    id: MaterialId.Stone,
    name: "Stone",
    color: [140, 138, 132],
    colorVariance: 10,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "object", shape: "circle", width: 16, height: 16 },
  },
  [MaterialId.Wood]: {
    id: MaterialId.Wood,
    name: "Wood",
    color: [122, 84, 45],
    colorVariance: 12,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "object", shape: "rect", width: 48, height: 8 },
  },
  [MaterialId.Seed]: {
    id: MaterialId.Seed,
    name: "Seed",
    color: [94, 65, 34],
    colorVariance: 8,
    phase: MaterialPhase.Powder,
    density: 4,
    placement: { kind: "object", shape: "rect", width: 1, height: 1 },
  },
  [MaterialId.Stem]: {
    id: MaterialId.Stem,
    name: "Stem",
    color: [63, 128, 58],
    colorVariance: 10,
    phase: MaterialPhase.Solid,
    density: Infinity,
    permeable: true,
    placement: { kind: "brush" },
  },
  [MaterialId.Flower]: {
    id: MaterialId.Flower,
    name: "Flower",
    color: [232, 96, 150],
    colorVariance: 18,
    phase: MaterialPhase.Solid,
    density: Infinity,
    permeable: true,
    placement: { kind: "brush" },
  },
  [MaterialId.Drain]: {
    id: MaterialId.Drain,
    name: "Drain",
    color: [72, 80, 92],
    colorVariance: 12,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "object", shape: "rect", width: 32, height: 6 },
  },
  [MaterialId.Faucet]: {
    id: MaterialId.Faucet,
    name: "Faucet",
    color: [110, 120, 140],
    colorVariance: 8,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "object", shape: "rect", width: 10, height: 6 },
  },
  [MaterialId.Dirt]: {
    id: MaterialId.Dirt,
    name: "Dirt",
    color: [155, 118, 83],
    colorVariance: 10,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "brush" },
  },
  [MaterialId.Sprinkler]: {
    id: MaterialId.Sprinkler,
    name: "Sprinkler",
    color: [80, 160, 100],
    colorVariance: 8,
    phase: MaterialPhase.Solid,
    density: Infinity,
    placement: { kind: "object", shape: "rect", width: 6, height: 4 },
  },
};

/**
 * Alternate bloom colors a flower can randomly take on (index stored per-cell
 * in the grid's `vx` field, since Flower cells have no other use for it).
 * MATERIALS[Flower].color is FLOWER_PALETTE[0], kept as the display default.
 */
export const FLOWER_PALETTE: [number, number, number][] = [
  [232, 96, 150], // pink
  [186, 120, 224], // lavender
  [247, 200, 90], // yellow
  [237, 110, 90], // coral
  [248, 246, 238], // cream white
];

export function isEmpty(id: MaterialId): boolean {
  return id === MaterialId.Empty;
}

export function isStatic(id: MaterialId): boolean {
  return MATERIALS[id].phase === MaterialPhase.Solid;
}
