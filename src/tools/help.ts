import {
  type GetRuntimeState,
  type HelpRequest,
  type JupiterHelpContext,
  readHelp,
} from "../help/index.js";
import type { ToolRegistry } from "../tools.js";

export function registerHelpTool(
  registry: ToolRegistry,
  opts: { getRuntimeState?: GetRuntimeState; helpContext?: () => JupiterHelpContext } = {},
): ToolRegistry {
  registry.register({
    name: "jupiter_help",
    description:
      "Read Jupiter's version-bound packaged official manual and current host capabilities. Use topic or query; at most two chapters, 1500 tokens. No network, workspace, memory, skills or RAG lookup. Omit args for topic directory.",
    readOnly: true,
    parallelSafe: true,
    skipTruncationSave: true,
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Exact topic ID from the host help directory." },
        query: { type: "string", description: "Short feature question." },
      },
      additionalProperties: false,
    },
    fn: (args: HelpRequest) =>
      readHelp(args, opts.helpContext?.() ?? opts.getRuntimeState?.() ?? {}).content,
  });
  return registry;
}
