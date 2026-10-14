import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function copyManual({
  packageRoot = join(dirname(fileURLToPath(import.meta.url)), ".."),
  outputDir = join(packageRoot, "dist/manual"),
} = {}) {
  const source = join(packageRoot, "resources/manual");
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  mkdirSync(outputDir, { recursive: true });
  for (const chapter of manifest.chapters) {
    if (!/^[a-z][a-z-]*$/.test(chapter.id)) throw new Error("Invalid manual chapter id");
    writeFileSync(
      join(outputDir, `${chapter.id}.md`),
      readFileSync(join(source, `${chapter.id}.md`)),
    );
  }
  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) copyManual();
