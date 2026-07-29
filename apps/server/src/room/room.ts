import {
  advanceWorldTick,
  computeWorldChecksum,
  createCommandId,
  createDefaultPlayerState,
  createDefaultWorldState,
  createPlayerId,
  createWorldSnapshot,
  enqueueCommand,
  processPendingCommands,
  type CommandReceipt,
  type CommandEnvelope,
  type GameplayCommand,
  type PlayerId,
  type RoomId,
} from "@particle-sim/shared";
import type { WorldState } from "@particle-sim/shared";
import { createDefaultRoomId } from "../config.js";
import type { Clock } from "./scheduler.js";
import type { DeadlineSchedulerState, RoomScheduler } from "./scheduler.js";
import type { CommandRequest, JoinRequest, LeaveRequest, RoomIngress, RoomPublication, RoomPublisher, RoomTransportHooks, RoomLifecycleReason, RoomMemberState } from "./types.js";

export interface RoomStateSummary {
  readonly roomId: RoomId;
  readonly tick: number;
  readonly worldRevision: number;
  readonly checksum: string;
  readonly capacity: number;
  readonly memberships: RoomMemberState[];
  readonly ownerPlayerId: PlayerId | null;
  readonly schedulerSuspended: boolean;
  readonly closing: boolean;
}

interface MembershipRecord {
  membershipId: string;
  playerId: PlayerId;
  sessionId: string;
  connectionId: string;
  generation: number;
  joinOrdinal: number;
  receiveOrdinal: number;
  connected: boolean;
  owner: boolean;
  joinedAtTick: number;
  leftAtTick: number | null;
}

export interface RoomConfig {
  readonly roomId: RoomId;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly tickHz: number;
  readonly maxCatchUpTicks: number;
  readonly idleCleanupThresholdMs: number;
}

export interface RoomDependencies {
  readonly clock: Clock;
  readonly scheduler: RoomScheduler;
  readonly publisher: RoomPublisher;
  readonly hooks?: RoomTransportHooks;
}

export class Room {
  #roomId: RoomId;
  #config: RoomConfig;
  #clock: Clock;
  #scheduler: RoomScheduler;
  #publisher: RoomPublisher;
  #hooks?: RoomTransportHooks;
  #world: WorldState;
  #membershipsById: Map<string, MembershipRecord>;
  #membershipsBySession: Map<string, MembershipRecord>;
  #ingressQueue: RoomIngress[];
  #nextJoinOrdinal: number;
  #nextReceiveOrdinal: number;
  #tickInProgress: boolean;
  #closing: boolean;
  #shutdownRequested: boolean;
  #schedulerSuspended: boolean;
  #closePromise: Promise<void>;
  #resolveClosePromise: (() => void) | null = null;
  #lastPublication: RoomPublication | null;
  #lastActivityAtMs: number;
  #activeCommandReceipts: CommandReceipt[];
  #nextCommandOrdinal: number;

  constructor(config: RoomConfig, dependencies: RoomDependencies) {
    this.#roomId = config.roomId;
    this.#config = config;
    this.#clock = dependencies.clock;
    this.#scheduler = dependencies.scheduler;
    this.#publisher = dependencies.publisher;
    this.#hooks = dependencies.hooks;
    this.#world = createDefaultWorldState(config.roomId);
    this.#membershipsById = new Map();
    this.#membershipsBySession = new Map();
    this.#ingressQueue = [];
    this.#nextJoinOrdinal = 1;
    this.#nextReceiveOrdinal = 1;
    this.#tickInProgress = false;
    this.#closing = false;
    this.#shutdownRequested = false;
    this.#schedulerSuspended = true;
    this.#lastPublication = null;
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.#activeCommandReceipts = [];
    this.#nextCommandOrdinal = 1;
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClosePromise = resolve;
    });

    this.#scheduler.stop();
  }

  get roomId(): RoomId {
    return this.#roomId;
  }

  get world(): WorldState {
    return this.#world;
  }

  get state(): RoomStateSummary {
    return {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: this.checksum,
      capacity: this.#config.maxCapacity,
      memberships: this.memberships,
      ownerPlayerId: this.#world.ownerPlayerId,
      schedulerSuspended: this.#schedulerSuspended,
      closing: this.#closing,
    };
  }

  get schedulerState(): DeadlineSchedulerState {
    return this.#scheduler.state;
  }

  get memberships(): RoomMemberState[] {
    return Array.from(this.#membershipsById.values())
      .filter((membership) => membership.connected)
      .sort((left, right) => left.joinOrdinal - right.joinOrdinal)
      .map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      }));
  }

  get checksum(): string {
    return computeWorldChecksum(this.#world);
  }

  get ingressQueueSize(): number {
    return this.#ingressQueue.length;
  }

  get closing(): boolean {
    return this.#closing;
  }

  get tickInProgress(): boolean {
    return this.#tickInProgress;
  }

  get closePromise(): Promise<void> {
    return this.#closePromise;
  }

  get lastPublication(): RoomPublication | null {
    return this.#lastPublication;
  }

  get lastActivityAtMs(): number {
    return this.#lastActivityAtMs;
  }

  get activeCommandReceipts(): readonly CommandReceipt[] {
    return this.#activeCommandReceipts;
  }

  async beginShutdown(reason: RoomLifecycleReason): Promise<void> {
    if (this.#closing) {
      return this.#closePromise;
    }
    this.#closing = true;
    this.#shutdownRequested = true;
    this.#scheduler.stop();
    await this.flushPendingIngresses();
    if (this.#tickInProgress) {
      return this.#closePromise;
    }
    this.publishClosing(reason);
    this.resolveClose();
    return this.#closePromise;
  }

  enqueueJoin(request: JoinRequest): { accepted: boolean; membership?: RoomMemberState; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    if (this.#closing) {
      return { accepted: false, code: "room_closed", message: "room is closed" };
    }
    if (this.#projectedMembershipCount() >= this.#config.maxCapacity) {
      return { accepted: false, code: "room_full", message: "room is full" };
    }
    const existing = this.#membershipsBySession.get(request.sessionId);
    const pendingLeave = this.#hasPendingLeave(request.sessionId);
    if (existing && existing.connected && !pendingLeave) {
      return { accepted: false, code: "already_joined", message: "session already joined" };
    }
    const joinOrdinal = this.#nextJoinOrdinal;
    this.#nextJoinOrdinal += 1;
    const ingress: RoomIngress = {
      kind: "join",
      membershipId: `membership_${joinOrdinal}`,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation: request.generation ?? 1,
      joinOrdinal,
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true, membership: this.#membershipSummaryForIngress(ingress) };
  }

  enqueueLeave(request: LeaveRequest): { accepted: boolean; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    const membership = this.#membershipsBySession.get(request.sessionId);
    if (!membership || !membership.connected) {
      return { accepted: false, code: "not_joined", message: "session is not joined" };
    }
    const ingress: RoomIngress = {
      kind: "leave",
      membershipId: membership.membershipId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation: request.generation ?? membership.generation,
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true };
  }

  enqueueCommand(request: CommandRequest): { accepted: boolean; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    const membership = this.#membershipsBySession.get(request.sessionId);
    if (!membership || !membership.connected) {
      return { accepted: false, code: "not_joined", message: "session is not joined" };
    }
    const ingress: RoomIngress = {
      kind: "command",
      membershipId: membership.membershipId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation: request.generation ?? membership.generation,
      command: this.#buildCommandEnvelope(membership.playerId, request.command),
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true };
  }

  handleTick(): void {
    if (this.#tickInProgress) {
      return;
    }
    this.#tickInProgress = true;
    try {
      this.processQueuedLifecycle();
      if (!this.#closing) {
        this.#applyAuthoritativeTick();
        this.publishSnapshot("tick");
      }
      if (this.#shutdownRequested && this.#closing) {
        this.publishClosing("server_shutdown");
        this.resolveClose();
      }
    } finally {
      this.#tickInProgress = false;
    }
  }

  async flushPendingIngresses(): Promise<void> {
    if (this.#tickInProgress) {
      return;
    }
    this.processQueuedLifecycle();
  }

  private processQueuedLifecycle(): void {
    while (this.#ingressQueue.length > 0) {
      const ingress = this.#ingressQueue.shift();
      if (!ingress) {
        break;
      }
      this.processIngress(ingress);
    }
  }

  private processIngress(ingress: RoomIngress): void {
    if (ingress.kind === "join") {
      this.applyJoin(ingress);
      return;
    }
    if (ingress.kind === "leave") {
      this.applyLeave(ingress);
      return;
    }
    this.applyCommand(ingress);
  }

  private applyJoin(ingress: RoomIngress): void {
    const existing = this.#membershipsBySession.get(ingress.sessionId);
    if (existing && existing.connected) {
      return;
    }
    if (this.#membershipsById.size >= this.#config.maxCapacity) {
      return;
    }
    const membership = this.#createMembershipRecord(ingress);
    this.#membershipsById.set(membership.membershipId, membership);
    this.#membershipsBySession.set(membership.sessionId, membership);
    this.#world.players[membership.playerId] = createDefaultPlayerState(membership.playerId);
    this.#world.nextPlayerOrdinal = this.#world.nextPlayerOrdinal + 1;
    this.#world.ownerPlayerId = this.#world.ownerPlayerId ?? membership.playerId;
    this.#reconcileOwner();
    this.#schedulerSuspended = false;
    this.#scheduler.start(() => {
      this.handleTick();
    });
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.publishMembership();
  }

  private applyLeave(ingress: RoomIngress): void {
    const membership = this.#membershipsBySession.get(ingress.sessionId);
    if (!membership || !membership.connected) {
      return;
    }
    if (membership.generation !== ingress.generation) {
      return;
    }
    membership.connected = false;
    membership.leftAtTick = this.#world.tick;
    this.#membershipsBySession.delete(ingress.sessionId);
    this.#reconcileOwner();
    this.#schedulerSuspended = this.memberships.length === 0;
    if (this.#schedulerSuspended) {
      this.#scheduler.stop();
    }
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.publishMembership();
  }

  private applyCommand(ingress: RoomIngress): void {
    if (this.#closing) {
      return;
    }
    const membership = this.#membershipsBySession.get(ingress.sessionId);
    if (!membership || !membership.connected) {
      return;
    }
    if (membership.generation !== ingress.generation) {
      return;
    }
    const envelope = ingress.command;
    if (!envelope) {
      return;
    }
    enqueueCommand(this.#world, envelope);
    const results = processPendingCommands(this.#world);
    if (results.length > 0) {
      const receipt = this.#world.commandLedger.recent[this.#world.commandLedger.recent.length - 1] as CommandReceipt | undefined;
      if (receipt) {
        this.#activeCommandReceipts = [receipt];
        this.#hooks?.onCommandAck?.(this.#roomId, this.#membershipSummary(membership), receipt);
      }
    }
  }

  #buildCommandEnvelope(actorId: PlayerId, command: GameplayCommand): CommandEnvelope {
    const actorSequence = this.#nextCommandOrdinal;
    this.#nextCommandOrdinal += 1;
    return {
      commandId: createCommandId(`command_${actorSequence}`),
      actorId,
      actorSequence,
      issuedTick: this.#world.tick,
      command,
    };
  }

  #createMembershipRecord(ingress: RoomIngress): MembershipRecord {
    const joinOrdinal = ingress.joinOrdinal ?? this.#nextJoinOrdinal;
    const playerId = createPlayerId(`player_${joinOrdinal}`);
    const membership: MembershipRecord = {
      membershipId: ingress.membershipId,
      playerId,
      sessionId: ingress.sessionId,
      connectionId: ingress.connectionId,
      generation: ingress.generation,
      joinOrdinal,
      receiveOrdinal: ingress.receiveOrdinal,
      connected: true,
      owner: false,
      joinedAtTick: this.#world.tick,
      leftAtTick: null,
    };
    return membership;
  }

  #reconcileOwner(): void {
    const activeMemberships = Array.from(this.#membershipsById.values())
      .filter((membership) => membership.connected)
      .sort((left, right) => left.joinOrdinal - right.joinOrdinal);
    if (activeMemberships.length === 0) {
      this.#world.ownerPlayerId = null;
      return;
    }
    const owner = activeMemberships[0];
    owner.owner = true;
    for (const membership of activeMemberships.slice(1)) {
      membership.owner = false;
    }
    this.#world.ownerPlayerId = owner.playerId;
  }

  #projectedMembershipCount(): number {
    const pendingLeaveSessions = new Set(this.#ingressQueue.filter((ingress) => ingress.kind === "leave").map((ingress) => ingress.sessionId));
    const connectedCount = Array.from(this.#membershipsById.values()).filter((membership) => membership.connected && !pendingLeaveSessions.has(membership.sessionId)).length;
    const pendingJoinCount = this.#ingressQueue.filter((ingress) => ingress.kind === "join").length;
    return connectedCount + pendingJoinCount;
  }

  #hasPendingLeave(sessionId: string): boolean {
    return this.#ingressQueue.some((ingress) => ingress.kind === "leave" && ingress.sessionId === sessionId);
  }

  #applyAuthoritativeTick(): void {
    if (this.#schedulerSuspended || this.#world.paused) {
      return;
    }
    advanceWorldTick(this.#world);
  }

  private publishMembership(): void {
    this.publishSnapshot("membership");
  }

  private publishSnapshot(reason: RoomPublication["reason"]): void {
    const snapshot = createWorldSnapshot(this.#world);
    const publication: RoomPublication = {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: computeWorldChecksum(this.#world),
      memberships: this.memberships.map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      })),
      reason,
      snapshot,
    };
    this.#lastPublication = publication;
    this.#publisher.publish(publication);
  }

  private publishClosing(reason: RoomLifecycleReason): void {
    const snapshot = createWorldSnapshot(this.#world);
    const publication: RoomPublication = {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: computeWorldChecksum(this.#world),
      memberships: this.memberships.map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      })),
      reason: "closing",
      snapshot,
    };
    this.#lastPublication = publication;
    this.#publisher.publish(publication);
    this.#hooks?.onClosed?.(this.#roomId, reason);
  }

  #membershipSummary(membership: MembershipRecord): RoomMemberState {
    return {
      membershipId: membership.membershipId,
      playerId: membership.playerId,
      sessionId: membership.sessionId,
      connectionId: membership.connectionId,
      generation: membership.generation,
      joinOrdinal: membership.joinOrdinal,
      receiveOrdinal: membership.receiveOrdinal,
      connected: membership.connected,
      owner: membership.owner,
    };
  }

  #membershipSummaryForIngress(ingress: RoomIngress): RoomMemberState {
    const joinOrdinal = ingress.joinOrdinal ?? this.#nextJoinOrdinal;
    return {
      membershipId: ingress.membershipId,
      playerId: createPlayerId(`player_${joinOrdinal}`),
      sessionId: ingress.sessionId,
      connectionId: ingress.connectionId,
      generation: ingress.generation,
      joinOrdinal,
      receiveOrdinal: ingress.receiveOrdinal,
      connected: false,
      owner: false,
    };
  }

  private resolveClose(): void {
    if (this.#resolveClosePromise) {
      this.#resolveClosePromise();
      this.#resolveClosePromise = null;
    }
  }
}

export function createRoomIdValue(index: number): RoomId {
  return createDefaultRoomId(index) as RoomId;
}
