export class HttpRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpRouteError";
  }
}

export class AdmissionClosedError extends HttpRouteError {
  constructor(message = "admission is closed") {
    super(503, "admission_closed", message);
  }
}

export class RoomLimitError extends HttpRouteError {
  constructor(message = "room limit reached") {
    super(409, "room_limit_reached", message);
  }
}

export class RoomNotFoundError extends HttpRouteError {
  constructor(roomId: string) {
    super(404, "room_not_found", `room ${roomId} was not found`);
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
