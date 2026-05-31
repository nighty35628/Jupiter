/** Tool-use example: register a calculator tool. Needs DEEPSEEK_API_KEY. */
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  ToolRegistry,
  loadDotenv,
} from "../src/index.js";

loadDotenv();

const tools = new ToolRegistry();
tools.register<{ a: number; b: number }, number>({
  name: "add",
  description: "Add two integers.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "integer" },
      b: { type: "integer" },
    },
    required: ["a", "b"],
  },
  fn: ({ a, b }) => a + b,
});

async function main() {
  const client = new DeepSeekClient();
  const prefix = new ImmutablePrefix({
    system: "You are a calculator assistant. Use the `add` tool for addition.",
    toolSpecs: tools.specs(),
  });
  const loop = new CacheFirstLoop({ client, prefix, tools });

  const answer = await loop.run("What is 17 + 25?");
  console.log("answer:", answer);
  console.log("stats:", loop.stats.summary());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
