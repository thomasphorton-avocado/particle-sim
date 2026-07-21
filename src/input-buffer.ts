export interface InputEdgeBuffer {
  heldJump: boolean;
  heldMine: boolean;
  latchedJump: boolean;
  latchedMine: boolean;
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
  };
}

export function setInputEdgeBufferHeld(buffer: InputEdgeBuffer, control: keyof Pick<RawClientInputs, "jump" | "mine">, pressed: boolean): void {
  if (control === "jump") {
    if (pressed && !buffer.heldJump) {
      buffer.latchedJump = true;
    }
    buffer.heldJump = pressed;
    return;
  }

  if (pressed && !buffer.heldMine) {
    buffer.latchedMine = true;
  }
  buffer.heldMine = pressed;
}

export function updateInputEdgeBuffer(buffer: InputEdgeBuffer, inputs: RawClientInputs): void {
  setInputEdgeBufferHeld(buffer, "jump", inputs.jump);
  setInputEdgeBufferHeld(buffer, "mine", inputs.mine);
}

export function consumeBufferedInputs(buffer: InputEdgeBuffer): BufferedClientInputs {
  const jumpHeld = buffer.latchedJump || buffer.heldJump;
  const mineHeld = buffer.latchedMine || buffer.heldMine;
  buffer.latchedJump = false;
  buffer.latchedMine = false;
  return { jumpHeld, mineHeld };
}
