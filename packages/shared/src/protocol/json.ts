import { MAX_FRAME_BYTES } from "./limits.js";
import type { ProtocolErrorCode } from "./types.js";

export class ProtocolCodecError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProtocolCodecError";
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type ProtocolFrameInput = Uint8Array | ArrayBuffer | ArrayBufferView | string;

function toUtf8Bytes(input: ProtocolFrameInput): Uint8Array {
  if (typeof input === "string") {
    return textEncoder.encode(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  return input;
}

export function encodeProtocolMessage(message: unknown): Uint8Array {
  const payload = JSON.stringify(message);
  if (payload === undefined) {
    throw new ProtocolCodecError("invalid_json", "Protocol message must be JSON-serializable");
  }
  return textEncoder.encode(payload);
}

export function decodeProtocolMessageFrame(input: ProtocolFrameInput): unknown {
  const bytes = toUtf8Bytes(input);
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new ProtocolCodecError("invalid_utf8", "Protocol message is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolCodecError("malformed_message", "Protocol message is not valid JSON");
  }
}
