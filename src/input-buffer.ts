export interface InputEdgeBuffer {
  heldJump: boolean;
  heldMine: boolean;
  latchedJump: boolean;
  latchedMine: boolean;
  previousJump: boolean;
  previousMine: boolean;
}

export interface RawClientInputs {
  jump: boolean;
  mine: boolean;
}

export interface BufferedClientInputs {
  jumpHeld: boolean;
  mineHeld: boolean;
}

export function createInputEdgeBuffer(): InputEdgeBuffer {
  return {
    heldJump: false,
    heldMine: false,
    latchedJump: false,
    latchedMine: false,
    previousJump: false,
    previousMine: false,
  };
}

export function updateInputEdgeBuffer(buffer: InputEdgeBuffer, inputs: RawClientInputs): void {
  if (inputs.jump && !buffer.previousJump) {
    buffer.latchedJump = true;
  }
  if (inputs.mine && !buffer.previousMine) {
    buffer.latchedMine = true;
  }
  buffer.previousJump = inputs.jump;
  buffer.previousMine = inputs.mine;
  buffer.heldJump = inputs.jump;
  buffer.heldMine = inputs.mine;
}

export function consumeBufferedInputs(buffer: InputEdgeBuffer): BufferedClientInputs {
  const jumpHeld = buffer.latchedJump || buffer.heldJump;
  const mineHeld = buffer.latchedMine || buffer.heldMine;
  if (buffer.latchedJump) buffer.latchedJump = false;
  if (buffer.latchedMine) buffer.latchedMine = false;
  return { jumpHeld, mineHeld };
}
