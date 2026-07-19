import type { WorldState } from "@particle-sim/shared";

export interface PlayerPresentationSnapshot {
  x: number;
  y: number;
  vy: number;
}

export interface FallingObjectPresentationSnapshot {
  x: number;
  y: number;
  vy: number;
  materialId: number;
  offsets: [number, number][];
}

export interface PresentationSnapshot {
  players: Map<string, PlayerPresentationSnapshot>;
  fallingObjects: Map<string, FallingObjectPresentationSnapshot>;
}

export function createPresentationSnapshot(world: WorldState): PresentationSnapshot {
  const snapshot: PresentationSnapshot = {
    players: new Map(),
    fallingObjects: new Map(),
  };
  for (const [playerId, player] of Object.entries(world.players)) {
    snapshot.players.set(playerId, { x: player.x, y: player.y, vy: player.vy });
  }
  for (const [objectId, object] of Object.entries(world.fallingObjects)) {
    snapshot.fallingObjects.set(objectId, { x: object.x, y: object.y, vy: object.vy, materialId: object.materialId, offsets: object.offsets.map(([dx, dy]) => [dx, dy] as [number, number]) });
  }
  return snapshot;
}

function interpolatePlayerSnapshot(
  previous: PlayerPresentationSnapshot | undefined,
  current: PlayerPresentationSnapshot | undefined,
  alpha: number,
): PlayerPresentationSnapshot | undefined {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  if (!previous && !current) {
    return undefined;
  }
  if (!previous) {
    return clampedAlpha <= 0 ? undefined : { ...current! };
  }
  if (!current) {
    return clampedAlpha >= 1 ? undefined : { ...previous };
  }
  return {
    x: previous.x + (current.x - previous.x) * clampedAlpha,
    y: previous.y + (current.y - previous.y) * clampedAlpha,
    vy: previous.vy + (current.vy - previous.vy) * clampedAlpha,
  };
}

function interpolateFallingObjectSnapshot(
  previous: FallingObjectPresentationSnapshot | undefined,
  current: FallingObjectPresentationSnapshot | undefined,
  alpha: number,
): FallingObjectPresentationSnapshot | undefined {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  if (!previous && !current) {
    return undefined;
  }
  if (!previous) {
    return clampedAlpha <= 0 ? undefined : {
      x: current!.x,
      y: current!.y,
      vy: current!.vy,
      materialId: current!.materialId,
      offsets: current!.offsets.map(([dx, dy]) => [dx, dy] as [number, number]),
    };
  }
  if (!current) {
    return clampedAlpha >= 1 ? undefined : {
      x: previous.x,
      y: previous.y,
      vy: previous.vy,
      materialId: previous.materialId,
      offsets: previous.offsets.map(([dx, dy]) => [dx, dy] as [number, number]),
    };
  }
  return {
    x: previous.x + (current.x - previous.x) * clampedAlpha,
    y: previous.y + (current.y - previous.y) * clampedAlpha,
    vy: previous.vy + (current.vy - previous.vy) * clampedAlpha,
    materialId: current.materialId,
    offsets: current.offsets.length > 0 ? current.offsets.map(([dx, dy]) => [dx, dy] as [number, number]) : previous.offsets.map(([dx, dy]) => [dx, dy] as [number, number]),
  };
}

export function interpolatePresentationSnapshot(
  previous: PresentationSnapshot,
  current: PresentationSnapshot,
  alpha: number,
): PresentationSnapshot {
  const interpolated: PresentationSnapshot = {
    players: new Map(),
    fallingObjects: new Map(),
  };

  const playerIds = new Set([...previous.players.keys(), ...current.players.keys()]);
  for (const playerId of playerIds) {
    const entry = interpolatePlayerSnapshot(previous.players.get(playerId), current.players.get(playerId), alpha);
    if (entry) {
      interpolated.players.set(playerId, entry);
    }
  }

  const objectIds = new Set([...previous.fallingObjects.keys(), ...current.fallingObjects.keys()]);
  for (const objectId of objectIds) {
    const entry = interpolateFallingObjectSnapshot(previous.fallingObjects.get(objectId), current.fallingObjects.get(objectId), alpha);
    if (entry) {
      interpolated.fallingObjects.set(objectId, entry);
    }
  }

  return interpolated;
}

export function getInterpolatedPlayerSnapshot(
  previous: PresentationSnapshot,
  current: PresentationSnapshot,
  playerId: string,
  alpha: number,
): PlayerPresentationSnapshot | null {
  const previousPlayer = previous.players.get(playerId);
  const currentPlayer = current.players.get(playerId);
  if (!previousPlayer && !currentPlayer) return null;
  const interpolated = interpolatePlayerSnapshot(previousPlayer, currentPlayer, alpha);
  return interpolated ?? null;
}
