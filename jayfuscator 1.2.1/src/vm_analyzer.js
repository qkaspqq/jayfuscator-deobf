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
      for (let i = 0; i < s.variables.length; i++) {
        checkAssign(s.variables[i], s.init[i]);
      }
    } else if (s.type === "DoStatement") {
      for (const sub of s.body) {
        if (sub.type === "AssignmentStatement") {
          for (let i = 0; i < sub.variables.length; i++) {
            checkAssign(sub.variables[i], sub.init[i]);
          }
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
  }

  const regVar = vmLoopCode.includes("cb[") ? "cb" : "r";
  const constVar = vmLoopCode.includes("bc[") ? "bc" : "j";
  const envVar = vmLoopCode.includes("db[") ? "db" : (vmLoopCode.includes("f[") ? "f" : "db");
  const upvalVar = vmLoopCode.includes("x[") ? "x" : "c";
  const protoVar = vmLoopCode.includes("bb[") ? "bb" : "i";
  const vmRunnerName = vmLoopCode.includes("bu(") ? "bu" : "bj";

  const opcodeMap = {};
  for (const [opStr, handler] of Object.entries(opcodeHandlers)) {
    const op = Number(opStr);
    const norm = handler.replace(/\s+/g, "");

    if (norm.startsWith(`${pcVar}=`)) {
      opcodeMap[op] = { type: "JMP" };
      continue;
    }
    if (norm.startsWith("return")) {
      opcodeMap[op] = { type: "RETURN" };
      continue;
    }

    if (norm.includes("(") && norm.includes(")")) {
      if (vmRunnerName && norm.includes(`${vmRunnerName}(`)) {
        opcodeMap[op] = { type: "CLOSURE" };
        continue;
      }
      if (norm.includes(`${regVar}[`) && (norm.includes(`](${regVar}[`) || norm.includes(`]())`) || norm.includes(`]()`) || norm.includes("bn(") || norm.includes("x("))) {
        opcodeMap[op] = { type: "CALL" };
        continue;
      }
    }

    if (norm.includes(`${regVar}[`) && (norm.includes("={}") || norm.endsWith("={}"))) {
      opcodeMap[op] = { type: "NEWTABLE" };
      continue;
    }
    if (norm.includes("=nil") || norm.endsWith("=nil")) {
      opcodeMap[op] = { type: "LOADNIL" };
      continue;
    }
    if (norm.includes("0~=") || norm.includes("0==") || norm.includes("~=0")) {
      opcodeMap[op] = { type: "LOADBOOL" };
      continue;
    }

    if (norm.includes("][") && norm.indexOf("][") < norm.indexOf("=")) {
      opcodeMap[op] = {
        type: "SETTABLE",
        keyIsK: constVar ? norm.includes(`[${constVar}[`) : false,
        valIsK: constVar ? norm.includes(`=${constVar}[`) : false
      };
      continue;
    }
    if (norm.includes("][") && norm.indexOf("][") > norm.indexOf("=")) {
      opcodeMap[op] = {
        type: "GETTABLE",
        keyIsK: constVar ? norm.includes(`[${constVar}[`) : false
      };
      continue;
    }
    if (constVar && norm.includes(`[${constVar}[`)) {
      if (norm.indexOf(`[${constVar}[`) < norm.indexOf("=")) {
        opcodeMap[op] = {
          type: "SETTABLE",
          keyIsK: true,
          valIsK: norm.includes(`=${constVar}[`)
        };
      } else {
        opcodeMap[op] = {
          type: "GETTABLE",
          keyIsK: true
        };
      }
      continue;
    }

    if (envVar && norm.includes(`=${envVar}[`)) {
      opcodeMap[op] = { type: "GETGLOBAL" };
      continue;
    }
    if (envVar && norm.includes(`${envVar}[`) && norm.includes("]=")) {
      opcodeMap[op] = { type: "SETGLOBAL" };
      continue;
    }

    if (upvalVar && norm.includes(`=${upvalVar}[`)) {
      opcodeMap[op] = { type: "GETUPVAL" };
      continue;
    }
    if (upvalVar && norm.includes(`${upvalVar}[`) && norm.includes("]=")) {
      opcodeMap[op] = { type: "SETUPVAL" };
      continue;
    }

    if (constVar && norm.includes(`=${constVar}[`)) {
      opcodeMap[op] = { type: "LOADK" };
      continue;
    }

    if (regVar && new RegExp(`^${regVar}\\[[^\\]]+\\]=${regVar}\\[[^\\]]+\\]$`).test(norm)) {
      opcodeMap[op] = { type: "MOVE" };
      continue;
    }

    if (protoVar && norm.includes(`${protoVar}[`)) {
      opcodeMap[op] = { type: "CLOSURE" };
      continue;
    }

    if (norm.includes("=-") && !norm.includes("--")) {
      opcodeMap[op] = { type: "UNM" };
      continue;
    }
    if (norm.includes("=(not") || norm.includes("=not")) {
      opcodeMap[op] = { type: "NOT" };
      continue;
    }
    if (norm.includes("=#")) {
      opcodeMap[op] = { type: "LEN" };
      continue;
    }

    if (norm.includes("..")) {
      opcodeMap[op] = { type: "CONCAT" };
      continue;
    }
    if (norm.includes("+")) {
      opcodeMap[op] = { type: "ADD", rightIsK: constVar ? norm.includes(`+${constVar}[`) : false };
      continue;
    }
    if (norm.includes("-") && !norm.includes("--")) {
      opcodeMap[op] = { type: "SUB", rightIsK: constVar ? norm.includes(`-${constVar}[`) : false };
      continue;
    }
    if (norm.includes("*")) {
      opcodeMap[op] = { type: "MUL", rightIsK: constVar ? norm.includes(`*${constVar}[`) : false };
      continue;
    }
    if (norm.includes("/")) {
      opcodeMap[op] = { type: "DIV", rightIsK: constVar ? norm.includes(`/${constVar}[`) : false };
      continue;
    }
    if (norm.includes("%")) {
      opcodeMap[op] = { type: "MOD", rightIsK: constVar ? norm.includes(`%${constVar}[`) : false };
      continue;
    }
    if (norm.includes("^")) {
      opcodeMap[op] = { type: "POW", rightIsK: constVar ? norm.includes(`^${constVar}[`) : false };
      continue;
    }

    if (norm.includes("<") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "JMP_LT" };
      continue;
    }
    if (norm.includes(">") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "JMP_GT" };
      continue;
    }
    if (norm.includes("==") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "JMP_EQ" };
      continue;
    }
    if (norm.includes("~=") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "JMP_NE" };
      continue;
    }
    if (norm.includes("for") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "FORLOOP" };
      continue;
    }
    if (norm.includes("ifnot") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "TEST" };
      continue;
    }
    if (norm.includes("if") && norm.includes(pcVar)) {
      opcodeMap[op] = { type: "TESTSET" };
      continue;
    }

    opcodeMap[op] = { type: "UNKNOWN" };
  }

  return { opcodeHandlers, mutators, opcodeMap };
}
