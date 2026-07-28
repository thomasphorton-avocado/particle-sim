import type { MaterialId } from "./materials.js";
import type { ObjectId } from "./ids.js";

export interface DirtyCellEntry {
  index: number;
  materialId: MaterialId;
  shade: number;
  auxiliary: number;
  objectId: ObjectId | null;
  revision: number;
}

export class DirtyCellJournal {
  private pendingEntries = new Map<number, DirtyCellEntry>();

  get size(): number {
    return this.pendingEntries.size;
  }

  record(index: number, materialId: MaterialId, shade: number, auxiliary: number, objectId: ObjectId | null, revision: number): void {
    this.pendingEntries.set(index, {
      index,
      materialId,
      shade,
      auxiliary,
      objectId,
      revision,
    });
  }

  readPending(): DirtyCellEntry[] {
    return Array.from(this.pendingEntries.values())
      .sort((left, right) => left.index - right.index);
  }

  capturePending(): DirtyCellEntry[] {
    const entries = this.readPending();
    for (const entry of entries) {
      this.pendingEntries.delete(entry.index);
    }
    return entries;
  }

  flush(): DirtyCellEntry[] {
    return this.capturePending();
  }

  clear(): void {
    this.pendingEntries.clear();
  }
}
