// Isolated local-only provider and workspace for interactive multimodal QA. No real API calls.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";

const root = await mkdtemp(join(tmpdir(), "jupiter-vision-qa-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
await mkdir(join(home, ".jupiter"), { recursive: true });
await mkdir(workspace);
const pixels = new Uint8Array(240 * 160 * 4);
for (let y = 0; y < 160; y++)
  for (let x = 0; x < 240; x++)
    pixels.set(x < 120 ? [230, 56, 74, 255] : [48, 172, 214, 255], (y * 240 + x) * 4);
const image = new PhotonImage(pixels, 240, 160);
await writeFile(join(root, "red-blue.png"), image.get_bytes());
image.free();
const requests = [];
const provider = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "vision-test" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || "{}");
  const images = (payload.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  );
  const text = (payload.messages ?? [])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" "),
    )
    .join(" ");
  requests.push({
    imageCount: images.length,
    tools: payload.tools?.length ?? 0,
    model: payload.model,
  });
  await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2));
  if (text.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 3000));
  const content = `Local test response: ${images.length} image(s) received. No external API was called.`;
  if (payload.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 450, completion_tokens: 20, total_tokens: 470 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 450, completion_tokens: 20, total_tokens: 470 },
      }),
    );
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
await writeFile(
  join(home, ".jupiter/config.json"),
  JSON.stringify({
    baseUrl,
    apiKey: "local-test-key",
    model: "vision-test",
    providerDialect: "openai-compatible",
    visionModels: { [`${baseUrl}|vision-test`]: true },
    thinkingEnabled: false,
    showAiVisibleDetails: true,
  }),
);
const child = spawn(
  process.execPath,
  [resolve("dist/cli/index.js"), "web", workspace, "--no-open"],
  {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      LANG: "en_US.UTF-8",
      JUPITER_NO_UPDATE_CHECK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdout.write(`QA root: ${root}\n`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    child.kill("SIGTERM");
    provider.close();
  });
child.once("exit", () => provider.close());
