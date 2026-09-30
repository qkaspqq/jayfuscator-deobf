export function generate(rawLua) {
  const lines = rawLua.split("\n");
  const result = [];
  let indent = 0;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("end") || trimmed.startsWith("elseif") || trimmed.startsWith("else") || trimmed.startsWith("until")) {
      indent = Math.max(0, indent - 1);
    }

    result.push("  ".repeat(indent) + trimmed);

    if (
      (trimmed.endsWith("then") ||
        trimmed.endsWith("do") ||
        trimmed.endsWith("else") ||
        trimmed.endsWith("repeat") ||
        trimmed.endsWith("function()") ||
        /\bfunction\s*\([^)]*\)$/.test(trimmed)) &&
      !trimmed.startsWith("return function")
    ) {
      indent++;
    }
  }

  return result.join("\n");
}
