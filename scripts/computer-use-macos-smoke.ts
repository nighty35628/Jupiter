import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import {
  ComputerUseRuntime,
  ComputerUseToolAdapter,
  registerComputerUseTools,
} from "../src/computer-use/index.js";
import { ToolRegistry } from "../src/tools.js";
import { attachments } from "../src/attachments/store.js";
import { projectImages } from "../src/attachments/projection.js";
import assert from "node:assert/strict";
import { PhotonImage } from "@silvia-odwyer/photon-node";

assert(
  process.argv.includes("--auto"),
  "Run with --auto to consent to real desktop input in an isolated test window.",
);
await mkdir(`${process.cwd()}/tmp/cua`, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
  args: ["--window-position=100,100", "--window-size=1000,740"],
});
const page = await browser.newPage({ viewport: null });
page.setDefaultTimeout(5000);
const runtime = new ComputerUseRuntime({
  command: `${process.env.HOME}/.local/bin/cua-driver`,
  requestTimeoutMs: 15000,
});
const registry = new ToolRegistry();
let count = 0;
let pixels: Uint8Array;
let pixelWidth = 0;
try {
  await page.setContent(`<html><head><title>Jupiter Computer Use Test</title><style>
  body {font:20px system-ui;margin:40px;background:#fff;color:#141414} button,input {font:20px system-ui;padding:14px;border:2px solid #198654;border-radius:4px} button{background:#def2e8;margin-bottom:20px} #area{margin-top:24px;width:700px;height:240px;overflow:auto;border:3px solid #198654} #inside{width:1800px;height:1600px;background:repeating-linear-gradient(white 0px,white 79px,#d0e4ed 80px,#d0e4ed 160px)}
  #test {background:rgb(64,224,128)} #text {background:rgb(250,180,220)} #inside {background:rgb(60,160,245)}
  </style></head><body><h2>Jupiter Computer Use Test</h2><button id="test">Test clicks: 0</button><br><input id="text" placeholder="Test text" style="width:640px"><div id="area"><div id="inside">Scroll test area</div></div><p id="status">Ready</p><script>
  window.results={clicks:0,rightClicks:0,moves:0,text:'',top:0,left:0};
  test.onclick=()=>{results.clicks++;test.textContent='Test clicks: '+results.clicks};
  test.oncontextmenu=e=>{e.preventDefault();results.rightClicks++;document.getElementById("status").textContent='Right clicked'};
  test.onpointermove=()=>results.moves++;
  text.oninput=()=>results.text=text.value;
  area.onscroll=()=>{results.top=area.scrollTop;results.left=area.scrollLeft};
  </script></body></html>`);
  await page.bringToFront();
  const client = await runtime.start(`smoke:${process.pid}`);
  registerComputerUseTools(registry, new ComputerUseToolAdapter(client, runtime.controller));
  console.log("READY");
  const actions: any[] = [];
  const invoke = async (name: string, args = {}) => {
    const images: any[] = [];
    const begin = Date.now();
    const raw = await registry.dispatch(name, args, { reportImage: (image) => images.push(image) });
    const value = JSON.parse(raw);
    console.log(
      JSON.stringify({
        tool: name,
        ms: Date.now() - begin,
        error: value.error,
        effect: value.effect,
      }),
    );
    assert(!value.error && !value.isError, raw);
    actions.push({ name, ms: Date.now() - begin, ...value });
    if (images.length) {
      const projected = await projectImages(
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "shot", type: "function", function: { name, arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "shot", content: raw, attachments: images },
        ],
        { supportsImages: true },
      );
      assert(projected.snapshot.sent.length === 1);
      assert(projected.snapshot.sentVariants[images[0].id].width === value.observation.imageWidth);
      assert(
        projected.snapshot.sentVariants[images[0].id].height === value.observation.imageHeight,
      );
    }
    for (const image of images) {
      const variant = await attachments.requestImage(image.id);
      const decoded = PhotonImage.new_from_byteslice(variant.data);
      pixels = decoded.get_raw_pixels();
      pixelWidth = decoded.get_width();
      decoded.free();
      await writeFile(`${process.cwd()}/tmp/cua/auto-${++count}.webp`, variant.data);
    }
    return value;
  };
  const observe = async () => {
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, 400));
    const value = await invoke("computer_use_get_desktop_state");
    assert(
      await page.evaluate(() => document.hasFocus()),
      "Test window lost focus; refusing input",
    );
    return value;
  };
  const action = async (name: string, selector: string, args = {}) => {
    const state = await observe();
    // Locate fixture colors in the actual driver image, not window.screenX:
    // Stage Manager can animate a window after Chrome reports its bounds.
    const color =
      selector === "#test"
        ? [64, 224, 128]
        : selector === "#text"
          ? [250, 180, 220]
          : [60, 160, 245];
    let total = 0,
      xsum = 0,
      ysum = 0;
    const mask = new Uint8Array(pixels.length / 4);
    for (let i = 0; i < pixels.length; i += 4) {
      if (color.every((v, j) => Math.abs(v - pixels[i + j]) < 70)) mask[i / 4] = 1;
    }
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const pending = [i];
      mask[i] = 0;
      let n = 0,
        sx = 0,
        sy = 0;
      for (let q = 0; q < pending.length; q++) {
        const p = pending[q];
        n++;
        sx += p % pixelWidth;
        sy += Math.floor(p / pixelWidth);
        for (const next of [p - 1, p + 1, p - pixelWidth, p + pixelWidth])
          if (next >= 0 && next < mask.length && mask[next]) {
            mask[next] = 0;
            pending.push(next);
          }
      }
      if (n > total) {
        total = n;
        xsum = sx;
        ysum = sy;
      }
    }
    assert(total > 1000, `Fixture ${selector} is not visible; refusing input`);
    const x = xsum / total,
      y = ysum / total;
    const result = await invoke(name, { observationId: state.observationId, x, y, ...args });
    if (name === "computer_use_move") {
      const cursor = await invoke("computer_use_get_cursor_position");
      assert(Math.abs(cursor.x - (x * state.screenWidth) / state.observation.imageWidth) < 2);
      assert(Math.abs(cursor.y - (y * state.screenHeight) / state.observation.imageHeight) < 2);
    }
    return result;
  };
  await action("computer_use_move", "#test");
  await action("computer_use_click", "#test");
  await page.waitForFunction(() => (window as any).results.clicks === 1);
  await action("computer_use_click", "#test", { button: "right" });
  await page.waitForFunction(() => (window as any).results.rightClicks === 1);
  await action("computer_use_click", "#text");
  const state = await observe();
  await invoke("computer_use_type", {
    observationId: state.observationId,
    text: "Jupiter 测试 123",
  });
  await page.waitForFunction(() => (window as any).results.text === "Jupiter 测试 123");
  await action("computer_use_scroll", "#area", { direction: "down", amount: 4 });
  await page.waitForFunction(() => (window as any).results.top > 0);
  await new Promise((r) => setTimeout(r, 600));
  const down = await page.evaluate(() => (window as any).results.top);
  await action("computer_use_scroll", "#area", { direction: "up", amount: 2 });
  await page.waitForFunction((previous) => (window as any).results.top < previous, down);
  await new Promise((r) => setTimeout(r, 600));
  await action("computer_use_scroll", "#area", { direction: "right", amount: 4 });
  await page.waitForFunction(() => (window as any).results.left > 0);
  await new Promise((r) => setTimeout(r, 600));
  const right = await page.evaluate(() => (window as any).results.left);
  console.log(JSON.stringify({ down, right }));
  await action("computer_use_scroll", "#area", { direction: "left", amount: 2 });
  await page.waitForFunction((previous) => (window as any).results.left < previous, right);
  const final = await observe();
  const results = await page.evaluate(() => (window as any).results);
  await runtime.stop();
  const stopped = JSON.parse(
    await registry.dispatch("computer_use_click", {
      observationId: final.observationId,
      x: 148,
      y: 220,
    }),
  );
  assert(stopped.error, "stopped runtime must refuse input");
  console.log(JSON.stringify({ results, calls: actions.length, stopped }, null, 2));
  await writeFile(
    `${process.cwd()}/tmp/cua/smoke-report.json`,
    JSON.stringify({ results, actions, stopped }, null, 2),
  );
} finally {
  await runtime.stop();
  await browser.close();
}
