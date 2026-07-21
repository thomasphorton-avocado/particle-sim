import { MaterialId } from "./materials.js";

/**
 * Backing store for the simulation. `shade` is a per-cell random offset
 * (baked in when the cell is filled) so same-material regions aren't flat blocks.
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  ids: Uint8Array;
  shade: Int8Array;
  /**
   * Horizontal drift (-1/0/1) that liquids carry between steps, for waterfall dispersion.
   *
   * **Dual use for Faucet cells:** `vx` also stores the faucet flow-rate state (0 = off,
   * 1 = low, 2 = high) for cells whose `ids` entry is `MaterialId.Faucet`. Liquid-dispersion
   * code that iterates `vx` broadly should guard against touching Faucet-typed cells.
   */
  vx: Int8Array;
  private updated: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ids = new Uint8Array(width * height);
    this.shade = new Int8Array(width * height);
    this.vx = new Int8Array(width * height);
    this.updated = new Uint8Array(width * height);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  get(x: number, y: number): MaterialId {
    if (!this.inBounds(x, y)) return MaterialId.Wall;
    return this.ids[this.index(x, y)] as MaterialId;
  }

  set(x: number, y: number, id: MaterialId, shade?: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    this.ids[i] = id;
    this.shade[i] = shade ?? (((Math.random() * 21) | 0) - 10);
    this.vx[i] = 0;
  }

  clear(): void {
    this.ids.fill(MaterialId.Empty);
    this.shade.fill(0);
    this.vx.fill(0);
  }

  swap(x1: number, y1: number, x2: number, y2: number): void {
    const i1 = this.index(x1, y1);
    const i2 = this.index(x2, y2);
    const tmpId = this.ids[i1]!;
    const tmpShade = this.shade[i1]!;
    const tmpVx = this.vx[i1]!;
    this.ids[i1] = this.ids[i2]!;
    this.shade[i1] = this.shade[i2]!;
    this.vx[i1] = this.vx[i2]!;
    this.ids[i2] = tmpId;
    this.shade[i2] = tmpShade;
    this.vx[i2] = tmpVx;
  }

  getVx(x: number, y: number): number {
    return this.vx[this.index(x, y)]!;
  }

  setVx(x: number, y: number, v: number): void {
    this.vx[this.index(x, y)] = v;
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
}
