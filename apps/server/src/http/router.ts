import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServerConfig } from "../config.js";
import { HttpRouteError } from "../errors.js";
import type { RoomManager } from "../room/room-manager.js";

export interface HttpServerDependencies {
  readonly config: ServerConfig;
  readonly roomManager: RoomManager;
}

const MAX_REQUEST_BODY_BYTES = 1024;

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(response: ServerResponse, path: string, allow: string[]): void {
  response.setHeader("allow", allow.join(", "));
  sendJson(response, 405, { error: { code: "method_not_allowed", message: `method not allowed for ${path}`, allow } });
}

function parseRequestUrl(request: IncomingMessage): URL {
  if (!request.url) {
    throw new HttpRouteError(400, "invalid_request", "request URL is missing");
  }
  try {
    return new URL(request.url, "http://127.0.0.1");
  } catch {
    throw new HttpRouteError(400, "invalid_request", "request URL is invalid");
  }
}

async function readBody(request: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpRouteError(413, "request_too_large", "request body exceeds the maximum size");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function parseRoomCreateBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpRouteError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const body = await readBody(request);
  if (body.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpRouteError(400, "invalid_json", "request body must be valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRouteError(400, "invalid_request", "request body must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 0) {
    throw new HttpRouteError(400, "invalid_request", "request body must not contain any fields");
  }
  return {};
}

export function createHttpServer(dependencies: HttpServerDependencies) {
  const { config, roomManager } = dependencies;
  return createServer(async (request, response) => {
    try {
      const url = parseRequestUrl(request);
      if (request.method === "GET" && url.pathname === config.healthPath) {
        const lifecycle = roomManager.lifecycle;
        sendJson(response, 200, {
          status: lifecycle.ready ? "ready" : lifecycle.shuttingDown ? "shutting_down" : "admission_closed",
          ready: lifecycle.ready,
          admitting: lifecycle.admissionOpen,
          shuttingDown: lifecycle.shuttingDown,
          rooms: roomManager.roomCount,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === config.roomsPath) {
        await parseRoomCreateBody(request);
        const room = await roomManager.createRoom();
        sendJson(response, 201, {
          roomId: room.roomId,
          memberships: [],
          ownerPlayerId: null,
          joinAccepted: false,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === config.healthPath) {
        return;
      }

      if (url.pathname === config.healthPath) {
        sendMethodNotAllowed(response, url.pathname, ["GET"]);
        return;
      }

      if (url.pathname === config.roomsPath) {
        sendMethodNotAllowed(response, url.pathname, ["POST"]);
        return;
      }

      throw new HttpRouteError(404, "not_found", "route not found");
    } catch (error) {
      if (error instanceof HttpRouteError) {
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 500, { error: { code: "internal_error", message: "an unexpected error occurred" } });
    }
  });
}
