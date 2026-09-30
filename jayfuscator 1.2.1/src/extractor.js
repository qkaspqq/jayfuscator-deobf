import { createRequire } from "module";
const require = createRequire(import.meta.url);
const luaparse = require("luaparse");

export function extract(source) {
  const paramMatch = source.match(/return\s*\(\s*function\s*\(([^)]+)\)/) ||
                     source.match(/function\s*\(([^)]+)\)/);
  if (!paramMatch) throw new Error("failed to find wrapper params");
  const paramNames = paramMatch[1].split(",").map(s => s.trim());

  let endIdx = source.length - 1;
  while (endIdx >= 0 && source[endIdx] !== ')') endIdx--;
  if (endIdx === -1) throw new Error("failed to find wrapper call end");

  let depth = 1;
  let startIdx = endIdx - 1;
  while (startIdx >= 0 && depth > 0) {
    if (source[startIdx] === ')') depth++;
    else if (source[startIdx] === '(') depth--;
    if (depth === 0) break;
    startIdx--;
  }
  if (depth !== 0) throw new Error("unmatched wrapper arguments");

  const rawArgs = source.slice(startIdx + 1, endIdx).replace(/\bnil\b/g, "null");
  let argValues;
  try {
    argValues = (new Function(`"use strict"; return [${rawArgs}]`))();
  } catch (e) {
    throw new Error(`failed to parse wrapper arguments: ${e.message}`);
  }

  const paramMap = {};
  for (let i = 0; i < paramNames.length; i++) {
    paramMap[paramNames[i]] = argValues[i];
  }

  let bytecodeBuf = null;
  let maxHex = "";
  const hexRegex = /['"]([0-9A-Fa-f]{200,})['"]/g;
  let hm;
  while ((hm = hexRegex.exec(source)) !== null) {
    if (hm[1].length > maxHex.length) {
      maxHex = hm[1];
    }
  }
  if (maxHex) {
    bytecodeBuf = Buffer.from(maxHex, "hex");
  } else {
    const b64Regex = /['"]([A-Za-z0-9+/=]{100,})['"]/g;
    let bm;
    while ((bm = b64Regex.exec(source)) !== null) {
      const raw = bm[1];
      try {
        const b64 = Buffer.from(raw, "base64");
        const out = [];
        let i = 0;
        let valid = true;
        while (i < b64.length) {
          const b = b64[i++];
          if (b === 255) {
            if (i >= b64.length) { valid = false; break; }
            const count = b64[i++];
            if (count === 0) {
              out.push(255);
            } else {
              if (i >= b64.length) { valid = false; break; }
              const val = b64[i++];
              for (let c = 0; c < count; c++) out.push(val);
            }
          } else {
            out.push(b);
          }
        }
        if (valid && out.length > 50) {
          bytecodeBuf = Buffer.from(out);
          break;
        }
      } catch {}
    }
  }
  if (!bytecodeBuf) throw new Error("failed to locate bytecode payload");

  const whileMatch = source.match(/\bwhile\s+true\s+do\b/);
  if (!whileMatch) throw new Error("failed to locate vm loop");
  const whileStart = whileMatch.index;

  let pos = whileStart + whileMatch[0].length;
  let endPos = source.indexOf("end", pos);
  let vmLoop = null;
  while (endPos !== -1) {
    const candidate = source.slice(whileStart, endPos + 3);
    try {
      const ast = luaparse.parse(candidate, { luaVersion: "5.1" });
      const whileStmt = ast.body[0];
      if (whileStmt && whileStmt.type === "WhileStatement") {
        const body = whileStmt.body;
        let lastStmt = body[body.length - 1];
        if (lastStmt.type === "DoStatement") lastStmt = lastStmt.body[lastStmt.body.length - 1];
        if (lastStmt.type === "AssignmentStatement") {
          vmLoop = candidate;
          break;
        }
      }
    } catch {}
    endPos = source.indexOf("end", endPos + 3);
  }

  if (!vmLoop) throw new Error("failed to extract valid vm loop ast");

  return { paramMap, bytecodeBuf, vmLoop };
}
