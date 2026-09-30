export function deserialize(hexString) {
  const buf = Buffer.from(hexString, "hex");
  let cursor = 0;

  function readByte() {
    return buf.readUInt8(cursor++);
  }

  function readUInt32() {
    const val = buf.readUInt32LE(cursor);
    cursor += 4;
    return val;
  }

  function readString() {
    const len = readUInt32();
    const str = buf.subarray(cursor, cursor + len).toString("latin1");
    cursor += len;
    return str;
  }

  function readDouble() {
    const val = buf.readDoubleLE(cursor);
    cursor += 8;
    return val;
  }

  function cx(b, h, x) {
    return Math.floor((b / Math.pow(2, h - 1)) % Math.pow(2, (x - 1) - (h - 1) + 1));
  }

  const cz = [];

  function deserializeProto() {
    const patchCount = readUInt32();
    for (let i = 0; i < patchCount; i++) {
      const p = {};
      p[51] = readByte();
      const n = readUInt32();
      const l = readUInt32();
      p[144] = readByte();
      p[159] = cx(n, 1, 2);
      p[124] = cx(l, 1, 11);
      p[27] = cx(n, 3, 11);
      p[32] = cx(n, 12, 20);
      p[121] = cx(n, 21, 29);
      p[4] = cx(l, 12, 33);
      cz.push(p);
    }

    const numParams = readByte();
    const numProtos = readUInt32();
    const protos = [];
    for (let i = 0; i < numProtos; i++) {
      protos.push(deserializeProto());
    }

    const numInst = readUInt32();
    const instructions = [];
    for (let i = 0; i < numInst; i++) {
      const inst = {};
      inst[51] = readByte();
      const hasLines = readByte();
      inst[90] = [];
      if (hasLines === 1) {
        const lineCount = readByte();
        for (let j = 0; j < lineCount; j++) {
          inst[90].push({ isZero: readByte() === 0, line: readUInt32() });
        }
      }
      const m = readUInt32();
      const n = readUInt32();
      inst[159] = cx(m, 1, 2);
      inst[124] = cx(n, 1, 11);
      inst[27] = cx(m, 3, 11);
      inst[4] = cx(n, 12, 33);
      inst[121] = cx(m, 21, 29);
      inst[144] = cx(m, 12, 20);
      instructions.push(inst);
    }

    const numConsts = readUInt32();
    const constants = [];
    for (let i = 1; i <= numConsts; i++) {
      const tag = readByte();
      let val;
      if (tag === 0) val = readByte() !== 0;
      else if (tag === 1) val = readDouble();
      else if (tag === 2 || tag === 4) val = readString();
      constants[i] = val;
    }

    return { numParams, protos, instructions, constants };
  }

  const root = deserializeProto();
  return { root, cz };
}
