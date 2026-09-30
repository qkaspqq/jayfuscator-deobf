export function extractFieldKeys(source) {
  const sanitized = source.replace(/['"][0-9A-Za-z+/=]{200,}['"]/g, '""');
  const bitRegex = /\b(\w+)\[(\d+)\]\s*=\s*(\w+)\s*\(\s*(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  let m;
  const bitMap = {};
  while ((m = bitRegex.exec(sanitized)) !== null) {
    const range = `${m[5]}..${m[6]}`;
    bitMap[range] = parseInt(m[2], 10);
  }

  const tagMatch = sanitized.match(/\b\w+\[(\d+)\]\s*=\s*(?:bl|cv)\s*\(\s*\)\s*;\s*\w+\[\d+\]\s*=\s*\{\s*\}/) ||
                   sanitized.match(/\b\w+\[(\d+)\]\s*=\s*(?:bl|cv)\s*\(\s*\)/);
  const tagField = tagMatch ? parseInt(tagMatch[1], 10) : 51;

  return {
    opField: bitMap["1..11"] || 124,
    aField: bitMap["3..11"] || 27,
    cField: bitMap["12..33"] || 4,
    bField: bitMap["21..29"] || 121,
    typeField: bitMap["1..2"] || 159,
    bzField: bitMap["12..20"] || 32,
    bExtraField: bitMap["12..20"] || 144,
    tagField: tagField
  };
}

export function extractConstTags(source) {
  const sanitized = source.replace(/['"][0-9A-Za-z+/=]{200,}['"]/g, '""');
  const m = sanitized.match(/if\s*\(?([^;]+?)\)?\s*then\s*([^;]+);?\s*elseif\s*\(?([^;]+?)\)?\s*then\s*([^;]+);?\s*elseif\s*\(?([^;]+?)\)?\s*then\s*([^;]+);?\s*elseif\s*\(?([^;]+?)\)?\s*then\s*([^;]+)/);
  const tags = { bool: 0, num: 1, str: 2, env: 3 };
  if (m) {
    let envFunc = null;
    for (let i = 1; i <= 7; i += 2) {
      const cond = m[i];
      const body = m[i + 1];
      const numM = cond.match(/\d+/);
      if (!numM) continue;
      const num = parseInt(numM[0], 10);
      if (body.includes("[") && body.includes("]")) {
        tags.env = num;
        const fnM = body.match(/\[\s*(\w+)\s*\(/);
        if (fnM) envFunc = fnM[1];
      }
    }
    for (let i = 1; i <= 7; i += 2) {
      const cond = m[i];
      const body = m[i + 1];
      const numM = cond.match(/\d+/);
      if (!numM) continue;
      const num = parseInt(numM[0], 10);
      if (num === tags.env) continue;
      if (body.includes("~=0") || body.includes("==0") || body.includes("not(")) {
        tags.bool = num;
      } else if (envFunc && body.includes(`${envFunc}(`)) {
        tags.str = num;
      } else {
        tags.num = num;
      }
    }
  }
  return tags;
}

export function deserialize(buf, fieldKeys, constTags) {
  const { opField, aField, bField, cField, bzField, tagField, typeField } = fieldKeys;
  function cx(b, h, x) {
    return Math.floor((b / Math.pow(2, h - 1)) % Math.pow(2, (x - 1) - (h - 1) + 1));
  }

  const candidatePerms = [
    ["params", "protos", "inst", "consts"],
    ["protos", "consts", "inst", "params"],
    ["params", "protos", "consts", "inst"],
    ["protos", "params", "inst", "consts"],
    ["protos", "inst", "params", "consts"],
    ["protos", "inst", "consts", "params"]
  ];

  for (const order of candidatePerms) {
    let cursor = 0;
    function readByte() {
      if (cursor >= buf.length) throw new Error();
      return buf.readUInt8(cursor++);
    }
    function readUInt32() {
      if (cursor + 4 > buf.length) throw new Error();
      const v = buf.readUInt32LE(cursor);
      cursor += 4;
      return v;
    }
    function readString() {
      const len = readUInt32();
      if (cursor + len > buf.length) throw new Error();
      const s = buf.subarray(cursor, cursor + len).toString("latin1");
      cursor += len;
      return s;
    }
    function readDouble() {
      if (cursor + 8 > buf.length) throw new Error();
      const v = buf.readDoubleLE(cursor);
      cursor += 8;
      return v;
    }

    const cz = [];
    try {
      function deserializeProto() {
        const patchCount = readUInt32();
        if (patchCount > 50000) throw new Error();
        for (let i = 0; i < patchCount; i++) {
          const p = {};
          const tag = readByte();
          p[tagField] = tag;
          p.tag = tag;
          const n = readUInt32();
          const l = readUInt32();
          const bExtra = readByte();
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

        let numParams = 0;
        let protos = [];
        let instructions = [];
        let constants = [];

        for (const sec of order) {
          if (sec === "params") {
            numParams = readByte();
          } else if (sec === "protos") {
            const numProtos = readUInt32();
            if (numProtos > 5000) throw new Error();
            protos = [];
            for (let i = 0; i < numProtos; i++) {
              protos.push(deserializeProto());
            }
          } else if (sec === "inst") {
            const numInst = readUInt32();
            if (numInst > 200000) throw new Error();
            instructions = [];
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
              inst[bzField] = cx(m, 12, 20);
              inst.bz = inst[bzField];
              instructions.push(inst);
            }
          } else if (sec === "consts") {
            const numConsts = readUInt32();
            if (numConsts > 50000) throw new Error();
            constants = [];
            for (let i = 1; i <= numConsts; i++) {
              const tag = readByte();
              let val;
              if (tag === constTags.bool) val = readByte() !== 0;
              else if (tag === constTags.num) val = readDouble();
              else if (tag === constTags.str || tag === constTags.env) val = readString();
              else throw new Error();
              constants[i] = val;
            }
          }
        }
        return { numParams, protos, instructions, constants };
      }

      const root = deserializeProto();
      if (cursor === buf.length) {
        return { root, cz, order };
      }
    } catch {}
  }

  throw new Error("failed to deserialize bytecode with any valid section ordering");
}
