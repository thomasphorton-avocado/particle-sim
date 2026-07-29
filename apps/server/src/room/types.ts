import type { CommandEnvelope, CommandReceipt, GameplayCommand, WorldSnapshot } from "@particle-sim/shared";
import type { PlayerId, RoomId } from "@particle-sim/shared";

export type RoomLifecycleReason = "server_shutdown" | "idle_cleanup" | "manual_close";

export interface MembershipSummary {
  readonly membershipId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly joinOrdinal: number;
  readonly receiveOrdinal: number;
  readonly connected: boolean;
  readonly owner: boolean;
}

export interface RoomPublication {
  readonly roomId: RoomId;
  readonly tick: number;
  readonly worldRevision: number;
  readonly checksum: string;
  readonly memberships: MembershipSummary[];
  readonly reason: "tick" | "membership" | "closing";
  readonly snapshot: WorldSnapshot;
}

export interface RoomPublisher {
  publish(publication: RoomPublication): void;
}

export interface RoomTransportHooks {
  onJoined?(roomId: RoomId, membership: MembershipSummary): void;
  onLeft?(roomId: RoomId, membership: MembershipSummary): void;
  onClosed?(roomId: RoomId, reason: RoomLifecycleReason): void;
  onCommandAck?(roomId: RoomId, membership: MembershipSummary, receipt: CommandReceipt): void;
}

export interface RoomIngress {
  readonly kind: "join" | "leave" | "command";
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly receiveOrdinal: number;
  readonly generation: number;
  readonly joinOrdinal?: number;
  readonly command?: CommandEnvelope;
}

export interface JoinRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
}

export interface LeaveRequest {
  readonly membershipId?: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
}

export interface CommandRequest {
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
  readonly command: GameplayCommand;
}

export interface RoomMemberState {
  readonly membershipId: string;
  readonly playerId: PlayerId;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly joinOrdinal: number;
  readonly receiveOrdinal: number;
  readonly connected: boolean;
  readonly owner: boolean;
}
