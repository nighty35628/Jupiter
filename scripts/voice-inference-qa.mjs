import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve("output/voice-input-20261106");
const model = join(root, "models/ggml-base.bin");
const hash = createHash("sha256").update(await readFile(model)).digest("hex");
if (hash !== "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe") throw new Error("Incomplete QA model");
const fixtures = JSON.parse(await readFile(join(root, "fixtures/manifest.json"), "utf8"));
function units(text, language) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, " ").trim();
  return ["zh", "ja"].includes(language) ? [...normalized.replace(/\s/gu, "")] : normalized.split(/\s+/u).filter(Boolean);
}
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = next;
  }
  return prev[b.length];
}
const results = [];
for (const fixture of [...fixtures.cases,
  { name: "silence", language: "en", file: join(root, "fixtures/silence.wav"), text: "", noSpeech: true },
  { name: "noise", language: "en", file: join(root, "fixtures/noise.wav"), text: "", noSpeech: true },
]) {
  if (!fixture.file) { results.push(fixture); continue; }
  const name = fixture.name ?? fixture.language;
  const log = execFileSync("cargo", ["test", "--locked", "--bin", "Jupiter", "speech::tests::file_inference",
    "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"], {
    cwd: resolve("desktop/src-tauri"),
    env: { ...process.env, JUPITER_SPEECH_MODEL: model, JUPITER_SPEECH_WAV: fixture.file,
      JUPITER_SPEECH_LANGUAGE: fixture.language, JUPITER_SPEECH_REPEAT: "1" },
    encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(root, "inference-" + name + ".log"), log);
  const result = log.split("\n").flatMap(line => {
    const start = line.indexOf("{");
    if (start < 0) return [];
    try { return [JSON.parse(line.slice(start))]; } catch { return []; }
  }).find(row => row.modelSha256 === hash);
  if (!result) throw new Error("No inference receipt for " + name);
  const expected = units(fixture.text, fixture.language), actual = units(result.text, fixture.language);
  if (fixture.noSpeech && result.text.trim()) throw new Error("Hallucinated " + name + " transcript");
  const row = { ...result, name, reference: fixture.text, synthetic: true,
    metric: ["zh", "ja"].includes(fixture.language) ? "CER" : "WER",
    errorRate: expected.length ? distance(expected, actual) / expected.length : actual.length };
  results.push(row); console.log(JSON.stringify(row));
}
await writeFile(join(root, "inference-results.json"), JSON.stringify({
  procedure: "one synthetic sample per language; fresh context; CPU max four threads; development profile; not p95 or microphone acceptance",
  results,
}, null, 2));
