import { Grid } from "./grid.js";
import { MaterialId } from "./materials.js";

/**
 * BFS to find all connected Flower cells and their connected Stem cells,
 * starting from any Flower or Stem cell. Returns the full cluster as a Set
 * of grid indices, or null if the start cell isn't a Flower or Stem.
 */
export function findFlowerCluster(grid: Grid, startX: number, startY: number): Set<number> | null {
  const startId = grid.get(startX, startY);
  if (startId !== MaterialId.Flower && startId !== MaterialId.Stem) return null;

  const cluster = new Set<number>();
  const queue: [number, number][] = [[startX, startY]];
  const key = (x: number, y: number) => y * grid.width + x;
  cluster.add(key(startX, startY));

  // First pass: find all connected Flower and Stem cells
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.inBounds(nx, ny)) continue;
      const k = key(nx, ny);
      if (cluster.has(k)) continue;
      const id = grid.get(nx, ny);
      if (id === MaterialId.Flower || id === MaterialId.Stem) {
        cluster.add(k);
        queue.push([nx, ny]);
      }
    }
  }

  return cluster;
}

/**
 * Harvests a flower cluster: removes all Flower and Stem cells connected to
 * the clicked position. Returns the number of distinct blooms harvested (0 if none).
 */
export function harvestFlowerCluster(grid: Grid, startX: number, startY: number): number {
  const cluster = findFlowerCluster(grid, startX, startY);
  if (!cluster) return 0;

  // Count distinct blooms: each bloom has a contiguous group of flower cells
  // that share a stem. We count by finding separate flower-only connected
  // components within the cluster (stems separate distinct blooms).
  const flowerIndices = new Set<number>();
  for (const idx of cluster) {
    if ((grid.ids[idx] as MaterialId) === MaterialId.Flower) {
      flowerIndices.add(idx);
    }
  }
  if (flowerIndices.size === 0) return 0;

  let bloomCount = 0;
  const visited = new Set<number>();
  for (const idx of flowerIndices) {
    if (visited.has(idx)) continue;
    bloomCount++;
    // BFS within flower cells that share the same color variant.
    // Each bloom assigns one color to all its cells, so this separates
    // overlapping blooms that happen to touch.
    const colorVariant = grid.getFlowerPalette(idx % grid.width, Math.floor(idx / grid.width));
    const q = [idx];
    visited.add(idx);
    while (q.length > 0) {
      const cur = q.shift()!;
      const cx = cur % grid.width;
      const cy = (cur - cx) / grid.width;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const k = ny * grid.width + nx;
        if (flowerIndices.has(k) && !visited.has(k)) {
          const neighborColorVariant = grid.getFlowerPalette(nx, ny);
          if (neighborColorVariant === colorVariant) {
            visited.add(k);
            q.push(k);
          }
        }
      }
    }
  }

  for (const idx of cluster) {
    const x = idx % grid.width;
    const y = Math.floor(idx / grid.width);
    grid.set(x, y, MaterialId.Empty);
  }

  return bloomCount;
}
