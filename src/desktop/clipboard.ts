import { spawn } from "node:child_process";

interface ClipboardCommand {
  command: string;
  args: string[];
}

function pipeToCommand(spec: ClipboardCommand, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.on("error", fail);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 2048) stderr += chunk;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`${spec.command} exited with ${code}: ${stderr.trim()}`));
    });
    child.stdin?.on("error", fail);
    child.stdin?.end(value, "utf8");
  });
}

export async function writeClipboardText(value: string): Promise<void> {
  if (process.platform === "darwin") {
    await pipeToCommand({ command: "pbcopy", args: [] }, value);
    return;
  }
  if (process.platform === "win32") {
    await pipeToCommand(
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $value=[Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
        ],
      },
      value,
    );
    return;
  }

  const candidates: ClipboardCommand[] = [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await pipeToCommand(candidate, value);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No supported clipboard command is available");
}
