import { FLOWER_PALETTE, MaterialId } from "./materials.js";
import { hashVisualShade } from "./random.js";
import type { ObjectId } from "./ids.js";
import type { WorldState } from "./world-state.js";

function assertFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function assertInteger(value: number, label = "value"): number {
  const finite = assertFiniteNumber(value, label);
  if (!Number.isInteger(finite)) {
    throw new RangeError(`${label} must be an integer`);
  }
  return finite;
}

export function assertAuxiliaryValueForMaterial(materialId: MaterialId, value: number): number {
  const integer = assertInteger(value, "auxiliary value");
  if (integer < -128 || integer > 127) throw new RangeError("auxiliary value must fit in an Int8");
  switch (materialId) {
    case MaterialId.Water:
      if (integer < -4 || integer > 4) throw new RangeError("water level must be between -4 and 4");
      return integer;
    case MaterialId.Faucet:
      if (integer < 0 || integer > 2) throw new RangeError("faucet flow must be between 0 and 2");
      return integer;
    case MaterialId.Flower:
      if (integer < 0 || integer >= FLOWER_PALETTE.length) throw new RangeError("flower palette index is out of range");
      return integer;
    case MaterialId.Dirt:
      if (integer < 0 || integer > 12) throw new RangeError("dirt moisture must be between 0 and 12");
      return integer;
    case MaterialId.Stem:
      if (integer < 0 || integer > 10) throw new RangeError("stem budget must be between 0 and 10");
      return integer;
    default:
      if (integer !== 0) throw new RangeError("auxiliary value must be 0 for this material");
      return integer;
  }
}

export interface GridSetOptions {
  shade?: number;
  objectId?: ObjectId | null;
}

export interface WorldCellPlacementOptions extends GridSetOptions {
  salt?: number;
}

export function placeWorldCell(world: WorldState, x: number, y: number, materialId: MaterialId, options?: WorldCellPlacementOptions): void {
  const shade = materialId === MaterialId.Empty
    ? 0
    : (options?.shade ?? hashVisualShade(world.random.seed, x, y, materialId, options?.salt ?? 0));
  world.grid.set(x, y, materialId, { ...options, shade });
}

export class Grid {
  readonly width: number;
  readonly height: number;
  ids: Uint8Array;
  shade: Int8Array;
  auxiliary: Int8Array;
  objectIds: Array<ObjectId | null>;
  cellRevisions: Uint32Array;
  private updated: Uint8Array;
  private objectCellIndex: Map<string, Set<number>>;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ids = new Uint8Array(width * height);
    this.shade = new Int8Array(width * height);
    this.auxiliary = new Int8Array(width * height);
    this.objectIds = new Array(width * height).fill(null);
    this.cellRevisions = new Uint32Array(width * height);
    this.updated = new Uint8Array(width * height);
    this.objectCellIndex = new Map();
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private assertInBounds(x: number, y: number): number {
    if (!this.inBounds(x, y)) {
      throw new RangeError(`grid coordinate (${x}, ${y}) is out of bounds`);
    }
    return this.index(x, y);
  }

  get(x: number, y: number): MaterialId {
    if (!this.inBounds(x, y)) return MaterialId.Wall;
    return this.ids[this.index(x, y)] as MaterialId;
  }

  private setObjectIndexEntry(index: number, objectId: ObjectId | null): void {
    const previous = this.objectIds[index];
    if (previous === objectId) return;
    if (previous) {
      const cells = this.objectCellIndex.get(previous);
      if (cells) {
        cells.delete(index);
        if (cells.size === 0) this.objectCellIndex.delete(previous);
      }
    }
    if (objectId) {
      let cells = this.objectCellIndex.get(objectId);
      if (!cells) {
        cells = new Set<number>();
        this.objectCellIndex.set(objectId, cells);
      }
      cells.add(index);
    }
    this.objectIds[index] = objectId;
  }

  private incrementCellRevision(index: number): void {
    this.cellRevisions[index] = (this.cellRevisions[index] + 1) >>> 0;
  }

  private tupleChanged(index: number, id: MaterialId, shade: number, auxiliary: number, objectId: ObjectId | null): boolean {
    return this.ids[index] !== id || this.shade[index] !== shade || this.auxiliary[index] !== auxiliary || this.objectIds[index] !== objectId;
  }

  set(x: number, y: number, id: MaterialId, options?: GridSetOptions): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    const nextShade = options?.shade ?? 0;
    const nextAuxiliary = 0;
    const nextObjectId = options?.objectId ?? null;
    if (this.tupleChanged(i, id, nextShade, nextAuxiliary, nextObjectId)) {
      this.incrementCellRevision(i);
    }
    this.ids[i] = id;
    this.shade[i] = nextShade;
    this.auxiliary[i] = nextAuxiliary;
    this.setObjectIndexEntry(i, nextObjectId);
  }

  clear(): void {
    for (let i = 0; i < this.ids.length; i++) {
      if (this.ids[i] === MaterialId.Empty && this.shade[i] === 0 && this.auxiliary[i] === 0 && this.objectIds[i] === null) continue;
      this.incrementCellRevision(i);
    }
    this.ids.fill(MaterialId.Empty);
    this.shade.fill(0);
    this.auxiliary.fill(0);
    this.objectIds.fill(null);
    this.objectCellIndex.clear();
  }

  swap(x1: number, y1: number, x2: number, y2: number): void {
    const i1 = this.index(x1, y1);
    const i2 = this.index(x2, y2);
    const nextTuple1 = { id: this.ids[i2]!, shade: this.shade[i2]!, auxiliary: this.auxiliary[i2]!, objectId: this.objectIds[i2]! };
    const nextTuple2 = { id: this.ids[i1]!, shade: this.shade[i1]!, auxiliary: this.auxiliary[i1]!, objectId: this.objectIds[i1]! };
    const currentTuple1 = { id: this.ids[i1]!, shade: this.shade[i1]!, auxiliary: this.auxiliary[i1]!, objectId: this.objectIds[i1]! };
    const currentTuple2 = { id: this.ids[i2]!, shade: this.shade[i2]!, auxiliary: this.auxiliary[i2]!, objectId: this.objectIds[i2]! };
    if (currentTuple1.id !== nextTuple1.id || currentTuple1.shade !== nextTuple1.shade || currentTuple1.auxiliary !== nextTuple1.auxiliary || currentTuple1.objectId !== nextTuple1.objectId) {
      this.incrementCellRevision(i1);
    }
    if (currentTuple2.id !== nextTuple2.id || currentTuple2.shade !== nextTuple2.shade || currentTuple2.auxiliary !== nextTuple2.auxiliary || currentTuple2.objectId !== nextTuple2.objectId) {
      this.incrementCellRevision(i2);
    }
    const tmpId = this.ids[i1]!;
    const tmpShade = this.shade[i1]!;
    const tmpAuxiliary = this.auxiliary[i1]!;
    const tmpObjectId = this.objectIds[i1]!;
    this.ids[i1] = this.ids[i2]!;
    this.shade[i1] = this.shade[i2]!;
    this.auxiliary[i1] = this.auxiliary[i2]!;
    this.objectIds[i1] = this.objectIds[i2]!;
    this.ids[i2] = tmpId;
    this.shade[i2] = tmpShade;
    this.auxiliary[i2] = tmpAuxiliary;
    this.objectIds[i2] = tmpObjectId;
    this.setObjectIndexEntry(i1, this.objectIds[i1]);
    this.setObjectIndexEntry(i2, this.objectIds[i2]);
  }

  setObjectCell(x: number, y: number, objectId: ObjectId): void {
    const i = this.assertInBounds(x, y);
    const previousObjectId = this.objectIds[i];
    const nextObjectId = objectId;
    if (previousObjectId !== nextObjectId) this.incrementCellRevision(i);
    this.setObjectIndexEntry(i, nextObjectId);
  }

  getObjectId(x: number, y: number): ObjectId | null {
    const i = this.assertInBounds(x, y);
    return this.objectIds[i] ?? null;
  }

  clearObjectCell(x: number, y: number): void {
    const i = this.assertInBounds(x, y);
    if (this.objectIds[i] !== null) this.incrementCellRevision(i);
    this.setObjectIndexEntry(i, null);
  }

  hasObjectId(objectId: ObjectId): boolean {
    return this.objectCellIndex.has(objectId);
  }

  clearObjectById(objectId: ObjectId): void {
    const cells = this.objectCellIndex.get(objectId);
    if (!cells) return;
    for (const index of Array.from(cells)) {
      const x = index % this.width;
      const y = Math.floor(index / this.width);
      this.set(x, y, MaterialId.Empty);
    }
  }

  getCellForObjectId(objectId: ObjectId): [number, number] | null {
    const cells = this.objectCellIndex.get(objectId);
    if (!cells || cells.size === 0) return null;
    const index = Array.from(cells)[0]!;
    return [index % this.width, Math.floor(index / this.width)];
  }

  getAuxiliaryValue(x: number, y: number): number {
    return this.auxiliary[this.assertInBounds(x, y)]!;
  }

  setAuxiliaryValue(x: number, y: number, value: number): void {
    const i = this.assertInBounds(x, y);
    const integer = assertAuxiliaryValueForMaterial(this.get(x, y), value);
    if (this.auxiliary[i] !== integer) this.incrementCellRevision(i);
    this.auxiliary[i] = integer;
  }

  getVx(x: number, y: number): number {
    switch (this.get(x, y)) {
      case MaterialId.Water:
        return this.getWaterLiquidMemory(x, y);
      case MaterialId.Faucet:
        return this.getFaucetFlow(x, y);
      case MaterialId.Flower:
        return this.getFlowerPalette(x, y);
      case MaterialId.Dirt:
        return this.getDirtMoisture(x, y);
      case MaterialId.Stem:
        return this.getStemBudget(x, y);
      default:
        return this.getAuxiliaryValue(x, y);
    }
  }

  setVx(x: number, y: number, value: number): void {
    switch (this.get(x, y)) {
      case MaterialId.Water:
        this.setWaterLiquidMemory(x, y, value);
        return;
      case MaterialId.Faucet:
        this.setFaucetFlow(x, y, value);
        return;
      case MaterialId.Flower:
        this.setFlowerPalette(x, y, value);
        return;
      case MaterialId.Dirt:
        this.setDirtMoisture(x, y, value);
        return;
      case MaterialId.Stem:
        this.setStemBudget(x, y, value);
        return;
      default:
        this.setAuxiliaryValue(x, y, value);
    }
  }

  getWaterLiquidMemory(x: number, y: number): number {
    if (this.get(x, y) !== MaterialId.Water) throw new TypeError("water liquid memory requires a water cell");
    return this.getAuxiliaryValue(x, y);
  }

  setWaterLiquidMemory(x: number, y: number, value: number): void {
    if (this.get(x, y) !== MaterialId.Water) throw new TypeError("water liquid memory requires a water cell");
    const integer = assertInteger(value);
    if (integer < -4 || integer > 4) throw new RangeError("water liquid memory must be between -4 and 4");
    this.setAuxiliaryValue(x, y, integer);
  }

  getWaterLevel(x: number, y: number): number {
    return this.getWaterLiquidMemory(x, y);
  }

  setWaterLevel(x: number, y: number, value: number): void {
    this.setWaterLiquidMemory(x, y, value);
  }

  getFaucetFlow(x: number, y: number): number {
    if (this.get(x, y) !== MaterialId.Faucet) throw new TypeError("faucet flow requires a faucet cell");
    return this.getAuxiliaryValue(x, y);
  }

  setFaucetFlow(x: number, y: number, value: number): void {
    if (this.get(x, y) !== MaterialId.Faucet) throw new TypeError("faucet flow requires a faucet cell");
    const integer = assertInteger(value);
    if (integer < 0 || integer > 2) throw new RangeError("faucet flow must be between 0 and 2");
    this.setAuxiliaryValue(x, y, integer);
  }

  getFlowerPalette(x: number, y: number): number {
    if (this.get(x, y) !== MaterialId.Flower) throw new TypeError("flower palette requires a flower cell");
    return this.getAuxiliaryValue(x, y);
  }

  setFlowerPalette(x: number, y: number, value: number): void {
    if (this.get(x, y) !== MaterialId.Flower) throw new TypeError("flower palette requires a flower cell");
    const integer = assertInteger(value);
    if (integer < 0 || integer >= FLOWER_PALETTE.length) throw new RangeError("flower palette index is out of range");
    this.setAuxiliaryValue(x, y, integer);
  }

  getFlowerPaletteIndex(x: number, y: number): number {
    return this.getFlowerPalette(x, y);
  }

  setFlowerPaletteIndex(x: number, y: number, value: number): void {
    this.setFlowerPalette(x, y, value);
  }

  getDirtMoisture(x: number, y: number): number {
    if (this.get(x, y) !== MaterialId.Dirt) throw new TypeError("dirt moisture requires a dirt cell");
    return this.getAuxiliaryValue(x, y);
  }

  setDirtMoisture(x: number, y: number, value: number): void {
    if (this.get(x, y) !== MaterialId.Dirt) throw new TypeError("dirt moisture requires a dirt cell");
    const integer = assertInteger(value);
    if (integer < 0 || integer > 12) throw new RangeError("dirt moisture must be between 0 and 12");
    this.setAuxiliaryValue(x, y, integer);
  }

  getStemBudget(x: number, y: number): number {
    if (this.get(x, y) !== MaterialId.Stem) throw new TypeError("stem budget requires a stem cell");
    return this.getAuxiliaryValue(x, y);
  }

  setStemBudget(x: number, y: number, value: number): void {
    if (this.get(x, y) !== MaterialId.Stem) throw new TypeError("stem budget requires a stem cell");
    const integer = assertInteger(value);
    if (integer < 0 || integer > 10) throw new RangeError("stem budget must be between 0 and 10");
    this.setAuxiliaryValue(x, y, integer);
  }

  markUpdated(x: number, y: number): void {
    this.updated[this.index(x, y)] = 1;
  }

  wasUpdated(x: number, y: number): boolean {
    return this.updated[this.index(x, y)] === 1;
  }

  resetUpdated(): void {
    this.updated.fill(0);
  }

  rebuildObjectCellIndex(): void {
    this.objectCellIndex.clear();
    for (let i = 0; i < this.objectIds.length; i++) {
      const objectId = this.objectIds[i];
      if (!objectId) continue;
      let cells = this.objectCellIndex.get(objectId);
      if (!cells) {
        cells = new Set<number>();
        this.objectCellIndex.set(objectId, cells);
      }
      cells.add(i);
    }
  }
}
