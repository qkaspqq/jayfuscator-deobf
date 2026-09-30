export function extract(source) {
  const paramMatch = source.match(/return\s*\(\s*function\s*\(([^)]+)\)/);
  if (!paramMatch) throw new Error("Failed to find wrapper parameters");
  const paramNames = paramMatch[1].split(",").map(s => s.trim());

  const endMatch = source.match(/\)\s*\(([^)]+)\)\s*;?\s*$/);
  if (!endMatch) throw new Error("Failed to find wrapper arguments");
  const rawArgs = endMatch[1].replace(/\bnil\b/g, "null");
  const argValues = (new Function(`"use strict"; return [${rawArgs}]`))();

  const paramMap = {};
  for (let i = 0; i < paramNames.length; i++) {
    paramMap[paramNames[i]] = argValues[i];
  }

  const hexMatch = source.match(/bw\s*=\s*cs\s*\(\s*['"]([0-9A-Fa-f]+)['"]\s*\)/) 
    || source.match(/['"]([0-9A-Fa-f]{100,})['"]/);
  if (!hexMatch) throw new Error("Failed to find bytecode payload");
  const bytecodeHex = hexMatch[1];

  const whileIdx = source.indexOf("while true do");
  if (whileIdx === -1) throw new Error("Failed to find VM loop");
  const byEnd = source.indexOf("do cc=(cc+1);end end;end;end end", whileIdx);
  const vmLoop = source.slice(whileIdx, byEnd !== -1 ? byEnd + 40 : source.length);

  return { paramMap, bytecodeHex, vmLoop };
}
