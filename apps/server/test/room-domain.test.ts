import assert from "node:assert/strict";
import test from "node:test";
import { createGameplayRandomState, type RoomId } from "@particle-sim/shared";
import { Room, type RoomConfig, type RoomDependencies } from "../src/room/room.js";
import { DeadlineScheduler, ManualDeadlineTimerDriver, type Clock } from "../src/room/scheduler.js";
import { RoomManager, type RoomTimerAdapter } from "../src/room/room-manager.js";
import type { RoomPublication } from "../src/room/types.js";

let nextTestRoomOrdinal = 1;

class FakeClock implements Clock {
  #nowMs: number;
  #driver?: ManualDeadlineTimerDriver;

  constructor(startMs = 0, driver?: ManualDeadlineTimerDriver) {
    this.#nowMs = startMs;
    this.#driver = driver;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
    this.#driver?.advanceBy(ms);
  }
}

class TestPublisher {
  publications: RoomPublication[] = [];

  publish(publication: RoomPublication): void {
    this.publications.push(publication);
  }
}

class FakeTimingAdapter implements RoomTimerAdapter {
  #nowMs: number;
  #nextId: number;
  #pending: Array<{ id: number; callback: () => void; dueAt: number }>;

  constructor(startMs = 0) {
    this.#nowMs = startMs;
    this.#nextId = 1;
    this.#pending = [];
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.push({ id, callback, dueAt: this.#nowMs + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle !== "number") {
      return;
    }
    this.#pending = this.#pending.filter((entry) => entry.id !== handle);
  }

  advanceBy(ms: number): void {
    this.#nowMs += ms;
    while (true) {
      const dueEntries = this.#pending.filter((entry) => entry.dueAt <= this.#nowMs).sort((left, right) => left.dueAt - right.dueAt);
      if (dueEntries.length === 0) {
        return;
      }
      this.#pending = this.#pending.filter((entry) => !dueEntries.some((candidate) => candidate.id === entry.id));
      for (const entry of dueEntries) {
        entry.callback();
      }
    }
  }
}

function createTestRoom(configOverrides: Partial<RoomConfig> = {}) {
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const roomId = `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId;
  const room = new Room(
    {
      roomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
      ...configOverrides,
    },
    { clock, scheduler, publisher } as RoomDependencies,
  );
  return { room, clock, scheduler, publisher, manualDriver };
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
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  let active = 0;
  let callbacks = 0;

  scheduler.start(() => {
    active += 1;
    callbacks += 1;
    assert.equal(active, 1);
    active -= 1;
  });

  clock.advance(250);

  assert.equal(callbacks, 2);
  assert.equal(scheduler.state.lastDelayKind, "catch-up");
});

test("interleaved commands keep per-membership sequence state", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "two", connectionId: "conn-2", connectionOrdinal: 2 }).accepted, true);
  await room.room.flushPendingIngresses();

  const [firstMembership, secondMembership] = room.room.memberships;
  const firstCommand = room.room.enqueueCommand({
    membershipId: firstMembership.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: firstMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  const secondCommand = room.room.enqueueCommand({
    membershipId: secondMembership.membershipId,
    sessionId: "two",
    connectionId: "conn-2",
    connectionOrdinal: 4,
    generation: secondMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  const thirdCommand = room.room.enqueueCommand({
    membershipId: firstMembership.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 5,
    generation: firstMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });

  assert.equal(firstCommand.accepted, true);
  assert.equal(secondCommand.accepted, true);
  assert.equal(thirdCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number; actorId: string }>;
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map((receipt) => receipt.actorSequence), [1, 1, 2]);
  assert.equal(receipts[0]?.actorId, room.room.memberships[0]?.playerId);
  assert.equal(receipts[1]?.actorId, room.room.memberships[1]?.playerId);
});

test("capacity, reconnect, and owner transfer remain deterministic", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "two", connectionId: "conn-2", connectionOrdinal: 2 }).accepted, true);
  await room.room.flushPendingIngresses();

  const firstMembership = room.room.memberships[0];
  const leave = room.room.enqueueLeave({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 3, generation: firstMembership.generation, membershipId: firstMembership.membershipId });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 1);
  assert.equal(room.room.memberships[0]?.sessionId, "two");
  assert.equal(room.room.world.players[firstMembership.playerId], undefined);

  const rejoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 4 });
  assert.equal(rejoin.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 2);
  assert.ok(room.room.world.players[firstMembership.playerId]);
  assert.equal(room.room.memberships[0]?.owner, true);
});

test("stale generations and old connections are fenced before drain", async () => {
  const room = createTestRoom();

  assert.equal(room.room.enqueueJoin({ sessionId: "stale", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  const staleCommand = room.room.enqueueCommand({
    membershipId: membership.membershipId,
    sessionId: "stale",
    connectionId: "conn-2",
    connectionOrdinal: 2,
    generation: membership.generation + 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(staleCommand.accepted, false);
  assert.equal(staleCommand.code, "stale_membership");
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

test("shutdown rejects queued ingress and blocks post-close joins", async () => {
  const room = createTestRoom();
  assert.equal(room.room.enqueueJoin({ sessionId: "shutdown", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const closePromise = room.room.beginShutdown("server_shutdown");
  const queuedJoin = room.room.enqueueJoin({ sessionId: "later", connectionId: "conn-2", connectionOrdinal: 2 });
  assert.equal(queuedJoin.accepted, false);
  await closePromise;

  const postCloseCommand = room.room.enqueueCommand({
    membershipId: room.room.memberships[0]?.membershipId ?? "",
    sessionId: "shutdown",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: room.room.memberships[0]?.generation ?? 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(postCloseCommand.accepted, false);
});

test("room manager shutdown times out on a never-resolving hook", async () => {
  const clock = new FakeClock();
  const timing = new FakeTimingAdapter();
  const manager = new RoomManager(
    { maxRooms: 4, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      clock,
      timing,
      hooks: {
        onClosed: () => new Promise<void>(() => undefined),
      },
    },
  );

  await manager.createRoom();
  const shutdownPromise = manager.shutdown(5);
  timing.advanceBy(5);
  await assert.rejects(shutdownPromise, /timed out/i);
  assert.equal(manager.roomCount, 0);
});
