export type RoomId = string & { readonly __brand: "RoomId" };
export type PlayerId = string & { readonly __brand: "PlayerId" };
export type ObjectId = string & { readonly __brand: "ObjectId" };
export type CommandId = string & { readonly __brand: "CommandId" };

function validateId(value: unknown, prefix: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const pattern = new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`);
  if (!pattern.test(value)) {
    throw new TypeError(`${label} must match ${prefix}_[A-Za-z0-9_-]+`);
  }
  return value;
}

export function parseRoomId(value: unknown): RoomId {
  return validateId(value, "room", "room id") as RoomId;
}
export function parsePlayerId(value: unknown): PlayerId {
  return validateId(value, "player", "player id") as PlayerId;
}
export function parseObjectId(value: unknown): ObjectId {
  return validateId(value, "object", "object id") as ObjectId;
}
export function parseCommandId(value: unknown): CommandId {
  return validateId(value, "command", "command id") as CommandId;
}

export function formatRoomId(value: RoomId): string {
  return value;
}
export function formatPlayerId(value: PlayerId): string {
  return value;
}
export function formatObjectId(value: ObjectId): string {
  return value;
}
export function formatCommandId(value: CommandId): string {
  return value;
}

export function isRoomId(value: unknown): value is RoomId {
  try {
    parseRoomId(value);
    return true;
  } catch {
    return false;
  }
}
export function isPlayerId(value: unknown): value is PlayerId {
  try {
    parsePlayerId(value);
    return true;
  } catch {
    return false;
  }
}
export function isObjectId(value: unknown): value is ObjectId {
  try {
    parseObjectId(value);
    return true;
  } catch {
    return false;
  }
}
export function isCommandId(value: unknown): value is CommandId {
  try {
    parseCommandId(value);
    return true;
  } catch {
    return false;
  }
}

export function createRoomId(value: string): RoomId {
  return parseRoomId(value);
}
export function createPlayerId(value: string): PlayerId {
  return parsePlayerId(value);
}
export function createObjectId(value: string): ObjectId {
  return parseObjectId(value);
}
export function createCommandId(value: string): CommandId {
  return parseCommandId(value);
}
