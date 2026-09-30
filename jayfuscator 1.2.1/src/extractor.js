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

  let maxHex = "";
  const hexRegex = /['"]([0-9A-Fa-f]{200,})['"]/g;
  let hm;
  while ((hm = hexRegex.exec(source)) !== null) {
    if (hm[1].length > maxHex.length) {
      maxHex = hm[1];
    }
  }
  if (!maxHex) throw new Error("failed to locate bytecode payload");

  const whileMatch = source.match(/\bwhile\s+true\s+do\b/);
  if (!whileMatch) throw new Error("failed to locate vm loop");
  const whileStart = whileMatch.index;

  const termMatch = source.slice(whileStart).match(/do\s*(\w+)\s*=\s*\(\s*\1\s*\+\s*1\s*\)\s*;\s*end\s*end/);
  let vmLoop;
  if (termMatch) {
    const whileEnd = whileStart + termMatch.index + termMatch[0].length;
    vmLoop = source.slice(whileStart, whileEnd);
  } else {
    let pos = whileStart + whileMatch[0].length;
    let blockDepth = 1;
    const kwRegex = /\b(while|for|if|function|do|then|end)\b/g;
    kwRegex.lastIndex = pos;
    let km;
    let whileEnd = -1;
    while ((km = kwRegex.exec(source)) !== null) {
      const kw = km[1];
      if (kw === "do" || kw === "then" || kw === "function") {
        blockDepth++;
      } else if (kw === "end") {
        blockDepth--;
        if (blockDepth === 0) {
          whileEnd = km.index + 3;
          break;
        }
      }
    }
    if (whileEnd === -1) throw new Error("failed to close vm loop");
    vmLoop = source.slice(whileStart, whileEnd);
  }

  return { paramMap, bytecodeHex: maxHex, vmLoop };
}
