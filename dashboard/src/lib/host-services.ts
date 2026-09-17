export const WEB_HOST_COMMANDS = [
  "git_info",
  "git_status",
  "git_diff",
  "git_checkout_branch",
  "git_commit_all",
  "git_push",
  "git_create_pull_request",
  "read_file_preview",
  "read_file_bytes",
  "desktop_diagnostic_event",
] as const;

export type WebHostCommand = (typeof WEB_HOST_COMMANDS)[number];

export interface HostServices {
  supports(command: string): command is WebHostCommand;
  invoke<T>(command: WebHostCommand, args: Record<string, unknown>): Promise<T>;
}

type WebHostServicesOptions = {
  ensureReady(): Promise<void>;
  getRequestHeaders(): Record<string, string>;
  onInactiveController(): void;
  normalizeArgs(command: WebHostCommand, args: Record<string, unknown>): Record<string, unknown>;
  makeOperationId(): string;
};

const webHostCommandSet = new Set<string>(WEB_HOST_COMMANDS);

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" ? body.error : body;
    throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
  }
  return body;
}

export function createWebHostServices(options: WebHostServicesOptions): HostServices {
  return {
    supports(command): command is WebHostCommand {
      return webHostCommandSet.has(command);
    },
    async invoke<T>(command: WebHostCommand, args: Record<string, unknown>): Promise<T> {
      await options.ensureReady();
      const response = await fetch("/api/host-invoke", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...options.getRequestHeaders(),
        },
        body: JSON.stringify({
          operationId: options.makeOperationId(),
          command,
          args: options.normalizeArgs(command, args),
        }),
      });
      if (response.status === 409) options.onInactiveController();
      const body = await readJsonResponse(response);
      return body?.result as T;
    },
  };
}
