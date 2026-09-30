import { createRequire } from "module";
const require = createRequire(import.meta.url);
const luaparse = require("luaparse");

export function analyzeVm(vmLoopCode, paramMap) {
  let cleaned = vmLoopCode;
  const ccIdx = cleaned.indexOf("do cc=(cc+1);end");
  if (ccIdx !== -1) cleaned = cleaned.slice(0, ccIdx);
  const startIdx = cleaned.indexOf("if not(");
  if (startIdx !== -1) cleaned = cleaned.slice(startIdx);
  cleaned = cleaned.replace(/cd\[124\]/g, " ci ");

  const wrapped = "function test(...) " + cleaned + "\nend";
  let ast;
  try {
    ast = luaparse.parse(wrapped, { luaVersion: "5.1", ranges: true });
  } catch (err) {
    throw new Error(`Failed to parse VM loop: ${err.message}`);
  }

  const fnBody = ast.body[0].body;

  function evalVal(node, ciVal) {
    if (!node) return null;
    if (node.type === "Identifier") {
      if (node.name === "ci") return ciVal;
      if (paramMap[node.name] !== undefined) return paramMap[node.name];
    }
    if (node.type === "NumericLiteral") return node.value;
    return null;
  }

  function evalCond(node, ciVal) {
    if (node.type === "UnaryExpression" && node.operator === "not") {
      const inner = evalCond(node.argument, ciVal);
      return inner === null ? null : !inner;
    }
    if (node.type === "BinaryExpression") {
      const lVal = evalVal(node.left, ciVal);
      const rVal = evalVal(node.right, ciVal);
      if (lVal === null || rVal === null) return null;
      switch (node.operator) {
        case ">": return lVal > rVal;
        case "<": return lVal < rVal;
        case ">=": return lVal >= rVal;
        case "<=": return lVal <= rVal;
        case "==": return lVal == rVal;
        case "~=": return lVal != rVal;
        default: return null;
      }
    }
    return null;
  }

  function findHandler(stmts, ciVal) {
    for (const stmt of stmts) {
      if (stmt.type === "IfStatement") {
        let handled = false;
        for (const clause of stmt.clauses) {
          if (clause.type === "IfClause" || clause.type === "ElseifClause") {
            const res = evalCond(clause.condition, ciVal);
            if (res === true) {
              handled = true;
              return findHandler(clause.body, ciVal);
            } else if (res === null) {
              return wrapped.slice(stmt.range[0], stmt.range[1]);
            }
          } else if (clause.type === "ElseClause") {
            if (!handled) {
              return findHandler(clause.body, ciVal);
            }
          }
        }
      } else if (stmt.type === "DoStatement") {
        return findHandler(stmt.body, ciVal);
      } else {
        return wrapped.slice(stmt.range[0], stmts[stmts.length - 1].range[1]);
      }
    }
    return null;
  }

  const opcodeHandlers = {};
  for (let op = 0; op <= 150; op++) {
    const handler = findHandler(fnBody, op);
    if (handler) {
      opcodeHandlers[op] = handler.trim();
    }
  }

  function evalExpr(expr, op) {
    let s = String(expr).replace(/\bci\b/g, String(op)).replace(/cd\[124\]/g, String(op));
    for (const [k, v] of Object.entries(paramMap)) {
      s = s.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
    }
    try {
      return (new Function(`"use strict"; return (${s})`))();
    } catch {
      return expr;
    }
  }

  const mutators = {};
  const opcodeMap = {};

  for (const [opStr, handler] of Object.entries(opcodeHandlers)) {
    const op = Number(opStr);
    const norm = handler.replace(/\s+/g, " ");

    if (norm.includes("bh[cc]=cz[bz]")) {
      mutators[op] = { type: "cz" };
      continue;
    }

    if (norm.includes("bh[cc]={")) {
      const match = norm.match(/bh\[cc\]=\{([^}]+)\}/);
      if (match) {
        const fields = {};
        const pairs = match[1].split(",");
        for (const pair of pairs) {
          const [k, v] = pair.split("=").map(s => s.trim());
          if (!k || !v) continue;
          let kNum;
          if (k.startsWith("[") && k.endsWith("]")) {
            kNum = evalExpr(k.slice(1, -1), op);
          } else {
            kNum = evalExpr(k, op);
          }
          fields[kNum] = evalExpr(v, op);
        }
        mutators[op] = { type: "fields", fields };
        continue;
      }
    }

    let type = "UNKNOWN";
    if (norm.startsWith("cc=bs")) type = "JMP";
    else if (norm.startsWith("return cb[cd[27]]") || norm.startsWith("return cb[ck]()") || norm.includes("return bx(cb")) type = "RETURN";
    else if (norm.includes("by(bb[cd[4]]") || norm.includes("by(bb[cg]") || norm.includes("by(bb[cd[32]]")) type = "CLOSURE";
    else if (norm.includes("bu({}") || norm.includes("cd[90]")) type = "CLOSURE_UPVAL";
    else if (norm.includes("db[cd[p]]") || norm.includes("db[cd[32]]")) type = "GETGLOBAL";
    else if (norm.includes("db[ck]=cb") || norm.includes("db[ck]=db")) type = "SETGLOBAL";
    else if (norm.includes("x[bc[bs]]=cb[ck]")) type = "SETUPVAL";
    else if (norm.includes("cb[cd[27]]=x[bc[bs]]") || norm.includes("cb[ck]=x[bc[bs]]")) type = "GETUPVAL";
    else if (norm.includes("cb[ck]={}") || norm.includes("db[ck]={}")) type = "NEWTABLE";
    else if (norm.includes("cb[(g+1)]=b;cb[g]=b[bc[cj]]") || norm.includes("cb[(g+1)]=c;cb[b]=c[cb[cj]]")) type = "SELF";
    else if (norm.includes("cb[ck]=cb[bs][bc[cj]]") || norm.includes("cb[ck]=cb[bs][cb[cj]]")) type = "GETTABLE";
    else if (norm.includes("cb[ck][bc[bs]]=bc[cj]") || norm.includes("cb[ck][bc[bs]]=cb[cd[121]]") || norm.includes("cb[ck][cb[cd[4]]]=cb[cj]")) type = "SETTABLE";
    else if (norm.includes("cb[cd[27]]=bc[bs]")) type = "LOADK";
    else if (norm.includes("cb[ck]=cb[bs]")) type = "MOVE";
    else if (norm.includes("cb[ck]=nil")) type = "LOADNIL";
    else if (norm.includes("cb[ck]=(0~=bs)")) type = "LOADBOOL";
    else if (norm.includes("cb[ck]=-cb[bs]")) type = "UNM";
    else if (norm.includes("cb[ck]=(not cb[bs])")) type = "NOT";
    else if (norm.includes("#cb[bs]")) type = "LEN";
    else if (norm.includes("+cb[cj]") || norm.includes("+bc[cj]")) type = "ADD";
    else if (norm.includes("-cb[cj]")) type = "SUB";
    else if (norm.includes("*cb[cj]") || norm.includes("*bc[cj]")) type = "MUL";
    else if (norm.includes("/cb[cj]") || norm.includes("/bc[cj]")) type = "DIV";
    else if (norm.includes("%cb[cj]") || norm.includes("%bc[cj]")) type = "MOD";
    else if (norm.includes("^cb[cj]")) type = "POW";
    else if (norm.includes("..cb[k]")) type = "CONCAT";
    else if (norm.includes("cb[ck]()") || norm.includes("cb[b](bx(") || norm.includes("ch(cb[b](") || norm.includes("cb[a](bx(") || norm.includes("cb[a]()") || norm.includes("cb[b](cb[")) type = "CALL";
    else if (norm.includes("<cb[cj]") || norm.includes("<bc[cj]")) type = "JMP_LT";
    else if (norm.includes(">cb[cj]")) type = "JMP_GT";
    else if (norm.includes("==bc[cj]") || norm.includes("==cb[cj]")) type = "JMP_EQ";
    else if (norm.includes("~=bc[cj]") || norm.includes("~=cb[cj]")) type = "JMP_NE";
    else if (norm.includes("if not cb[ck]then cc=bs")) type = "TEST";
    else if (norm.includes("if not cb[cd[121]]then")) type = "TESTSET";
    else if (norm.includes("ch(...)")) type = "VARARG";
    else if (norm.includes("cb[(k+2)]") || norm.includes("cb[(g+2)]")) type = "FORLOOP";
    else if (norm.includes("for b=cd[27],bs do")) type = "FORPREP";
    else if (norm.includes("o=ck k=cj b=(o+2)")) type = "TFORLOOP";
    else if (norm.includes("#bp>0") || norm.includes("local b,g b=ck g={}do for k=1,#bp")) type = "CLOSE";

    opcodeMap[op] = type;
  }

  return { opcodeHandlers, mutators, opcodeMap };
}
