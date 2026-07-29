import assert from "node:assert/strict";
import test from "node:test";
import { createGameplayRandomState, type RoomId } from "@particle-sim/shared";
import { Room, type RoomConfig, type RoomDependencies } from "../src/room/room.js";
import { DeadlineScheduler, type Clock } from "../src/room/scheduler.js";
import { RoomManager } from "../src/room/room-manager.js";

class FakeClock implements Clock {
  #nowMs: number;

  constructor(startMs = 0) {
    this.#nowMs = startMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

class TestPublisher {
  publications: Array<{ reason: string; checksum: string }> = [];

  publish(publication: { reason: string; checksum: string }): void {
    this.publications.push(publication);
  }
}

function createTestRoom(configOverrides: Partial<RoomConfig> = {}) {
  const clock = new FakeClock();
  const scheduler = new DeadlineScheduler(clock, 100, 2);
  const publisher = new TestPublisher();
  const room = new Room(
    {
      roomId: `room_${Math.random().toString(36).slice(2, 8)}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
      ...configOverrides,
    },
    { clock, scheduler, publisher } as RoomDependencies,
  );
  return { room, clock, scheduler, publisher };
}

test("rooms stay isolated while advancing deterministically", async () => {
  const roomA = createTestRoom();
  const roomB = createTestRoom();

  const joinA = roomA.room.enqueueJoin({ sessionId: "session-a", connectionId: "conn-a", connectionOrdinal: 1, generation: 1 });
  const joinB = roomB.room.enqueueJoin({ sessionId: "session-b", connectionId: "conn-b", connectionOrdinal: 1, generation: 1 });
  assert.equal(joinA.accepted, true);
  assert.equal(joinB.accepted, true);
  await roomA.room.flushPendingIngresses();
  await roomB.room.flushPendingIngresses();

  roomA.room.handleTick();
  roomB.room.handleTick();

  assert.equal(roomA.room.state.tick, 1);
  assert.equal(roomB.room.state.tick, 1);
  assert.notStrictEqual(roomA.room.world.players, roomB.room.world.players);
  assert.notEqual(roomA.room.world.roomId, roomB.room.world.roomId);
});

test("deadline scheduler catches up without overlap", () => {
  const clock = new FakeClock();
  const scheduler = new DeadlineScheduler(clock, 100, 2);
  let active = 0;
  let callbacks = 0;

  scheduler.start(() => {
    active += 1;
    callbacks += 1;
    assert.equal(active, 1);
    active -= 1;
  });

  clock.advance(250);
  const ticks = scheduler.drive(clock.nowMs());

  assert.equal(ticks, 2);
  assert.equal(callbacks, 2);
  assert.equal(scheduler.state.lastDelayKind, "catch-up");
});

test("capacity, duplicate joins, and deterministic owner transfer", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1, generation: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "two", connectionId: "conn-2", connectionOrdinal: 2, generation: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "three", connectionId: "conn-3", connectionOrdinal: 3, generation: 1 }).accepted, false);

  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 2);
  assert.equal(room.room.memberships[0]?.owner, true);

  const leave = room.room.enqueueLeave({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1, generation: 1 });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 1);
  assert.equal(room.room.memberships[0]?.sessionId, "two");
  assert.equal(room.room.memberships[0]?.owner, true);
});

test("stale generations are fenced from rejoined players", async () => {
  const room = createTestRoom();

  assert.equal(room.room.enqueueJoin({ sessionId: "stale", connectionId: "conn-1", connectionOrdinal: 1, generation: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const leave = room.room.enqueueLeave({ sessionId: "stale", connectionId: "conn-1", connectionOrdinal: 2, generation: 1 });
  assert.equal(leave.accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "stale", connectionId: "conn-2", connectionOrdinal: 3, generation: 2 }).accepted, true);
  await room.room.flushPendingIngresses();

  const staleCommand = room.room.enqueueCommand({
    membershipId: "membership_1",
    sessionId: "stale",
    connectionId: "conn-2",
    connectionOrdinal: 4,
    generation: 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(staleCommand.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.activeCommandReceipts.length, 0);
});

test("empty rooms freeze while preserving deterministic world state", async () => {
  const room = createTestRoom();
  room.room.world.tick = 14;
  room.room.world.paused = true;
  room.room.world.weather.kind = "storm";
  room.room.world.weather.wind = -3;
  room.room.world.time.dayNightTick = 404;
  room.room.world.random = createGameplayRandomState(999);

  const before = {
    tick: room.room.state.tick,
    paused: room.room.world.paused,
    weatherKind: room.room.world.weather.kind,
    weatherWind: room.room.world.weather.wind,
    checksum: room.room.state.checksum,
    randomSeed: JSON.stringify(room.room.world.random),
  };

  room.room.handleTick();

  const after = {
    tick: room.room.state.tick,
    paused: room.room.world.paused,
    weatherKind: room.room.world.weather.kind,
    weatherWind: room.room.world.weather.wind,
    checksum: room.room.state.checksum,
    randomSeed: JSON.stringify(room.room.world.random),
  };

  assert.deepEqual(after, before);
});

test("idle cleanup applies the injected policy hook", async () => {
  const clock = new FakeClock();
  const manager = new RoomManager(
    { maxRooms: 8, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      clock,
      idleCleanupPolicy: (room) => clock.nowMs() - room.lastActivityAtMs > 100,
    },
  );

  const room = await manager.createRoom();
  clock.advance(200);
  const cleaned = await manager.cleanupIdleRooms(clock.nowMs());

  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0]?.roomId, room.roomId);
});

test("shutdown finalizes once a tick finishes", async () => {
  const room = createTestRoom();
  room.room.enqueueJoin({ sessionId: "shutdown", connectionId: "conn-1", connectionOrdinal: 1, generation: 1 });
  await room.room.flushPendingIngresses();

  const closePromise = room.room.beginShutdown("server_shutdown");
  room.room.handleTick();
  await closePromise;

  assert.equal(room.room.closing, true);
});

test("admission rejects new rooms once shutdown begins", async () => {
  const clock = new FakeClock();
  const manager = new RoomManager(
    { maxRooms: 4, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    { clock },
  );

  await manager.shutdown(0);
  await assert.rejects(manager.createRoom(), /admission/i);
});
