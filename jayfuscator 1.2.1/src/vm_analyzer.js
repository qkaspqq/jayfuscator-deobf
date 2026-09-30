import { createRequire } from "module";
const require = createRequire(import.meta.url);
const luaparse = require("luaparse");

export function analyzeVm(vmLoopCode, paramMap) {
  let ast;
  try {
    ast = luaparse.parse(vmLoopCode, { luaVersion: "5.1", ranges: true });
  } catch (err) {
    throw new Error(`failed to parse vm loop: ${err.message}`);
  }

  const stmts = ast.body[0]?.body || ast.body;

  let instVar, instArray, pcVar;
  for (const s of stmts) {
    if (s.type === "AssignmentStatement" && s.init[0]?.type === "IndexExpression") {
      const idx = s.init[0];
      if (idx.base.type === "Identifier" && idx.index.type === "Identifier") {
        instVar = s.variables[0].name;
        instArray = idx.base.name;
        pcVar = idx.index.name;
        break;
      }
    }
  }

  const varToField = {};
  const fieldToVar = {};

  function checkAssign(v, init) {
    if (init && init.type === "IndexExpression" && init.base.type === "Identifier" && init.base.name === instVar) {
      let field = null;
      if (init.index.type === "NumericLiteral") {
        field = init.index.value;
      } else if (init.index.type === "Identifier") {
        field = paramMap[init.index.name] !== undefined ? paramMap[init.index.name] : init.index.name;
      }
      if (field !== null) {
        varToField[v.name] = field;
        fieldToVar[field] = v.name;
      }
    }
  }

  for (const s of stmts) {
    if (s.type === "AssignmentStatement") {
      checkAssign(s.variables[0], s.init[0]);
    } else if (s.type === "DoStatement") {
      for (const sub of s.body) {
        if (sub.type === "AssignmentStatement") {
          checkAssign(sub.variables[0], sub.init[0]);
        }
      }
    }
  }

  const ifStmt = stmts.find(s => s.type === "IfStatement");
  if (!ifStmt) throw new Error("no dispatch table found in vm loop");

  function getConditionVar(node) {
    if (!node) return null;
    if (node.type === "UnaryExpression") return getConditionVar(node.argument);
    if (node.type === "BinaryExpression") {
      if (node.left.type === "Identifier") return node.left.name;
      if (node.right.type === "Identifier") return node.right.name;
      return getConditionVar(node.left) || getConditionVar(node.right);
    }
    return null;
  }

  const opVar = getConditionVar(ifStmt.clauses[0].condition);
  const opField = varToField[opVar];

  function evalNode(node, opVal) {
    if (!node) return null;
    if (node.type === "Identifier") {
      if (node.name === opVar) return opVal;
      if (paramMap[node.name] !== undefined) return paramMap[node.name];
    }
    if (node.type === "IndexExpression") {
      if (node.base.type === "Identifier" && node.base.name === instVar) {
        const idx = evalNode(node.index, opVal);
        if (idx === opField || idx === opVar) return opVal;
      }
    }
    if (node.type === "NumericLiteral") return node.value;
    return null;
  }

  function evalCondition(node, opVal) {
    if (node.type === "UnaryExpression" && node.operator === "not") {
      const inner = evalCondition(node.argument, opVal);
      return inner === null ? null : !inner;
    }
    if (node.type === "BinaryExpression") {
      const l = evalNode(node.left, opVal);
      const r = evalNode(node.right, opVal);
      if (l === null || r === null) return null;
      switch (node.operator) {
        case ">": return l > r;
        case "<": return l < r;
        case ">=": return l >= r;
        case "<=": return l <= r;
        case "==": return l == r;
        case "~=": return l != r;
        default: return null;
      }
    }
    return null;
  }

  function findHandler(stmtsList, opVal) {
    for (const s of stmtsList) {
      if (s.type === "IfStatement") {
        let handled = false;
        for (const clause of s.clauses) {
          if (clause.type === "IfClause" || clause.type === "ElseifClause") {
            const res = evalCondition(clause.condition, opVal);
            if (res === true) {
              handled = true;
              return findHandler(clause.body, opVal);
            } else if (res === null) {
              return vmLoopCode.slice(s.range[0], s.range[1]);
            }
          } else if (clause.type === "ElseClause") {
            if (!handled) {
              return findHandler(clause.body, opVal);
            }
          }
        }
      } else if (s.type === "DoStatement") {
        return findHandler(s.body, opVal);
      } else {
        return vmLoopCode.slice(s.range[0], stmtsList[stmtsList.length - 1].range[1]);
      }
    }
    return null;
  }

  const opcodeHandlers = {};
  for (let op = 0; op <= 150; op++) {
    const h = findHandler([ifStmt], op);
    if (h) opcodeHandlers[op] = h.trim();
  }

  function evalExpr(expr, op) {
    let s = String(expr).replace(new RegExp(`\\b${opVar}\\b`, "g"), String(op));
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
    const norm = handler.replace(/\s+/g, "");

    const mutatorPrefix = `${instArray}[${pcVar}]=`;
    if (norm.includes(mutatorPrefix)) {
      const after = norm.slice(norm.indexOf(mutatorPrefix) + mutatorPrefix.length);
      if (after.startsWith("{")) {
        const match = norm.match(new RegExp(`${instArray}\\[${pcVar}\\]=\\{([^}]+)\\}`));
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
      } else {
        mutators[op] = { type: "cz" };
        continue;
      }
    }

    let type = "UNKNOWN";
    if (norm.startsWith(`${pcVar}=`)) type = "JMP";
    else if (norm.startsWith("return")) type = "RETURN";
    else if (norm.includes("by(") || norm.includes("bu({}") || norm.includes("bu(")) type = "CLOSURE";
    else if (norm.includes("={}") || norm.endsWith("={}")) type = "NEWTABLE";
    else if (norm.includes("=nil") || norm.endsWith("=nil")) type = "LOADNIL";
    else if (norm.includes("0~=") || norm.includes("0==")) type = "LOADBOOL";
    else if (norm.includes("=-") && !norm.includes("--")) type = "UNM";
    else if (norm.includes("=(not")) type = "NOT";
    else if (norm.includes("=#")) type = "LEN";
    else if (norm.includes("..")) type = "CONCAT";
    else if (norm.includes("+")) type = "ADD";
    else if (norm.includes("-") && !norm.includes("--")) type = "SUB";
    else if (norm.includes("*")) type = "MUL";
    else if (norm.includes("/")) type = "DIV";
    else if (norm.includes("%")) type = "MOD";
    else if (norm.includes("^")) type = "POW";
    else if (norm.includes("()") || norm.includes("(bx(") || norm.includes("ch(")) type = "CALL";
    else if (norm.includes("<")) type = "JMP_LT";
    else if (norm.includes(">")) type = "JMP_GT";
    else if (norm.includes("==")) type = "JMP_EQ";
    else if (norm.includes("~=")) type = "JMP_NE";
    else if (norm.includes("for") && norm.includes("do") && norm.includes(pcVar)) type = "FORLOOP";
    else if (norm.includes("for") && norm.includes("do")) type = "FORPREP";
    else if (norm.includes("ifnot") && norm.includes(pcVar)) type = "TEST";
    else if (norm.includes("if") && norm.includes(pcVar)) type = "TESTSET";
    else if (norm.includes("x[") && norm.includes("]=")) type = "SETUPVAL";
    else if (norm.includes("=x[")) type = "GETUPVAL";
    else if (norm.includes("db[") && norm.includes("]=")) type = "SETGLOBAL";
    else if (norm.includes("=db[")) type = "GETGLOBAL";
    else if (norm.includes("[") && norm.includes("][") && norm.includes("]=")) type = "SETTABLE";
    else if (norm.includes("][")) type = "GETTABLE";
    else if (norm.includes("=bc[")) type = "LOADK";
    else if (norm.includes("cb[") && norm.includes("=cb[")) type = "MOVE";

    opcodeMap[op] = type;
  }

  const fieldKeys = {
    opField: opField || 124,
    aField: varToField["ck"] || 27,
    bField: varToField["cj"] || 121,
    cField: varToField["bs"] || 4,
    bzField: varToField["cg"] || 32,
    bExtraField: varToField["bz"] || 144,
    tagField: varToField["cn"] || 51,
    typeField: 159
  };

  return { opcodeHandlers, mutators, opcodeMap, fieldKeys };
}
