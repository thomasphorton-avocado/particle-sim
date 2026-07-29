import { parseGameplayCommand } from "../commands.js";
import { parsePlayerId, parseRoomId } from "../ids.js";
import { decodeWorldDelta, decodeWorldSnapshot, WORLD_SNAPSHOT_SCHEMA_VERSION } from "../replication.js";
import { WORLD_STATE_SCHEMA_VERSION } from "../serialization.js";
import { MAX_BATCH_COMMANDS, MAX_CELL_DELTAS, MAX_DECODER_WORK, MAX_ENTITY_DELTAS, MAX_ID_LENGTH, MAX_INTEGER, MAX_METADATA_ENTRIES, MAX_STRING_LENGTH, MIN_INTEGER, PROTOCOL_VERSION } from "./limits.js";
import { ProtocolCodecError, decodeProtocolMessageFrame as decodeProtocolJsonFrame, encodeProtocolMessage as encodeProtocolJsonMessage } from "./json.js";
import type {
  ProtocolClientCommand,
  ProtocolCommandAcknowledgement,
  ProtocolCommandAcknowledgementMessage,
  ProtocolCommandBatchMessage,
  ProtocolDeltaMessage,
  ProtocolErrorCode,
  ProtocolErrorMessage,
  ProtocolHelloMessage,
  ProtocolJoinAcceptedMessage,
  ProtocolJoinMessage,
  ProtocolJoinRejectedMessage,
  ProtocolMessage,
  ProtocolPingMessage,
  ProtocolPongMessage,
  ProtocolResyncReason,
  ProtocolResyncRequiredMessage,
  ProtocolResyncRequestMessage,
  ProtocolRoomClosureCode,
  ProtocolRoomClosureMessage,
  ProtocolSnapshotMessage,
  ProtocolJoinRejectCode,
  ProtocolVersionedMessage,
} from "./types.js";

interface DecoderWork {
  used: number;
}

function consumeWork(work: DecoderWork, amount = 1): void {
  work.used += amount;
  if (work.used > MAX_DECODER_WORK) {
    throw new ProtocolCodecError("decoder_work_limit_exceeded", `Decoder work limit exceeded (${MAX_DECODER_WORK})`);
  }
}

function assertPlainObject(value: unknown, label: string, work: DecoderWork): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an object`);
  }
  consumeWork(work, 1 + Object.keys(value).length);
  return value as Record<string, unknown>;
}

function assertAllowedFields(value: Record<string, unknown>, label: string, allowedFields: ReadonlySet<string>, work: DecoderWork): void {
  consumeWork(work, 1);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new ProtocolCodecError("unknown_field", `${label} contains an unknown field (${key})`);
    }
  }
}

function assertString(value: unknown, label: string, work: DecoderWork, allowEmpty = true): string {
  if (typeof value !== "string") {
    throw new ProtocolCodecError("malformed_message", `${label} must be a string`);
  }
  consumeWork(work, 1);
  if (!allowEmpty && value.length === 0) {
    throw new ProtocolCodecError("malformed_message", `${label} must not be empty`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new ProtocolCodecError("malformed_message", `${label} exceeds the ${MAX_STRING_LENGTH} character limit`);
  }
  return value;
}

function assertInteger(value: unknown, label: string, work: DecoderWork, min = MIN_INTEGER, max = MAX_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ProtocolCodecError("invalid_integer", `${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ProtocolCodecError("invalid_integer", `${label} is outside the supported range`);
  }
  consumeWork(work, 1);
  return value;
}

function assertNonNegativeInteger(value: unknown, label: string, work: DecoderWork): number {
  return assertInteger(value, label, work, MIN_INTEGER, MAX_INTEGER);
}

function assertProtocolVersion(value: unknown, work: DecoderWork): number {
  const protocolVersion = assertNonNegativeInteger(value, "protocolVersion", work);
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolCodecError("unsupported_protocol_version", `Unsupported protocol version ${protocolVersion}`);
  }
  return protocolVersion;
}

function assertSchemaVersion(value: unknown, label: string, work: DecoderWork, expected: number): number {
  const schemaVersion = assertNonNegativeInteger(value, label, work);
  if (schemaVersion !== expected) {
    throw new ProtocolCodecError("unsupported_schema_version", `${label} ${schemaVersion} is unsupported`);
  }
  return schemaVersion;
}

function assertRoomId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parseRoomId> {
  const roomIdText = assertString(value, label, work, false);
  if (roomIdText.length > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parseRoomId(roomIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid room id`);
  }
}

function assertPlayerId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parsePlayerId> {
  const playerIdText = assertString(value, label, work, false);
  if (playerIdText.length > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parsePlayerId(playerIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid player id`);
  }
}

function assertOptionalString(value: unknown, label: string, work: DecoderWork): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertString(value, label, work, true);
}

function assertOptionalInteger(value: unknown, label: string, work: DecoderWork): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonNegativeInteger(value, label, work);
}

function assertVersionedMessageFields(value: Record<string, unknown>, work: DecoderWork): ProtocolVersionedMessage {
  const protocolVersion = assertProtocolVersion(value["protocolVersion"], work);
  const worldSnapshotSchemaVersion = assertSchemaVersion(value["worldSnapshotSchemaVersion"], "worldSnapshotSchemaVersion", work, WORLD_SNAPSHOT_SCHEMA_VERSION);
  const worldStateSchemaVersion = assertSchemaVersion(value["worldStateSchemaVersion"], "worldStateSchemaVersion", work, WORLD_STATE_SCHEMA_VERSION);
  return { protocolVersion, worldSnapshotSchemaVersion, worldStateSchemaVersion } as ProtocolVersionedMessage;
}

function wrapReplicaValidation<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProtocolCodecError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    if (lowered.includes("revision")) {
      throw new ProtocolCodecError("invalid_revision", `${label}: ${message}`);
    }
    if (lowered.includes("dimension") || lowered.includes("griddimensions")) {
      throw new ProtocolCodecError("invalid_dimensions", `${label}: ${message}`);
    }
    throw new ProtocolCodecError("malformed_message", `${label}: ${message}`);
  }
}

function assertArray(value: unknown, label: string, work: DecoderWork, maxLength: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an array`);
  }
  if (value.length > maxLength) {
    throw new ProtocolCodecError("batch_too_large", `${label} exceeds the ${maxLength} entry limit`);
  }
  consumeWork(work, 1 + value.length);
  return value;
}

function assertCommand(value: unknown, work: DecoderWork): ProtocolClientCommand {
  const commandObject = assertPlainObject(value, "command", work);
  const allowedFields = new Set(["clientSequence", "issuedTick", "command"]);
  assertAllowedFields(commandObject, "command", allowedFields, work);
  const clientSequence = assertNonNegativeInteger(commandObject["clientSequence"], "clientSequence", work);
  const issuedTick = assertNonNegativeInteger(commandObject["issuedTick"], "issuedTick", work);
  const command = parseGameplayCommand(commandObject["command"]);
  if (command === null) {
    throw new ProtocolCodecError("malformed_message", "command must be a valid gameplay command");
  }
  return { clientSequence, issuedTick, command };
}

function assertCommandBatch(value: Record<string, unknown>, work: DecoderWork): ProtocolCommandBatchMessage {
  const allowedFields = new Set(["kind", "streamSequence", "commands"]);
  assertAllowedFields(value, "command batch", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const commands = assertArray(value["commands"], "commands", work, MAX_BATCH_COMMANDS).map((entry) => assertCommand(entry, work));
  return { kind: "command_batch", streamSequence, commands };
}

function assertCommandAcknowledgement(value: unknown, work: DecoderWork): ProtocolCommandAcknowledgement {
  const ackObject = assertPlainObject(value, "command acknowledgement", work);
  const allowedFields = new Set(["clientSequence", "issuedTick", "accepted", "code", "authorityOrder", "processedTick", "beforeWorldRevision", "afterWorldRevision", "beforeInventoryRevision", "afterInventoryRevision", "beforeTargetRevision", "afterTargetRevision", "acceptedEffect"]);
  assertAllowedFields(ackObject, "command acknowledgement", allowedFields, work);
  const clientSequence = assertNonNegativeInteger(ackObject["clientSequence"], "clientSequence", work);
  const issuedTick = assertNonNegativeInteger(ackObject["issuedTick"], "issuedTick", work);
  const accepted = typeof ackObject["accepted"] === "boolean" ? ackObject["accepted"] : (() => { throw new ProtocolCodecError("malformed_message", "accepted must be a boolean"); })();
  const code = assertString(ackObject["code"], "code", work, false);
  const authorityOrder = ackObject["authorityOrder"] === null || ackObject["authorityOrder"] === undefined ? null : (assertOptionalInteger(ackObject["authorityOrder"], "authorityOrder", work) ?? null);
  const processedTick = assertNonNegativeInteger(ackObject["processedTick"], "processedTick", work);
  const beforeWorldRevision = assertNonNegativeInteger(ackObject["beforeWorldRevision"], "beforeWorldRevision", work);
  const afterWorldRevision = assertNonNegativeInteger(ackObject["afterWorldRevision"], "afterWorldRevision", work);
  const beforeInventoryRevision = assertNonNegativeInteger(ackObject["beforeInventoryRevision"], "beforeInventoryRevision", work);
  const afterInventoryRevision = assertNonNegativeInteger(ackObject["afterInventoryRevision"], "afterInventoryRevision", work);
  const beforeTargetRevision = assertNonNegativeInteger(ackObject["beforeTargetRevision"], "beforeTargetRevision", work);
  const afterTargetRevision = assertNonNegativeInteger(ackObject["afterTargetRevision"], "afterTargetRevision", work);
  const acceptedEffect = ackObject["acceptedEffect"] === null || ackObject["acceptedEffect"] === undefined ? null : (assertOptionalString(ackObject["acceptedEffect"], "acceptedEffect", work) ?? null);
  return {
    clientSequence,
    issuedTick,
    accepted,
    code: code as ProtocolCommandAcknowledgement["code"],
    authorityOrder,
    processedTick,
    beforeWorldRevision,
    afterWorldRevision,
    beforeInventoryRevision,
    afterInventoryRevision,
    beforeTargetRevision,
    afterTargetRevision,
    acceptedEffect,
  };
}

function assertCommandAcknowledgementMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolCommandAcknowledgementMessage {
  const allowedFields = new Set(["kind", "streamSequence", "acknowledgements"]);
  assertAllowedFields(value, "command acknowledgement message", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const acknowledgements = assertArray(value["acknowledgements"], "acknowledgements", work, MAX_BATCH_COMMANDS).map((entry) => assertCommandAcknowledgement(entry, work));
  return { kind: "command_acknowledgement", streamSequence, acknowledgements };
}

function assertSnapshotMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolSnapshotMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "snapshot"]);
  assertAllowedFields(value, "snapshot message", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const snapshot = wrapReplicaValidation("snapshot", () => decodeWorldSnapshot(value["snapshot"]));
  if (snapshot.worldRevision < 0) {
    throw new ProtocolCodecError("invalid_revision", "snapshot.worldRevision must be non-negative");
  }
  return {
    kind: "snapshot",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    snapshot,
  };
}

function assertDeltaMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolDeltaMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "delta"]);
  assertAllowedFields(value, "delta message", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const deltaObject = assertPlainObject(value["delta"], "delta", work);
  const cellEntries = deltaObject["cells"];
  const playerEntries = deltaObject["players"];
  const fallingObjectEntries = deltaObject["fallingObjects"];
  const metadataEntries = deltaObject["metadata"];
  if (Array.isArray(cellEntries) && cellEntries.length > MAX_CELL_DELTAS) {
    throw new ProtocolCodecError("cell_too_large", `delta.cells exceeds the ${MAX_CELL_DELTAS} entry limit`);
  }
  if (Array.isArray(playerEntries) && playerEntries.length > MAX_ENTITY_DELTAS) {
    throw new ProtocolCodecError("entity_too_large", `delta.players exceeds the ${MAX_ENTITY_DELTAS} entry limit`);
  }
  if (Array.isArray(fallingObjectEntries) && fallingObjectEntries.length > MAX_ENTITY_DELTAS) {
    throw new ProtocolCodecError("entity_too_large", `delta.fallingObjects exceeds the ${MAX_ENTITY_DELTAS} entry limit`);
  }
  if (Array.isArray(metadataEntries) && metadataEntries.length > MAX_METADATA_ENTRIES) {
    throw new ProtocolCodecError("entity_too_large", `delta.metadata exceeds the ${MAX_METADATA_ENTRIES} entry limit`);
  }
  const delta = wrapReplicaValidation("delta", () => decodeWorldDelta(value["delta"]));
  if (delta.targetRevision < delta.baseRevision) {
    throw new ProtocolCodecError("invalid_revision", "delta.targetRevision must be >= delta.baseRevision");
  }
  return {
    kind: "delta",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    delta,
  };
}

function assertResyncRequest(value: Record<string, unknown>, work: DecoderWork): ProtocolResyncRequestMessage {
  const allowedFields = new Set(["kind", "streamSequence", "reason", "lastKnownStreamSequence", "lastKnownWorldRevision"]);
  assertAllowedFields(value, "resync request", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const reason = value["reason"] === undefined ? undefined : assertString(value["reason"], "reason", work, true) as ProtocolResyncReason;
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_request", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertResyncRequired(value: Record<string, unknown>, work: DecoderWork): ProtocolResyncRequiredMessage {
  const allowedFields = new Set(["kind", "streamSequence", "reason", "lastKnownStreamSequence", "lastKnownWorldRevision"]);
  assertAllowedFields(value, "resync required", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const reason = assertString(value["reason"], "reason", work, false) as ProtocolResyncReason;
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_required", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertProtocolError(value: Record<string, unknown>, work: DecoderWork): ProtocolErrorMessage {
  const allowedFields = new Set(["kind", "streamSequence", "code", "message"]);
  assertAllowedFields(value, "protocol error", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const code = assertString(value["code"], "code", work, false) as ProtocolErrorCode;
  const message = assertOptionalString(value["message"], "message", work);
  return { kind: "protocol_error", streamSequence, code, message };
}

function assertPing(value: Record<string, unknown>, work: DecoderWork): ProtocolPingMessage {
  const allowedFields = new Set(["kind", "streamSequence", "nonce"]);
  assertAllowedFields(value, "ping", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const nonce = assertOptionalString(value["nonce"], "nonce", work);
  return { kind: "ping", streamSequence, nonce };
}

function assertPong(value: Record<string, unknown>, work: DecoderWork): ProtocolPongMessage {
  const allowedFields = new Set(["kind", "streamSequence", "nonce"]);
  assertAllowedFields(value, "pong", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const nonce = assertOptionalString(value["nonce"], "nonce", work);
  return { kind: "pong", streamSequence, nonce };
}

function assertRoomClosure(value: Record<string, unknown>, work: DecoderWork): ProtocolRoomClosureMessage {
  const allowedFields = new Set(["kind", "streamSequence", "code", "reason"]);
  assertAllowedFields(value, "room closure", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const code = assertString(value["code"], "code", work, false) as ProtocolRoomClosureCode;
  const reason = assertOptionalString(value["reason"], "reason", work);
  return { kind: "room_closed", streamSequence, code, reason };
}

function assertHello(value: Record<string, unknown>, work: DecoderWork): ProtocolHelloMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "clientId", "clientName"]);
  assertAllowedFields(value, "hello", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const clientId = assertOptionalString(value["clientId"], "clientId", work);
  const clientName = assertOptionalString(value["clientName"], "clientName", work);
  return {
    kind: "hello",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    clientId,
    clientName,
  };
}

function assertJoin(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "roomId", "playerId"]);
  assertAllowedFields(value, "join", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const playerId = value["playerId"] === undefined ? undefined : assertPlayerId(value["playerId"], "playerId", work);
  return {
    kind: "join",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    roomId,
    playerId,
  };
}

function assertJoinAccepted(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinAcceptedMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "roomId", "playerId"]);
  assertAllowedFields(value, "join accepted", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const playerId = assertPlayerId(value["playerId"], "playerId", work);
  return {
    kind: "join_accepted",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    roomId,
    playerId,
  };
}

function assertJoinRejected(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinRejectedMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "roomId", "code", "message"]);
  assertAllowedFields(value, "join rejected", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const code = assertString(value["code"], "code", work, false) as ProtocolJoinRejectCode;
  const message = assertOptionalString(value["message"], "message", work);
  return {
    kind: "join_rejected",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    roomId,
    code,
    message,
  };
}

function assertProtocolMessageObject(value: unknown): ProtocolMessage {
  const work: DecoderWork = { used: 0 };
  const object = assertPlainObject(value, "protocol message", work);
  const kindValue = assertString(object["kind"], "kind", work, false);
  switch (kindValue) {
    case "hello":
      return assertHello(object, work);
    case "join":
      return assertJoin(object, work);
    case "join_accepted":
      return assertJoinAccepted(object, work);
    case "join_rejected":
      return assertJoinRejected(object, work);
    case "command_batch":
      return assertCommandBatch(object, work);
    case "command_acknowledgement":
      return assertCommandAcknowledgementMessage(object, work);
    case "snapshot":
      return assertSnapshotMessage(object, work);
    case "delta":
      return assertDeltaMessage(object, work);
    case "resync_request":
      return assertResyncRequest(object, work);
    case "resync_required":
      return assertResyncRequired(object, work);
    case "protocol_error":
      return assertProtocolError(object, work);
    case "ping":
      return assertPing(object, work);
    case "pong":
      return assertPong(object, work);
    case "room_closed":
      return assertRoomClosure(object, work);
    default:
      throw new ProtocolCodecError("unsupported_message_kind", `Unsupported message kind ${kindValue}`);
  }
}

export function encodeProtocolMessage(message: unknown): Uint8Array {
  return encodeProtocolJsonMessage(message);
}

export function decodeProtocolMessage(input: unknown): ProtocolMessage {
  const decoded = typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)
    ? decodeProtocolJsonFrame(input)
    : input;
  return assertProtocolMessageObject(decoded);
}

export function decodeProtocolMessageObject(value: unknown): ProtocolMessage {
  return assertProtocolMessageObject(value);
}
