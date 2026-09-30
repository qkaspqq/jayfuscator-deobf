import fs from "fs";
import { extract } from "./extractor.js";
import { deserialize } from "./deserializer.js";
import { analyzeVm } from "./vm_analyzer.js";
import { lift } from "./lifter.js";
import { generate } from "./generator.js";

export function deobfuscate(sourceCode) {
  const { paramMap, bytecodeHex, vmLoop } = extract(sourceCode);
  const { root, cz } = deserialize(bytecodeHex);
  const { mutators, opcodeMap } = analyzeVm(vmLoop, paramMap);
  const rawCode = lift(root, cz, mutators, opcodeMap);
  return generate(rawCode);
}

const args = process.argv.slice(2);
if (args.length > 0) {
  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace(/\.lua$/, ".deobf.lua");
  const code = fs.readFileSync(inputPath, "utf8");
  const output = deobfuscate(code);
  fs.writeFileSync(outputPath, output, "utf8");
}
