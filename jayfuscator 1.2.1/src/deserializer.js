export function deserialize(hexString, fieldKeys = {}) {
  const {
    opField = 124,
    aField = 27,
    bField = 121,
    cField = 4,
    bzField = 32,
    bExtraField = 144,
    tagField = 51,
    typeField = 159
  } = fieldKeys;

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
      const tag = readByte();
      p[tagField] = tag;
      p.tag = tag;

      const n = readUInt32();
      const l = readUInt32();

      const bExtra = readByte();
      p[bExtraField] = bExtra;
      p.bExtra = bExtra;

      p[typeField] = cx(n, 1, 2);
      p.type = p[typeField];

      p[opField] = cx(l, 1, 11);
      p.op = p[opField];

      p[aField] = cx(n, 3, 11);
      p.a = p[aField];

      p[bzField] = cx(n, 12, 20);
      p.bz = p[bzField];

      p[bField] = cx(n, 21, 29);
      p.b = p[bField];

      p[cField] = cx(l, 12, 33);
      p.c = p[cField];

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
      const tag = readByte();
      inst[tagField] = tag;
      inst.tag = tag;

      const hasLines = readByte();
      inst.lines = [];
      if (hasLines === 1) {
        const lineCount = readByte();
        for (let j = 0; j < lineCount; j++) {
          inst.lines.push({ isZero: readByte() === 0, line: readUInt32() });
        }
      }
      const m = readUInt32();
      const n = readUInt32();

      inst[typeField] = cx(m, 1, 2);
      inst.type = inst[typeField];

      inst[opField] = cx(n, 1, 11);
      inst.op = inst[opField];

      inst[aField] = cx(m, 3, 11);
      inst.a = inst[aField];

      inst[cField] = cx(n, 12, 33);
      inst.c = inst[cField];

      inst[bField] = cx(m, 21, 29);
      inst.b = inst[bField];

      inst[bExtraField] = cx(m, 12, 20);
      inst.bz = inst[bExtraField];

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
