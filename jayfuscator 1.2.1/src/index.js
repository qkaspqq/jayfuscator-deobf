import fs from "fs";
import { extract } from "./extractor.js";
import { deserialize } from "./deserializer.js";
import { analyzeVm } from "./vm_analyzer.js";
import { lift } from "./lifter.js";
import { generate } from "./generator.js";

export function deobfuscate(sourceCode) {
  const { paramMap, bytecodeHex, vmLoop } = extract(sourceCode);
  const { mutators, opcodeMap, fieldKeys } = analyzeVm(vmLoop, paramMap);
  const { root, cz } = deserialize(bytecodeHex, fieldKeys);
  const rawCode = lift(root, cz, mutators, opcodeMap, fieldKeys);
  return generate(rawCode);
}

const args = process.argv.slice(2);
if (args.length > 0) {
  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace(/\.lua$/, ".deobf.lua");
  try {
    const code = fs.readFileSync(inputPath, "utf8");
    const output = deobfuscate(code);
    fs.writeFileSync(outputPath, output, "utf8");
    console.log(`Decompiled successfully -> ${outputPath}`);
  } catch (err) {
    console.error("Jayfuscator decompile error:", err.message);
    process.exit(1);
  }
}
