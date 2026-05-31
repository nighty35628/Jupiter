/** Minimal example: one-shot, non-streaming. Needs DEEPSEEK_API_KEY. */
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  loadDotenv,
} from "../src/index.js";

loadDotenv();

async function main() {
  const client = new DeepSeekClient();
  const prefix = new ImmutablePrefix({ system: "You are a concise assistant." });
  const loop = new CacheFirstLoop({ client, prefix, stream: false });

  const answer = await loop.run("In one sentence, what is prompt caching?");
  console.log(answer);
  console.log("---");
  console.log(loop.stats.summary());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
