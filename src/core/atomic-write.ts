import { chmodSync, copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface AtomicWriteFs {
  writeFileSync: typeof writeFileSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
}

const defaultFs: AtomicWriteFs = {
  writeFileSync,
  chmodSync,
  renameSync,
  copyFileSync,
  unlinkSync,
};

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const MAX_TRANSIENT_RENAME_ATTEMPTS = 5;

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithTransientRetry(fs: AtomicWriteFs, tmp: string, path: string): void {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, path);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === MAX_TRANSIENT_RENAME_ATTEMPTS) throw err;
      sleepSync(Math.min(80, 10 * attempt));
    }
  }
  throw lastErr;
}

/** Atomic write with EXDEV fallback — Windows OneDrive / reparse points refuse rename, fixes #1738. */
export function atomicWriteSync(
  path: string,
  body: string,
  tmp: string,
  mode = 0o600,
  fs: AtomicWriteFs = defaultFs,
): void {
  try {
    fs.writeFileSync(tmp, body, "utf8");
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* platform without chmod */
    }
    try {
      fs.renameSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
        if (isTransientRenameError(err)) {
          renameWithTransientRetry(fs, tmp, path);
          return;
        }
        throw err;
      }
      fs.copyFileSync(tmp, path);
      try {
        fs.chmodSync(path, mode);
      } catch {
        /* platform without chmod */
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp may already be gone or never existed */
    }
    throw err;
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* rename consumed it on the happy path; only present after EXDEV fallback */
  }
}
