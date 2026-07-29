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
    return this.readPending();
  }

  commitPending(entries: ReadonlyArray<DirtyCellEntry>): void {
    for (const entry of entries) {
      const current = this.pendingEntries.get(entry.index);
      if (!current) continue;
      if (current.materialId !== entry.materialId || current.shade !== entry.shade || current.auxiliary !== entry.auxiliary || current.objectId !== entry.objectId || current.revision !== entry.revision) {
        continue;
      }
      this.pendingEntries.delete(entry.index);
    }
  }

  restorePending(entries: ReadonlyArray<DirtyCellEntry>): void {
    for (const entry of entries) {
      this.pendingEntries.set(entry.index, { ...entry });
    }
  }

  flush(): DirtyCellEntry[] {
    const entries = this.capturePending();
    this.pendingEntries.clear();
    return entries;
  }

  clear(): void {
    this.pendingEntries.clear();
  }
}
