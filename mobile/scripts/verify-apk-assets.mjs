import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const apk = resolve(process.argv[2] ?? 'mobile/android/app/build/outputs/apk/release/app-release.apk');
const runtime = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? 'output/android-local-20261101', 'runtime/assets');
for (const [asset, manifestName, field] of [
  ['rootfs.bundle', 'runtime-manifest.json', 'rootfs'],
  ['engine.bundle', 'engine-manifest.json', null],
]) {
  const manifest = JSON.parse(await readFile(resolve(runtime, manifestName), 'utf8'));
  const expected = field ? manifest[field] : manifest;
  const digest = createHash('sha256');
  let bytes = 0;
  await new Promise((done, reject) => {
    const child = spawn('unzip', ['-p', apk, `assets/${asset}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { digest.update(chunk); bytes += chunk.length; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done() : reject(new Error(`APK is missing ${asset}`)));
  });
  if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) throw new Error(`APK changed ${asset}`);
  console.log(`${asset}: packaged bytes and SHA-256 verified`);
}
