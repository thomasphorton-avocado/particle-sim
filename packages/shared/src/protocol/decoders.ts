import { parseGameplayCommand } from "../commands.js";
import { MAX_STACK } from "../inventory.js";
import { parseCommandId, parseObjectId, parsePlayerId, parseRoomId } from "../ids.js";
import { MATERIALS, MaterialId } from "../materials.js";
import { decodeWorldDelta, decodeWorldSnapshot, WORLD_SNAPSHOT_SCHEMA_VERSION } from "../replication.js";
import { WORLD_STATE_SCHEMA_VERSION, assertCommandResultInvariants } from "../serialization.js";
import { MAX_BATCH_COMMANDS, MAX_CELL_DELTAS, MAX_DECODER_WORK, MAX_ENTITY_DELTAS, MAX_ID_LENGTH, MAX_INTEGER, MAX_METADATA_ENTRIES, MAX_NESTED_COLLECTION_ITEMS, MAX_OBJECT_FIELDS, MAX_STRING_LENGTH, MIN_INTEGER, MAX_NESTING_DEPTH, PROTOCOL_VERSION } from "./limits.js";
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
 
const utf8Encoder = new TextEncoder();
 
interface DecoderWork {
  used: number;
  depth: number;
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function consumeWork(work: DecoderWork, amount = 1): void {
  work.used += amount;
  if (work.used > MAX_DECODER_WORK) {
    throw new ProtocolCodecError("decoder_work_limit_exceeded", `Decoder work limit exceeded (${MAX_DECODER_WORK})`);
  }
}

function enterDepth(work: DecoderWork): void {
  work.depth += 1;
  if (work.depth > MAX_NESTING_DEPTH) {
    work.depth -= 1;
    throw new ProtocolCodecError("decoder_work_limit_exceeded", `Nested values exceed the ${MAX_NESTING_DEPTH} level limit`);
  }
}

function leaveDepth(work: DecoderWork): void {
  work.depth -= 1;
}

function assertPlainObject(value: unknown, label: string, work: DecoderWork): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an object`);
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (utf8ByteLength(key) > MAX_STRING_LENGTH) {
      throw new ProtocolCodecError("malformed_message", `${label} contains an oversized key (${utf8ByteLength(key)} bytes)`);
    }
  }
  consumeWork(work, 1 + keys.length);
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

function assertRequiredField(value: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new ProtocolCodecError("malformed_message", `${label} is required`);
  }
  return value[key];
}

function assertString(value: unknown, label: string, work: DecoderWork, allowEmpty = true): string {
  if (typeof value !== "string") {
    throw new ProtocolCodecError("malformed_message", `${label} must be a string`);
  }
  consumeWork(work, 1);
  if (!allowEmpty && value.length === 0) {
    throw new ProtocolCodecError("malformed_message", `${label} must not be empty`);
  }
  const byteLength = utf8ByteLength(value);
  if (byteLength > MAX_STRING_LENGTH) {
    throw new ProtocolCodecError("malformed_message", `${label} exceeds the ${MAX_STRING_LENGTH} byte limit`);
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

function assertBoolean(value: unknown, label: string, work: DecoderWork): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolCodecError("malformed_message", `${label} must be a boolean`);
  }
  consumeWork(work, 1);
  return value;
}

function assertFiniteNumber(value: unknown, label: string, work: DecoderWork): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolCodecError("invalid_integer", `${label} must be a finite number`);
  }
  consumeWork(work, 1);
  return value;
}

function assertMaterialId(value: unknown, label: string, work: DecoderWork): number {
  const materialId = assertInteger(value, label, work, 0, MAX_INTEGER);
  if (materialId === MaterialId.Empty) {
    throw new ProtocolCodecError("malformed_message", `${label} must reference a non-empty material`);
  }
  if (!Object.prototype.hasOwnProperty.call(MATERIALS, materialId)) {
    throw new ProtocolCodecError("malformed_message", `${label} must reference a known material`);
  }
  return materialId;
}

function assertNonNegativeFiniteNumber(value: unknown, label: string, work: DecoderWork): number {
  const finite = assertFiniteNumber(value, label, work);
  if (finite < 0) {
    throw new ProtocolCodecError("invalid_integer", `${label} must be >= 0`);
  }
  return finite;
}

function assertOptionalNonNegativeFiniteNumber(value: unknown, label: string, work: DecoderWork): number | null {
  if (value === null) {
    return null;
  }
  return assertNonNegativeFiniteNumber(value, label, work);
}

function assertNonNegativeInteger(value: unknown, label: string, work: DecoderWork): number {
  return assertInteger(value, label, work, 0, MAX_INTEGER);
}

function assertLiteralString<T extends string>(value: unknown, label: string, work: DecoderWork, allowedValues: ReadonlySet<T>): T {
  const text = assertString(value, label, work, false);
  if (!allowedValues.has(text as T)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be one of ${Array.from(allowedValues).join(", ")}`);
  }
  return text as T;
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
  if (utf8ByteLength(roomIdText) > MAX_ID_LENGTH) {
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
  if (utf8ByteLength(playerIdText) > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parsePlayerId(playerIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid player id`);
  }
}

function assertObjectId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parseObjectId> {
  const objectIdText = assertString(value, label, work, false);
  if (utf8ByteLength(objectIdText) > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parseObjectId(objectIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid object id`);
  }
}

function assertOptionalObjectId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parseObjectId> | null {
  if (value === null) {
    return null;
  }
  return assertObjectId(value, label, work);
}

function assertCommandId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parseCommandId> {
  const commandIdText = assertString(value, label, work, false);
  if (utf8ByteLength(commandIdText) > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parseCommandId(commandIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid command id`);
  }
}

function assertOptionalString(value: unknown, label: string, work: DecoderWork, allowEmpty = true): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertString(value, label, work, allowEmpty);
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
    if (lowered.includes("unsupported") && (lowered.includes("schema") || lowered.includes("version"))) {
      throw new ProtocolCodecError("unsupported_schema_version", `${label}: ${message}`);
    }
    if (lowered.includes("revision")) {
      throw new ProtocolCodecError("invalid_revision", `${label}: ${message}`);
    }
    if (lowered.includes("dimension") || lowered.includes("griddimensions")) {
      throw new ProtocolCodecError("invalid_dimensions", `${label}: ${message}`);
    }
    throw new ProtocolCodecError("malformed_message", `${label}: ${message}`);
  }
}

function assertReplicaRecord(value: unknown, label: string, work: DecoderWork): Record<string, unknown> {
  const object = assertPlainObject(value, label, work);
  const keys = Object.keys(object);
  if (keys.length > MAX_OBJECT_FIELDS) {
    throw new ProtocolCodecError("malformed_message", `${label} exceeds the ${MAX_OBJECT_FIELDS} field limit`);
  }
  return object;
}

function assertReplicaObject(value: unknown, label: string, allowedFields: ReadonlySet<string>, work: DecoderWork): Record<string, unknown> {
  const object = assertReplicaRecord(value, label, work);
  assertAllowedFields(object, label, allowedFields, work);
  return object;
}

function assertArray(value: unknown, label: string, work: DecoderWork, maxLength = MAX_BATCH_COMMANDS, errorCode: ProtocolErrorCode = "malformed_message"): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an array`);
  }
  if (value.length > maxLength) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxLength} entry limit`);
  }
  consumeWork(work, 1 + value.length);
  return value;
}

function assertReplicaArray(value: unknown, label: string, work: DecoderWork, maxLength = MAX_NESTED_COLLECTION_ITEMS, errorCode: ProtocolErrorCode = "malformed_message"): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an array`);
  }
  if (value.length > maxLength) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxLength} entry limit`);
  }
  consumeWork(work, 1 + value.length);
  return value;
}

function assertReplicaMap(value: unknown, label: string, work: DecoderWork, maxEntries = MAX_NESTED_COLLECTION_ITEMS, errorCode: ProtocolErrorCode = "malformed_message"): Record<string, unknown> {
  const object = assertReplicaRecord(value, label, work);
  const keys = Object.keys(object);
  if (keys.length > maxEntries) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxEntries} entry limit`);
  }
  consumeWork(work, 1 + keys.length);
  return object;
}

function assertReplicaValue(value: unknown, label: string, work: DecoderWork): void {
  if (value === null || value === undefined) {
    consumeWork(work, 1);
    return;
  }
  if (typeof value === "string") {
    assertString(value, label, work, true);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    consumeWork(work, 1);
    return;
  }
  if (Array.isArray(value)) {
    enterDepth(work);
    try {
      const arrayValue = assertReplicaArray(value, label, work);
      for (let index = 0; index < arrayValue.length; index += 1) {
        assertReplicaValue(arrayValue[index], `${label}[${index}]`, work);
      }
    } finally {
      leaveDepth(work);
    }
    return;
  }
  if (typeof value === "object") {
    enterDepth(work);
    try {
      const objectValue = assertReplicaRecord(value, label, work);
      for (const [key, entry] of Object.entries(objectValue)) {
        assertReplicaValue(entry, `${label}.${key}`, work);
      }
    } finally {
      leaveDepth(work);
    }
    return;
  }
  throw new ProtocolCodecError("malformed_message", `${label} has an unsupported value`);
}

function assertSnapshotShape(value: unknown, work: DecoderWork): void {
  const snapshot = assertReplicaObject(value, "snapshot", new Set(["version", "worldRevision", "checksum", "worldState"]), work);
  assertSchemaVersion(snapshot["version"], "snapshot.version", work, WORLD_SNAPSHOT_SCHEMA_VERSION);
  assertNonNegativeInteger(snapshot["worldRevision"], "snapshot.worldRevision", work);
  assertString(snapshot["checksum"], "snapshot.checksum", work, false);
  assertWorldStateShape(snapshot["worldState"], work);
}

function assertWorldStateShape(value: unknown, work: DecoderWork): void {
  const worldState = assertReplicaObject(value, "world state", new Set([
    "schemaVersion",
    "roomId",
    "grid",
    "random",
    "players",
    "fallingObjects",
    "paused",
    "tick",
    "time",
    "weather",
    "nextPlayerOrdinal",
    "nextObjectOrdinal",
    "ownerPlayerId",
    "worldRevision",
    "nextAuthorityOrder",
    "commandLedger",
  ]), work);
  assertSchemaVersion(worldState["schemaVersion"], "worldState.schemaVersion", work, WORLD_STATE_SCHEMA_VERSION);
  assertRoomId(worldState["roomId"], "worldState.roomId", work);
  assertGridShape(worldState["grid"], work);
  assertRandomShape(worldState["random"], "random", work);
  assertPlayerMapShape(worldState["players"], work);
  assertFallingObjectMapShape(worldState["fallingObjects"], work);
  assertReplicaValue(worldState["paused"], "worldState.paused", work);
  assertNonNegativeInteger(worldState["tick"], "worldState.tick", work);
  assertTimeShape(worldState["time"], "time", work);
  assertWeatherShape(worldState["weather"], "weather", work);
  assertNonNegativeInteger(worldState["nextPlayerOrdinal"], "worldState.nextPlayerOrdinal", work);
  assertNonNegativeInteger(worldState["nextObjectOrdinal"], "worldState.nextObjectOrdinal", work);
  if (worldState["ownerPlayerId"] !== null) {
    assertPlayerId(worldState["ownerPlayerId"], "worldState.ownerPlayerId", work);
  }
  assertNonNegativeInteger(worldState["worldRevision"], "worldState.worldRevision", work);
  assertNonNegativeInteger(worldState["nextAuthorityOrder"], "worldState.nextAuthorityOrder", work);
  assertCommandLedgerShape(worldState["commandLedger"], work);
}

function assertGridShape(value: unknown, work: DecoderWork): void {
  const grid = assertReplicaObject(value, "grid", new Set(["width", "height", "ids", "shade", "auxiliary", "objectMembership", "cellRevisions"]), work);
  const width = assertNonNegativeInteger(grid["width"], "grid.width", work);
  const height = assertNonNegativeInteger(grid["height"], "grid.height", work);
  const totalCells = width * height;
  if (totalCells > MAX_NESTED_COLLECTION_ITEMS) {
    throw new ProtocolCodecError("malformed_message", "grid dimensions exceed the nested collection limit");
  }
  assertReplicaArray(grid["ids"], "grid.ids", work, totalCells);
  assertReplicaArray(grid["shade"], "grid.shade", work, totalCells);
  assertReplicaArray(grid["auxiliary"], "grid.auxiliary", work, totalCells);
  assertReplicaArray(grid["cellRevisions"], "grid.cellRevisions", work, totalCells);
  const objectMembership = assertReplicaArray(grid["objectMembership"], "grid.objectMembership", work);
  for (let index = 0; index < objectMembership.length; index += 1) {
    const entry = assertReplicaObject(objectMembership[index], `grid.objectMembership[${index}]`, new Set(["x", "y", "objectId"]), work);
    assertNonNegativeInteger(entry["x"], `grid.objectMembership[${index}].x`, work);
    assertNonNegativeInteger(entry["y"], `grid.objectMembership[${index}].y`, work);
    assertOptionalObjectId(entry["objectId"], `grid.objectMembership[${index}].objectId`, work);
  }
}

function assertRandomShape(value: unknown, label: string, work: DecoderWork): void {
  const random = assertReplicaObject(value, label, new Set(["algorithm", "seed", "state"]), work);
  assertString(random["algorithm"], `${label}.algorithm`, work, false);
  assertNonNegativeInteger(random["seed"], `${label}.seed`, work);
  assertNonNegativeInteger(random["state"], `${label}.state`, work);
}

function assertPlayerMapShape(value: unknown, work: DecoderWork): void {
  const players = assertReplicaMap(value, "players", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [playerId, playerState] of Object.entries(players)) {
    assertPlayerId(playerId, `players.${playerId}`, work);
    assertPlayerStateShape(playerState, `players.${playerId}`, work);
  }
}

function assertPlayerStateShape(value: unknown, label: string, work: DecoderWork): void {
  const player = assertReplicaObject(value, label, new Set([
    "id",
    "x",
    "y",
    "vx",
    "vy",
    "width",
    "height",
    "grounded",
    "facing",
    "airTicks",
    "previousJumpHeld",
    "swingElapsedTicks",
    "faucetCooldownUntilTick",
    "crouching",
    "lookingUp",
    "swimming",
    "input",
    "inventory",
    "hotbar",
    "activeHotbarSlot",
    "inventoryRevision",
    "pendingRefunds",
  ]), work);
  assertPlayerId(player["id"], `${label}.id`, work);
  assertReplicaValue(player["x"], `${label}.x`, work);
  assertReplicaValue(player["y"], `${label}.y`, work);
  assertReplicaValue(player["vx"], `${label}.vx`, work);
  assertReplicaValue(player["vy"], `${label}.vy`, work);
  assertReplicaValue(player["width"], `${label}.width`, work);
  assertReplicaValue(player["height"], `${label}.height`, work);
  assertReplicaValue(player["grounded"], `${label}.grounded`, work);
  assertReplicaValue(player["facing"], `${label}.facing`, work);
  assertReplicaValue(player["airTicks"], `${label}.airTicks`, work);
  assertReplicaValue(player["previousJumpHeld"], `${label}.previousJumpHeld`, work);
  assertReplicaValue(player["swingElapsedTicks"], `${label}.swingElapsedTicks`, work);
  assertReplicaValue(player["faucetCooldownUntilTick"], `${label}.faucetCooldownUntilTick`, work);
  assertReplicaValue(player["crouching"], `${label}.crouching`, work);
  assertReplicaValue(player["lookingUp"], `${label}.lookingUp`, work);
  assertReplicaValue(player["swimming"], `${label}.swimming`, work);
  assertInputShape(player["input"], `${label}.input`, work);
  assertInventoryShape(player["inventory"], `${label}.inventory`, work);
  assertHotbarShape(player["hotbar"], `${label}.hotbar`, work);
  assertNonNegativeInteger(player["activeHotbarSlot"], `${label}.activeHotbarSlot`, work);
  assertNonNegativeInteger(player["inventoryRevision"], `${label}.inventoryRevision`, work);
  assertPendingRefundsShape(player["pendingRefunds"], `${label}.pendingRefunds`, work);
}

function assertInputShape(value: unknown, label: string, work: DecoderWork): void {
  const input = assertReplicaObject(value, label, new Set(["left", "right", "jumpHeld", "crouchHeld", "lookUpHeld", "mineHeld"]), work);
  assertReplicaValue(input["left"], `${label}.left`, work);
  assertReplicaValue(input["right"], `${label}.right`, work);
  assertReplicaValue(input["jumpHeld"], `${label}.jumpHeld`, work);
  assertReplicaValue(input["crouchHeld"], `${label}.crouchHeld`, work);
  assertReplicaValue(input["lookUpHeld"], `${label}.lookUpHeld`, work);
  assertReplicaValue(input["mineHeld"], `${label}.mineHeld`, work);
}

function assertInventoryShape(value: unknown, label: string, work: DecoderWork): void {
  const inventory = assertReplicaMap(value, label, work, MAX_NESTED_COLLECTION_ITEMS);
  for (const [key, entry] of Object.entries(inventory)) {
    assertString(key, `${label}.${key}`, work, false);
    assertNonNegativeInteger(entry, `${label}.${key}`, work);
  }
}

function assertHotbarShape(value: unknown, label: string, work: DecoderWork): void {
  const hotbar = assertReplicaArray(value, label, work, 10);
  if (hotbar.length !== 10) {
    throw new ProtocolCodecError("malformed_message", `${label} must have exactly 10 entries`);
  }
  for (let index = 0; index < hotbar.length; index += 1) {
    const entryValue = hotbar[index];
    if (entryValue === null) {
      continue;
    }
    if (typeof entryValue !== "object") {
      throw new ProtocolCodecError("malformed_message", `${label}[${index}] must be an object or null`);
    }
    const entry = entryValue as Record<string, unknown>;
    const kind = assertLiteralString(entry["kind"], `${label}[${index}].kind`, work, new Set(["empty", "pickaxe", "material"]));
    const item = kind === "material"
      ? assertReplicaObject(entry, `${label}[${index}]`, new Set(["kind", "materialId", "count"]), work)
      : assertReplicaObject(entry, `${label}[${index}]`, new Set(["kind"]), work);
    if (kind === "material") {
      assertMaterialId(item["materialId"], `${label}[${index}].materialId`, work);
      assertInteger(item["count"], `${label}[${index}].count`, work, 1, MAX_STACK);
    }
  }
}

function assertPendingRefundsShape(value: unknown, label: string, work: DecoderWork): void {
  const refunds = assertReplicaMap(value, label, work, MAX_NESTED_COLLECTION_ITEMS);
  for (const [key, entry] of Object.entries(refunds)) {
    assertString(key, `${label}.${key}`, work, false);
    assertNonNegativeInteger(entry, `${label}.${key}`, work);
  }
}

function assertFallingObjectMapShape(value: unknown, work: DecoderWork): void {
  const fallingObjects = assertReplicaMap(value, "fallingObjects", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [objectId, state] of Object.entries(fallingObjects)) {
    assertObjectId(objectId, `fallingObjects.${objectId}`, work);
    assertFallingObjectShape(state, `fallingObjects.${objectId}`, work);
  }
}

function assertFallingObjectShape(value: unknown, label: string, work: DecoderWork): void {
  const fallingObject = assertReplicaObject(value, label, new Set(["id", "materialId", "x", "y", "restY", "vy", "offsets", "provenance"]), work);
  assertObjectId(fallingObject["id"], `${label}.id`, work);
  const materialId = assertMaterialId(fallingObject["materialId"], `${label}.materialId`, work);
  assertReplicaValue(fallingObject["x"], `${label}.x`, work);
  assertReplicaValue(fallingObject["y"], `${label}.y`, work);
  assertReplicaValue(fallingObject["restY"], `${label}.restY`, work);
  assertReplicaValue(fallingObject["vy"], `${label}.vy`, work);
  const offsets = assertReplicaArray(fallingObject["offsets"], `${label}.offsets`, work, MAX_NESTED_COLLECTION_ITEMS);
  for (let index = 0; index < offsets.length; index += 1) {
    const entry = assertReplicaArray(offsets[index], `${label}.offsets[${index}]`, work, 2);
    if (entry.length !== 2) {
      throw new ProtocolCodecError("malformed_message", `${label}.offsets[${index}] must contain exactly 2 numbers`);
    }
    assertReplicaValue(entry[0], `${label}.offsets[${index}][0]`, work);
    assertReplicaValue(entry[1], `${label}.offsets[${index}][1]`, work);
  }
  assertFallingProvenanceShape(fallingObject["provenance"], `${label}.provenance`, work, materialId);
}

function assertFallingProvenanceShape(value: unknown, label: string, work: DecoderWork, objectMaterialId?: number): void {
  const provenance = assertReplicaRecord(value, label, work);
  const kind = assertString(provenance["kind"], `${label}.kind`, work, false);
  if (kind === "legacy") {
    assertAllowedFields(provenance, label, new Set(["kind"]), work);
    return;
  }
  if (kind === "placement") {
    assertAllowedFields(provenance, label, new Set(["kind", "actorId", "commandId", "sourceSlot", "materialId", "amount"]), work);
    assertPlayerId(provenance["actorId"], `${label}.actorId`, work);
    assertCommandId(provenance["commandId"], `${label}.commandId`, work);
    assertInteger(provenance["sourceSlot"], `${label}.sourceSlot`, work, 0, 9);
    const materialId = assertMaterialId(provenance["materialId"], `${label}.materialId`, work);
    assertInteger(provenance["amount"], `${label}.amount`, work, 1, 1);
    if (objectMaterialId !== undefined && materialId !== objectMaterialId) {
      throw new ProtocolCodecError("malformed_message", `${label}.materialId must match the falling object material`);
    }
    return;
  }
  throw new ProtocolCodecError("malformed_message", `${label}.kind must be 'legacy' or 'placement'`);
}

function assertTimeShape(value: unknown, label: string, work: DecoderWork): void {
  const time = assertReplicaObject(value, label, new Set(["dayNightTick"]), work);
  assertNonNegativeInteger(time["dayNightTick"], `${label}.dayNightTick`, work);
}

function assertWeatherShape(value: unknown, label: string, work: DecoderWork): void {
  const weather = assertReplicaObject(value, label, new Set([
    "kind",
    "episodeElapsed",
    "episodeDuration",
    "wind",
    "visualTime",
    "rainAccumulator",
    "lightningFlash",
    "lightningCooldown",
    "boltX",
    "boltY",
    "boltSeed",
  ]), work);
  assertLiteralString(weather["kind"], `${label}.kind`, work, new Set(["clear", "rain", "storm"]));
  assertNonNegativeFiniteNumber(weather["episodeElapsed"], `${label}.episodeElapsed`, work);
  assertNonNegativeFiniteNumber(weather["episodeDuration"], `${label}.episodeDuration`, work);
  assertFiniteNumber(weather["wind"], `${label}.wind`, work);
  assertNonNegativeFiniteNumber(weather["visualTime"], `${label}.visualTime`, work);
  assertNonNegativeFiniteNumber(weather["rainAccumulator"], `${label}.rainAccumulator`, work);
  assertOptionalNonNegativeFiniteNumber(weather["lightningFlash"], `${label}.lightningFlash`, work);
  assertOptionalNonNegativeFiniteNumber(weather["lightningCooldown"], `${label}.lightningCooldown`, work);
  assertOptionalNonNegativeFiniteNumber(weather["boltX"], `${label}.boltX`, work);
  assertOptionalNonNegativeFiniteNumber(weather["boltY"], `${label}.boltY`, work);
  assertNonNegativeFiniteNumber(weather["boltSeed"], `${label}.boltSeed`, work);
}

function assertCommandLedgerShape(value: unknown, work: DecoderWork): void {
  const ledger = assertReplicaObject(value, "commandLedger", new Set(["actorHighWater", "recent"]), work);
  const actorHighWater = assertReplicaMap(ledger["actorHighWater"], "commandLedger.actorHighWater", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [key, entry] of Object.entries(actorHighWater)) {
    assertPlayerId(key, `commandLedger.actorHighWater.${key}`, work);
    assertNonNegativeInteger(entry, `commandLedger.actorHighWater.${key}`, work);
  }
  const recent = assertReplicaArray(ledger["recent"], "commandLedger.recent", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < recent.length; index += 1) {
    assertCommandReceiptShape(recent[index], `commandLedger.recent[${index}]`, work);
  }
}

function assertProtocolCommandResultInvariants(value: Parameters<typeof assertCommandResultInvariants>[0], label: string): void {
  try {
    assertCommandResultInvariants(value, label);
  } catch (error) {
    if (error instanceof ProtocolCodecError) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new ProtocolCodecError("malformed_message", error.message);
    }
    throw error;
  }
}

function assertCommandReceiptShape(value: unknown, label: string, work: DecoderWork): void {
  const receipt = assertReplicaObject(value, label, new Set([
    "commandId",
    "actorId",
    "actorSequence",
    "authorityOrder",
    "issuedTick",
    "processedTick",
    "commandType",
    "code",
    "accepted",
    "beforeWorldRevision",
    "afterWorldRevision",
    "beforeInventoryRevision",
    "afterInventoryRevision",
    "beforeTargetRevision",
    "afterTargetRevision",
    "acceptedEffect",
    "fingerprint",
  ]), work);
  assertCommandId(receipt["commandId"], `${label}.commandId`, work);
  assertPlayerId(receipt["actorId"], `${label}.actorId`, work);
  assertNonNegativeInteger(receipt["actorSequence"], `${label}.actorSequence`, work);
  const authorityOrderValue = receipt["authorityOrder"];
  if (authorityOrderValue !== null) {
    assertNonNegativeInteger(authorityOrderValue, `${label}.authorityOrder`, work);
  }
  assertNonNegativeInteger(receipt["issuedTick"], `${label}.issuedTick`, work);
  assertNonNegativeInteger(receipt["processedTick"], `${label}.processedTick`, work);
  assertLiteralString(receipt["commandType"], `${label}.commandType`, work, new Set([
    "set_input_state",
    "mine_start",
    "mine_stop",
    "select_slot",
    "place",
    "harvest",
    "cycle_faucet",
    "pause_world",
    "resume_world",
    "set_time_preset",
  ]));
  const code = assertLiteralString(receipt["code"], `${label}.code`, work, new Set<ProtocolCommandAcknowledgement["code"]>([
    "accepted",
    "unknown_actor",
    "paused",
    "not_owner",
    "already_state",
    "future_tick",
    "stale",
    "conflict",
    "slot",
    "tool",
    "revision",
    "inventory",
    "target",
    "bounds",
    "range",
    "collision",
    "footprint",
    "work_limit",
    "invalid_command",
  ]));
  const accepted = assertBoolean(receipt["accepted"], `${label}.accepted`, work);
  assertNonNegativeInteger(receipt["beforeWorldRevision"], `${label}.beforeWorldRevision`, work);
  assertNonNegativeInteger(receipt["afterWorldRevision"], `${label}.afterWorldRevision`, work);
  assertNonNegativeInteger(receipt["beforeInventoryRevision"], `${label}.beforeInventoryRevision`, work);
  assertNonNegativeInteger(receipt["afterInventoryRevision"], `${label}.afterInventoryRevision`, work);
  assertNonNegativeInteger(receipt["beforeTargetRevision"], `${label}.beforeTargetRevision`, work);
  assertNonNegativeInteger(receipt["afterTargetRevision"], `${label}.afterTargetRevision`, work);
  const acceptedEffect = receipt["acceptedEffect"] === null ? null : assertString(receipt["acceptedEffect"], `${label}.acceptedEffect`, work, true);
  assertString(receipt["fingerprint"], `${label}.fingerprint`, work, false);
  assertProtocolCommandResultInvariants({
    accepted,
    code,
    authorityOrder: authorityOrderValue === null ? null : authorityOrderValue as number,
    acceptedEffect,
    beforeWorldRevision: receipt["beforeWorldRevision"] as number,
    afterWorldRevision: receipt["afterWorldRevision"] as number,
    beforeInventoryRevision: receipt["beforeInventoryRevision"] as number,
    afterInventoryRevision: receipt["afterInventoryRevision"] as number,
    beforeTargetRevision: receipt["beforeTargetRevision"] as number,
    afterTargetRevision: receipt["afterTargetRevision"] as number,
  }, label);
}

function assertDeltaShape(value: unknown, work: DecoderWork): void {
  const delta = assertReplicaObject(value, "delta", new Set(["version", "baseRevision", "targetRevision", "gridDimensions", "cells", "players", "fallingObjects", "metadata"]), work);
  assertSchemaVersion(delta["version"], "delta.version", work, WORLD_SNAPSHOT_SCHEMA_VERSION);
  const baseRevision = assertNonNegativeInteger(delta["baseRevision"], "delta.baseRevision", work);
  const targetRevision = assertNonNegativeInteger(delta["targetRevision"], "delta.targetRevision", work);
  if (baseRevision > targetRevision) {
    throw new ProtocolCodecError("invalid_revision", "delta.baseRevision cannot exceed delta.targetRevision");
  }
  const cells = assertReplicaArray(delta["cells"], "delta.cells", work, MAX_CELL_DELTAS, "cell_too_large");
  for (let index = 0; index < cells.length; index += 1) {
    assertDeltaCellShape(cells[index], `delta.cells[${index}]`, work);
  }
  const players = assertReplicaArray(delta["players"], "delta.players", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < players.length; index += 1) {
    assertDeltaEntityShape(players[index], `delta.players[${index}]`, "playerId", assertPlayerStateShape, assertPlayerId, work);
  }
  const fallingObjects = assertReplicaArray(delta["fallingObjects"], "delta.fallingObjects", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < fallingObjects.length; index += 1) {
    assertDeltaEntityShape(fallingObjects[index], `delta.fallingObjects[${index}]`, "objectId", assertFallingObjectShape, assertObjectId, work);
  }
  const metadata = assertReplicaArray(delta["metadata"], "delta.metadata", work, MAX_METADATA_ENTRIES, "entity_too_large");
  for (let index = 0; index < metadata.length; index += 1) {
    assertDeltaMetadataShape(metadata[index], `delta.metadata[${index}]`, work);
  }
  if (Object.prototype.hasOwnProperty.call(delta, "gridDimensions")) {
    assertGridDimensionsShape(delta["gridDimensions"], work);
  }
}

function assertGridDimensionsShape(value: unknown, work: DecoderWork): void {
  const dimensions = assertReplicaObject(value, "gridDimensions", new Set(["width", "height"]), work);
  assertNonNegativeInteger(dimensions["width"], "gridDimensions.width", work);
  assertNonNegativeInteger(dimensions["height"], "gridDimensions.height", work);
}

function assertDeltaCellShape(value: unknown, label: string, work: DecoderWork): void {
  const cell = assertReplicaObject(value, label, new Set(["index", "materialId", "shade", "auxiliary", "objectId", "revision"]), work);
  assertNonNegativeInteger(cell["index"], `${label}.index`, work);
  assertNonNegativeInteger(cell["materialId"], `${label}.materialId`, work);
  assertReplicaValue(cell["shade"], `${label}.shade`, work);
  assertReplicaValue(cell["auxiliary"], `${label}.auxiliary`, work);
  assertOptionalObjectId(cell["objectId"], `${label}.objectId`, work);
  assertNonNegativeInteger(cell["revision"], `${label}.revision`, work);
}

function assertDeltaEntityShape(value: unknown, label: string, entityIdField: string, stateValidator: (value: unknown, label: string, work: DecoderWork) => void, idValidator: (value: unknown, label: string, work: DecoderWork) => void, work: DecoderWork): void {
  const entity = assertReplicaObject(value, label, new Set([entityIdField, "state"]), work);
  idValidator(entity[entityIdField], `${label}.${entityIdField}`, work);
  if (entity["state"] !== null) {
    stateValidator(entity["state"], `${label}.state`, work);
  }
}

function assertDeltaMetadataShape(value: unknown, label: string, work: DecoderWork): void {
  const metadata = assertReplicaObject(value, label, new Set(["field", "value"]), work);
  const field = assertLiteralString(metadata["field"], `${label}.field`, work, new Set([
    "roomId",
    "tick",
    "paused",
    "time",
    "weather",
    "random",
    "ownerPlayerId",
    "worldRevision",
    "nextAuthorityOrder",
    "nextPlayerOrdinal",
    "nextObjectOrdinal",
    "commandLedger",
  ]));
  switch (field) {
    case "roomId":
      assertRoomId(metadata["value"], `${label}.value`, work);
      return;
    case "tick":
    case "worldRevision":
      assertNonNegativeInteger(metadata["value"], `${label}.value`, work);
      return;
    case "paused":
      assertBoolean(metadata["value"], `${label}.value`, work);
      return;
    case "time":
      assertTimeShape(metadata["value"], `${label}.value`, work);
      return;
    case "weather":
      assertWeatherShape(metadata["value"], `${label}.value`, work);
      return;
    case "random":
      assertRandomShape(metadata["value"], `${label}.value`, work);
      return;
    case "ownerPlayerId":
      if (metadata["value"] !== null) {
        assertPlayerId(metadata["value"], `${label}.value`, work);
      }
      return;
    case "nextAuthorityOrder":
    case "nextPlayerOrdinal":
    case "nextObjectOrdinal":
      assertInteger(metadata["value"], `${label}.value`, work, 1, MAX_INTEGER);
      return;
    case "commandLedger":
      assertCommandLedgerMetadataShape(metadata["value"], `${label}.value`, work);
      return;
    default:
      throw new ProtocolCodecError("malformed_message", `${label}.field has an unsupported value`);
  }
}

function assertCommandLedgerMetadataShape(value: unknown, label: string, work: DecoderWork): void {
  const ledger = assertReplicaRecord(value, label, work);
  if (Object.prototype.hasOwnProperty.call(ledger, "kind")) {
    assertLiteralString(ledger["kind"], `${label}.kind`, work, new Set(["incremental"]));
    assertAllowedFields(ledger, label, new Set(["kind", "actorHighWater", "appendedReceipts", "trimmedCount"]), work);
    const actorHighWater = assertReplicaMap(ledger["actorHighWater"], `${label}.actorHighWater`, work, MAX_ENTITY_DELTAS, "entity_too_large");
    for (const [actorId, entry] of Object.entries(actorHighWater)) {
      assertPlayerId(actorId, `${label}.actorHighWater.${actorId}`, work);
      assertNonNegativeInteger(entry, `${label}.actorHighWater.${actorId}`, work);
    }
    const appendedReceipts = assertReplicaArray(ledger["appendedReceipts"], `${label}.appendedReceipts`, work, MAX_ENTITY_DELTAS, "entity_too_large");
    for (let index = 0; index < appendedReceipts.length; index += 1) {
      assertCommandReceiptShape(appendedReceipts[index], `${label}.appendedReceipts[${index}]`, work);
    }
    assertNonNegativeInteger(ledger["trimmedCount"], `${label}.trimmedCount`, work);
    return;
  }
  assertAllowedFields(ledger, label, new Set(["actorHighWater", "recent"]), work);
  const actorHighWater = assertReplicaMap(ledger["actorHighWater"], `${label}.actorHighWater`, work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [actorId, entry] of Object.entries(actorHighWater)) {
    assertPlayerId(actorId, `${label}.actorHighWater.${actorId}`, work);
    assertNonNegativeInteger(entry, `${label}.actorHighWater.${actorId}`, work);
  }
  const recent = assertReplicaArray(ledger["recent"], `${label}.recent`, work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < recent.length; index += 1) {
    assertCommandReceiptShape(recent[index], `${label}.recent[${index}]`, work);
  }
}

function assertCommandValueBounds(command: ProtocolClientCommand, work: DecoderWork): void {
  const { command: gameplayCommand } = command;
  switch (gameplayCommand.type) {
    case "set_input_state":
      return;
    case "mine_start":
    case "mine_stop":
      return;
    case "select_slot": {
      assertInteger(gameplayCommand.slot, "command.slot", work, 0, 9);
      assertNonNegativeInteger(gameplayCommand.expectedInventoryRevision, "command.expectedInventoryRevision", work);
      return;
    }
    case "place": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertInteger(gameplayCommand.brushRadius, "command.brushRadius", work, 1, 16);
      assertNonNegativeInteger(gameplayCommand.expectedInventoryRevision, "command.expectedInventoryRevision", work);
      assertNonNegativeInteger(gameplayCommand.expectedAnchorRevision, "command.expectedAnchorRevision", work);
      return;
    }
    case "harvest": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertNonNegativeInteger(gameplayCommand.expectedTargetRevision, "command.expectedTargetRevision", work);
      return;
    }
    case "cycle_faucet": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertObjectId(gameplayCommand.objectId, "command.objectId", work);
      assertNonNegativeInteger(gameplayCommand.expectedTargetRevision, "command.expectedTargetRevision", work);
      return;
    }
    case "pause_world":
    case "resume_world": {
      assertNonNegativeInteger(gameplayCommand.expectedWorldRevision, "command.expectedWorldRevision", work);
      return;
    }
    case "set_time_preset": {
      assertNonNegativeInteger(gameplayCommand.expectedWorldRevision, "command.expectedWorldRevision", work);
      return;
    }
    default: {
      throw new ProtocolCodecError("malformed_message", "command type is unsupported");
    }
  }
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
  const protocolCommand = { clientSequence, issuedTick, command };
  assertCommandValueBounds(protocolCommand, work);
  return protocolCommand;
}

function assertCommandBatch(value: Record<string, unknown>, work: DecoderWork): ProtocolCommandBatchMessage {
  const allowedFields = new Set(["kind", "streamSequence", "commands"]);
  assertAllowedFields(value, "command batch", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const commands = assertArray(value["commands"], "commands", work, MAX_BATCH_COMMANDS, "batch_too_large").map((entry) => assertCommand(entry, work));
  return { kind: "command_batch", streamSequence, commands };
}

function assertCommandAcknowledgement(value: unknown, work: DecoderWork): ProtocolCommandAcknowledgement {
  const ackObject = assertPlainObject(value, "command acknowledgement", work);
  const allowedFields = new Set(["clientSequence", "issuedTick", "accepted", "code", "authorityOrder", "processedTick", "beforeWorldRevision", "afterWorldRevision", "beforeInventoryRevision", "afterInventoryRevision", "beforeTargetRevision", "afterTargetRevision", "acceptedEffect"]);
  assertAllowedFields(ackObject, "command acknowledgement", allowedFields, work);
  const clientSequence = assertNonNegativeInteger(ackObject["clientSequence"], "clientSequence", work);
  const issuedTick = assertNonNegativeInteger(ackObject["issuedTick"], "issuedTick", work);
  const acceptedValue = assertRequiredField(ackObject, "accepted", "accepted");
  const accepted = typeof acceptedValue === "boolean" ? acceptedValue : (() => { throw new ProtocolCodecError("malformed_message", "accepted must be a boolean"); })();
  const code = assertLiteralString(assertRequiredField(ackObject, "code", "code"), "code", work, new Set<ProtocolCommandAcknowledgement["code"]>([
    "accepted",
    "unknown_actor",
    "paused",
    "not_owner",
    "already_state",
    "future_tick",
    "stale",
    "conflict",
    "slot",
    "tool",
    "revision",
    "inventory",
    "target",
    "bounds",
    "range",
    "collision",
    "footprint",
    "work_limit",
    "invalid_command",
  ]));
  const authorityOrderValue = assertRequiredField(ackObject, "authorityOrder", "authorityOrder");
  const authorityOrder = authorityOrderValue === null ? null : assertInteger(authorityOrderValue, "authorityOrder", work, 1, MAX_INTEGER);
  const processedTick = assertNonNegativeInteger(assertRequiredField(ackObject, "processedTick", "processedTick"), "processedTick", work);
  const beforeWorldRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeWorldRevision", "beforeWorldRevision"), "beforeWorldRevision", work);
  const afterWorldRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterWorldRevision", "afterWorldRevision"), "afterWorldRevision", work);
  const beforeInventoryRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeInventoryRevision", "beforeInventoryRevision"), "beforeInventoryRevision", work);
  const afterInventoryRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterInventoryRevision", "afterInventoryRevision"), "afterInventoryRevision", work);
  const beforeTargetRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeTargetRevision", "beforeTargetRevision"), "beforeTargetRevision", work);
  const afterTargetRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterTargetRevision", "afterTargetRevision"), "afterTargetRevision", work);
  const acceptedEffectValue = assertRequiredField(ackObject, "acceptedEffect", "acceptedEffect");
  const acceptedEffect = acceptedEffectValue === null ? null : assertString(acceptedEffectValue, "acceptedEffect", work, true);
  assertProtocolCommandResultInvariants({
    accepted,
    code,
    authorityOrder,
    acceptedEffect,
    beforeWorldRevision,
    afterWorldRevision,
    beforeInventoryRevision,
    afterInventoryRevision,
    beforeTargetRevision,
    afterTargetRevision,
  }, "command acknowledgement");
  return {
    clientSequence,
    issuedTick,
    accepted,
    code,
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
  const acknowledgements = assertArray(value["acknowledgements"], "acknowledgements", work, MAX_BATCH_COMMANDS, "batch_too_large").map((entry) => assertCommandAcknowledgement(entry, work));
  return { kind: "command_acknowledgement", streamSequence, acknowledgements };
}

function assertSnapshotMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolSnapshotMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "snapshot"]);
  assertAllowedFields(value, "snapshot message", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  assertSnapshotShape(value["snapshot"], work);
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
  assertDeltaShape(value["delta"], work);
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
  const reason = value["reason"] === undefined ? undefined : assertLiteralString(value["reason"], "reason", work, new Set<ProtocolResyncReason>(["stale", "out_of_date", "delta_gap", "protocol_error"]));
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_request", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertResyncRequired(value: Record<string, unknown>, work: DecoderWork): ProtocolResyncRequiredMessage {
  const allowedFields = new Set(["kind", "streamSequence", "reason", "lastKnownStreamSequence", "lastKnownWorldRevision"]);
  assertAllowedFields(value, "resync required", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const reason = assertLiteralString(value["reason"], "reason", work, new Set<ProtocolResyncReason>(["stale", "out_of_date", "delta_gap", "protocol_error"]));
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_required", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertProtocolError(value: Record<string, unknown>, work: DecoderWork): ProtocolErrorMessage {
  const allowedFields = new Set(["kind", "streamSequence", "code", "message"]);
  assertAllowedFields(value, "protocol error", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolErrorCode>([
    "unsupported_protocol_version",
    "unsupported_message_kind",
    "unsupported_schema_version",
    "invalid_json",
    "invalid_utf8",
    "frame_too_large",
    "malformed_message",
    "unknown_field",
    "invalid_id",
    "invalid_integer",
    "invalid_revision",
    "invalid_dimensions",
    "batch_too_large",
    "cell_too_large",
    "entity_too_large",
    "decoder_work_limit_exceeded",
  ]));
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
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolRoomClosureCode>(["room_closed", "room_replaced", "server_shutdown", "protocol_error"]));
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
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "roomId", "resumeToken"]);
  assertAllowedFields(value, "join", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const resumeToken = value["resumeToken"] === undefined ? undefined : assertString(value["resumeToken"], "resumeToken", work, false);
  return {
    kind: "join",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    roomId,
    resumeToken,
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
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolJoinRejectCode>([
    "room_not_found",
    "room_full",
    "already_joined",
    "unauthorized",
    "protocol_error",
  ]));
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
  const work: DecoderWork = { used: 0, depth: 0 };
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
