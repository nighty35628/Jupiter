// Synthetic, nonpersonal fixtures. Does not open a microphone or contact an ASR API.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

if (process.platform !== "darwin") throw new Error("Fixture generation uses installed macOS voices");
const output = resolve(process.argv[2] ?? "output/voice-input-20261106/fixtures");
await mkdir(output, { recursive: true });
const voices = execFileSync("say", ["-v", "?"], { encoding: "utf8" }).split("\n")
  .map(line => /^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s+#/.exec(line)).filter(Boolean)
  .map(match => ({ name: match[1].trim(), locale: match[2] }));
const cases = [
  ["en", "en_US", "Please check the project files and run the tests."],
  ["zh", "zh_CN", "请检查项目文件，然后运行测试。"],
  ["ja", "ja_JP", "プロジェクトのファイルを確認して、テストを実行してください。"],
  ["ko", "ko_KR", "프로젝트 파일을 확인하고 테스트를 실행해 주세요."],
  ["de", "de_DE", "Bitte prüfen Sie die Projektdateien und führen Sie die Tests aus."],
  ["fr", "fr_FR", "Vérifiez les fichiers du projet et lancez les tests."],
  ["es", "es_ES", "Revisa los archivos del proyecto y ejecuta las pruebas."],
  ["ru", "ru_RU", "Проверьте файлы проекта и запустите тесты."],
];
const results = [];
const preferred = { en: "Samantha", zh: "Tingting", ja: "Kyoko", ko: "Yuna", de: "Anna", fr: "Thomas", es: "Monica", ru: "Milena" };
for (const [language, locale, text] of cases) {
  const voice = voices.find(item => item.locale === locale && item.name === preferred[language])
    ?? voices.find(item => item.locale === locale);
  if (!voice) { results.push({ language, text, skipped: "No installed voice" }); continue; }
  const aiff = join(output, language + ".aiff"), wav = join(output, language + ".wav");
  execFileSync("say", ["-v", voice.name, "-o", aiff, text], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "pipe" });
  results.push({ language, text, voice: voice.name, file: wav });
}
for (const [name, language, voice, text] of [
  ["identifiers", "en", "Samantha", "Open src slash main dot t s and run n p m test."],
  ["mixed", "auto", "Tingting", "请检查 README，然后运行 npm test。"],
]) {
  const aiff = join(output, name + ".aiff"), wav = join(output, name + ".wav");
  execFileSync("say", ["-v", voice, "-o", aiff, text], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "pipe" });
  results.push({ name, language, text, voice, file: wav });
}
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", "-c:a", "pcm_s16le", join(output, "silence.wav")], { stdio: "pipe" });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=r=16000:a=0.003:seed=42", "-t", "3", "-c:a", "pcm_s16le", join(output, "noise.wav")], { stdio: "pipe" });
await writeFile(join(output, "manifest.json"), JSON.stringify({ synthetic: true, sampleRate: 16000, channels: 1, cases: results }, null, 2));
console.log(JSON.stringify({ output, generated: results.filter(item => item.file).length }));
