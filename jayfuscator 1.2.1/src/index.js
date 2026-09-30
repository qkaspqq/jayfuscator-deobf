import fs from "fs";
import { extract } from "./extractor.js";
import { deserialize, extractFieldKeys, extractConstTags } from "./deserializer.js";
import { analyzeVm } from "./vm_analyzer.js";
import { lift } from "./lifter.js";
import { generate } from "./generator.js";

export function deobfuscate(sourceCode) {
  const { paramMap, bytecodeBuf, vmLoop } = extract(sourceCode);
  const fieldKeys = extractFieldKeys(sourceCode);
  const constTags = extractConstTags(sourceCode);
  const { mutators, opcodeMap } = analyzeVm(vmLoop, paramMap);
  const { root, cz } = deserialize(bytecodeBuf, fieldKeys, constTags);
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
