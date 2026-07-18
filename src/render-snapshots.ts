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
    snapshot.fallingObjects.set(objectId, { x: object.x, y: object.y, vy: object.vy });
  }
  return snapshot;
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
  for (const [playerId, prevPlayer] of previous.players.entries()) {
    const nextPlayer = current.players.get(playerId);
    if (!nextPlayer) continue;
    interpolated.players.set(playerId, {
      x: prevPlayer.x + (nextPlayer.x - prevPlayer.x) * alpha,
      y: prevPlayer.y + (nextPlayer.y - prevPlayer.y) * alpha,
      vy: prevPlayer.vy + (nextPlayer.vy - prevPlayer.vy) * alpha,
    });
  }
  for (const [objectId, prevObject] of previous.fallingObjects.entries()) {
    const nextObject = current.fallingObjects.get(objectId);
    if (!nextObject) continue;
    interpolated.fallingObjects.set(objectId, {
      x: prevObject.x + (nextObject.x - prevObject.x) * alpha,
      y: prevObject.y + (nextObject.y - prevObject.y) * alpha,
      vy: prevObject.vy + (nextObject.vy - prevObject.vy) * alpha,
    });
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
  if (!previousPlayer || !currentPlayer) return null;
  return {
    x: previousPlayer.x + (currentPlayer.x - previousPlayer.x) * alpha,
    y: previousPlayer.y + (currentPlayer.y - previousPlayer.y) * alpha,
    vy: previousPlayer.vy + (currentPlayer.vy - previousPlayer.vy) * alpha,
  };
}
