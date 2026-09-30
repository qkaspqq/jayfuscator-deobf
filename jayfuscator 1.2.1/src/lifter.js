export function lift(rootProto, cz, mutators, opcodeMap) {
  function resolveMutators(proto) {
    for (let pc = 0; pc < proto.instructions.length; pc++) {
      const inst = proto.instructions[pc];
      const op = inst[124];
      const mut = mutators[op];
      if (mut) {
        if (mut.type === "cz") {
          const bz = inst[144];
          Object.assign(inst, cz[bz]);
        } else if (mut.type === "fields") {
          Object.assign(inst, mut.fields);
        }
      }
    }
    for (const child of proto.protos) {
      resolveMutators(child);
    }
  }

  resolveMutators(rootProto);

  function formatLiteral(val) {
    if (typeof val === "string") return JSON.stringify(val);
    if (typeof val === "boolean") return val ? "true" : "false";
    if (val === null || val === undefined) return "nil";
    return String(val);
  }

  function isValidIdent(name) {
    return typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
  }

  function decompileProto(proto, depth = 0) {
    const pad = "  ".repeat(depth);
    const statements = [];
    const insts = proto.instructions;
    const consts = proto.constants;
    const R = {};

    function getK(idx) {
      return consts[idx];
    }

    function getReg(r) {
      return `v${r}`;
    }

    function getExpr(r) {
      if (R[r] !== undefined && R[r] !== null) {
        return R[r];
      }
      return { type: "reg", code: getReg(r) };
    }

    const visited = new Set();
    let pc = 1;

    while (pc >= 1 && pc <= insts.length && !visited.has(pc)) {
      visited.add(pc);
      const inst = insts[pc - 1];
      const op = inst[124];
      const a = inst[27];
      const b = inst[4];
      const c = inst[121];
      const opType = opcodeMap[op] || "UNKNOWN";

      if (opType === "JMP") {
        pc = b + 1;
        continue;
      }

      if (opType === "LOADK") {
        const val = getK(b);
        const code = formatLiteral(val);
        statements.push(`${pad}local ${getReg(a)} = ${code}`);
        R[a] = { type: "literal", value: val, code: getReg(a) };
      } else if (opType === "LOADBOOL") {
        const val = b !== 0;
        const code = val ? "true" : "false";
        statements.push(`${pad}local ${getReg(a)} = ${code}`);
        R[a] = { type: "literal", value: val, code: getReg(a) };
      } else if (opType === "LOADNIL") {
        statements.push(`${pad}local ${getReg(a)} = nil`);
        R[a] = { type: "literal", value: null, code: getReg(a) };
      } else if (opType === "MOVE") {
        const src = getExpr(b);
        statements.push(`${pad}local ${getReg(a)} = ${src.code}`);
        R[a] = { type: "reg", code: getReg(a) };
      } else if (opType === "GETGLOBAL") {
        const name = getK(b) || getK(c) || "global";
        statements.push(`${pad}local ${getReg(a)} = ${name}`);
        R[a] = { type: "global", name, code: getReg(a) };
      } else if (opType === "SETGLOBAL") {
        const name = getK(b) || getK(c) || `global_${b}`;
        const val = getExpr(a);
        statements.push(`${pad}${name} = ${val.code}`);
      } else if (opType === "GETUPVAL") {
        const name = `upval_${b}`;
        statements.push(`${pad}local ${getReg(a)} = ${name}`);
        R[a] = { type: "upval", name, code: getReg(a) };
      } else if (opType === "SETUPVAL") {
        const name = `upval_${b}`;
        const val = getExpr(a);
        statements.push(`${pad}${name} = ${val.code}`);
      } else if (opType === "GETTABLE") {
        const obj = getExpr(b);
        const key = getK(c);
        if (key !== undefined) {
          if (isValidIdent(key)) {
            statements.push(`${pad}local ${getReg(a)} = ${obj.code}.${key}`);
          } else {
            statements.push(`${pad}local ${getReg(a)} = ${obj.code}[${formatLiteral(key)}]`);
          }
        } else {
          const keyReg = getExpr(c);
          statements.push(`${pad}local ${getReg(a)} = ${obj.code}[${keyReg.code}]`);
        }
        R[a] = { type: "reg", code: getReg(a) };
      } else if (opType === "SETTABLE") {
        const target = getExpr(a);
        const key = getK(b);
        let keyStr;
        if (key !== undefined) {
          keyStr = isValidIdent(key) ? `.${key}` : `[${formatLiteral(key)}]`;
        } else {
          const kReg = getExpr(b);
          keyStr = `[${kReg.code}]`;
        }

        let valStr;
        const valK = getK(c);
        if (valK !== undefined) {
          valStr = formatLiteral(valK);
        } else {
          valStr = getExpr(c).code;
        }

        statements.push(`${pad}${target.code}${keyStr} = ${valStr}`);
      } else if (opType === "NEWTABLE") {
        statements.push(`${pad}local ${getReg(a)} = {}`);
        R[a] = { type: "table", code: getReg(a) };
      } else if (opType === "SELF") {
        const obj = getExpr(b);
        const method = getK(c);
        R[a + 1] = obj;
        R[a] = { type: "method", obj, method, code: `${obj.code}:${method}` };
      } else if (opType === "CLOSURE" || opType === "CLOSURE_UPVAL") {
        const childProto = proto.protos[b];
        const params = [];
        if (childProto && childProto.numParams > 0) {
          for (let p = 0; p < childProto.numParams; p++) {
            params.push(getReg(p));
          }
        }
        statements.push(`${pad}local ${getReg(a)} = function(${params.join(", ")})`);
        if (childProto) {
          statements.push(decompileProto(childProto, depth + 1));
        }
        statements.push(`${pad}end`);
        R[a] = { type: "closure", code: getReg(a) };
      } else if (opType === "CALL") {
        const fn = R[a];
        const isMethod = fn && fn.type === "method";
        const startArg = isMethod ? a + 2 : a + 1;
        const endArg = b === 0 ? a + 1 : b;

        const args = [];
        for (let i = startArg; i <= endArg; i++) {
          args.push(getExpr(i).code);
        }

        const fnCode = fn ? fn.code : getReg(a);
        const callExpr = `${fnCode}(${args.join(", ")})`;

        if (c === 0 || c > 1) {
          statements.push(`${pad}local ${getReg(a)} = ${callExpr}`);
          R[a] = { type: "var", code: getReg(a) };
        } else {
          statements.push(`${pad}${callExpr}`);
          R[a] = { type: "call", code: callExpr };
        }
      } else if (opType === "RETURN") {
        if (b === 1) {
          statements.push(`${pad}return`);
        } else if (b === 2) {
          statements.push(`${pad}return ${getExpr(a).code}`);
        } else if (b > 2) {
          const retArgs = [];
          for (let i = a; i < a + b - 1; i++) {
            retArgs.push(getExpr(i).code);
          }
          statements.push(`${pad}return ${retArgs.join(", ")}`);
        } else {
          const retVal = R[a];
          statements.push(`${pad}return ${retVal ? retVal.code : ""}`.trimEnd());
        }
        break;
      } else if (opType === "ADD" || opType === "SUB" || opType === "MUL" || opType === "DIV" || opType === "MOD" || opType === "POW") {
        const opSym = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%", POW: "^" }[opType];
        const left = getK(b) !== undefined ? formatLiteral(getK(b)) : getExpr(b).code;
        const right = getK(c) !== undefined ? formatLiteral(getK(c)) : getExpr(c).code;
        statements.push(`${pad}local ${getReg(a)} = (${left} ${opSym} ${right})`);
        R[a] = { type: "binary", code: getReg(a) };
      } else if (opType === "CONCAT") {
        const parts = [];
        for (let i = b; i <= c; i++) {
          parts.push(getExpr(i).code);
        }
        statements.push(`${pad}local ${getReg(a)} = ${parts.join(" .. ")}`);
        R[a] = { type: "concat", code: getReg(a) };
      } else if (opType === "NOT") {
        statements.push(`${pad}local ${getReg(a)} = not ${getExpr(b).code}`);
        R[a] = { type: "unary", code: getReg(a) };
      } else if (opType === "LEN") {
        statements.push(`${pad}local ${getReg(a)} = #${getExpr(b).code}`);
        R[a] = { type: "unary", code: getReg(a) };
      } else if (opType === "UNM") {
        statements.push(`${pad}local ${getReg(a)} = -${getExpr(b).code}`);
        R[a] = { type: "unary", code: getReg(a) };
      }

      pc++;
    }

    return statements.join("\n");
  }

  return decompileProto(rootProto, 0);
}
