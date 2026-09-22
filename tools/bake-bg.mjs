/**
 * bake-bg.mjs -- render an animated SVG background to a perfectly seamless loop video.
 *
 * Why this exists: these backgrounds animate with CSS keyframes *and* SMIL
 * <animate> at unrelated durations, so their true loop period is the LCM of all
 * of them -- 30 minutes for red_bg, over 1000 hours for custom_bg. Recording the
 * page in real time can never produce a clean loop.
 *
 * So we do two things the browser cannot do on its own:
 *   1. Retune every animation to the nearest duration that fits a whole number
 *      of cycles into the loop length (see harmonize.mjs).
 *   2. Freeze both animation clocks and seek frame by frame, so the output is
 *      deterministic -- no dropped frames, no timing drift, and frame N is
 *      exactly frame 0.
 *
 * Usage:
 *   node tools/bake-bg.mjs                       # all backgrounds, defaults
 *   node tools/bake-bg.mjs red_bg.html --shards 6
 *   node tools/bake-bg.mjs --loop 240 --fps 60 --crf 16 --grain
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harmonizeAndFreeze, seekTo, hideAuthoringUI } from "./harmonize.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A target is either a path, or {file, name} when the output should not inherit
// the filename -- index.html is really the blue variant of the bg family.
const DEFAULT_FILES = [
  "dark_bg.html", "red_bg.html", "red_blue_bg.html", "orange_bg.html",
  "pink_bg.html", "wc2026_bg.html", "custom_bg.html",
  { file: "index.html", name: "blue_bg" },
  "gray_bg.html", "gray_flat_bg.html",
];

/* ------------------------------- CLI ------------------------------- */
function parseArgs(argv) {
  const o = { loop: 240, fps: 60, shards: 4, crf: 16, width: 1920, height: 1080,
              out: "dist/bg", preset: "slow", grain: false, files: [], keep: false, name: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grain") o.grain = true;
    else if (a === "--keep") o.keep = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (!(k in o)) throw new Error(`unknown flag --${k}`);
      const v = argv[++i];
      o[k] = typeof o[k] === "number" ? Number(v) : v;
    } else o.files.push(a);
  }
  if (!o.files.length) o.files = DEFAULT_FILES;
  if (o.name && o.files.length > 1) throw new Error("--name only applies to a single target");
  return o;
}

/** Fold a name or query string down to something usable as a filename. */
function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9_]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/* --------------------------- static server -------------------------- */
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".avif": "image/avif",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif" };

async function serveRoot() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(buf);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

/* ------------------------------ ffmpeg ------------------------------ */
function startEncoder(outFile, opt) {
  // Fixed GOP with no scene-cut detection so the shard segments concat cleanly
  // with -c copy. Explicit bt709/tv tagging keeps OBS from shifting the levels
  // (otherwise the baked video looks washed out next to the browser source).
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-c:v", "png", "-framerate", String(opt.fps), "-i", "-",
    ...(opt.grain ? ["-vf", "noise=alls=2:allf=t+u"] : []),
    "-c:v", "libx264", "-preset", opt.preset, "-crf", String(opt.crf),
    "-pix_fmt", "yuv420p",
    "-g", String(opt.fps * 2), "-keyint_min", String(opt.fps * 2), "-sc_threshold", "0",
    "-color_range", "tv", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-an", outFile,
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  return { proc, err: () => stderr };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? resolve(out + err) : reject(new Error(`${cmd} exited ${code}\n${err}`))));
  });
}

/* ------------------------------ render ------------------------------ */
async function openPage(browser, url, opt) {
  const page = await browser.newPage({
    viewport: { width: opt.width, height: opt.height },
    deviceScaleFactor: 1,
  });
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(hideAuthoringUI);
  // custom_bg.html builds its gradients in JS on load; give it a moment to
  // settle before we snapshot the animation list.
  await page.waitForTimeout(400);
  await page.evaluate(() => document.fonts?.ready);
  const report = await page.evaluate(harmonizeAndFreeze, opt.loop);
  await page.evaluate(
    (src) => { window.__seek = new Function("return " + src)(); },
    seekTo.toString(),
  );
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp, report };
}

async function renderShard({ url, outFile, start, end, opt, onFrame }) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--force-device-scale-factor=1", "--force-color-profile=srgb",
      "--hide-scrollbars", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ],
  });
  try {
    const { page, cdp, report } = await openPage(browser, url, opt);
    const { proc, err } = startEncoder(outFile, opt);
    const total = opt.fps * opt.loop;

    for (let i = start; i < end; i++) {
      await page.evaluate((t) => window.__seek(t), (i * opt.loop) / total);
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png", optimizeForSpeed: true, captureBeyondViewport: false,
      });
      if (!proc.stdin.write(Buffer.from(shot.data, "base64"))) await once(proc.stdin, "drain");
      onFrame();
    }

    proc.stdin.end();
    const [code] = await once(proc, "close");
    if (code !== 0) throw new Error(`ffmpeg failed on ${outFile}:\n${err()}`);
    return report;
  } finally {
    await browser.close();
  }
}

/* --------------------------- seam verify ---------------------------- */
async function psnr(a, b) {
  const out = await run("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"]);
  const m = out.match(/average:([\d.]+|inf)/);
  return m ? (m[1] === "inf" ? Infinity : parseFloat(m[1])) : NaN;
}

async function verifySeam(mp4, tmpDir, totalFrames) {
  const grab = async (idx, name) => {
    const f = path.join(tmpDir, name);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", mp4,
      "-vf", `select=eq(n\\,${idx})`, "-fps_mode", "passthrough", "-frames:v", "1", f]);
    return f;
  };
  const f0 = await grab(0, "seam_first.png");
  const f1 = await grab(1, "seam_second.png");
  const fLast = await grab(totalFrames - 1, "seam_last.png");
  // A seamless loop means last->first is just another ordinary frame step, so
  // it should look about the same as first->second.
  return { wrap: await psnr(fLast, f0), step: await psnr(f0, f1) };
}

/* ------------------------------- main ------------------------------- */
async function bakeOne(target, port, opt) {
  const file = typeof target === "string" ? target : target.file;
  // A target may carry palette query params (custom_bg.html?c=...), which are
  // meaningful to the page but illegal in a Windows filename.
  const [filePath, query] = file.split("?");
  const explicit = opt.name || (typeof target === "string" ? "" : target.name);
  const name = explicit
    ? sanitize(explicit)
    : path.basename(filePath, ".html") + (query ? "_" + sanitize(query) : "");
  const outDir = path.resolve(ROOT, opt.out);
  const tmpDir = path.join(outDir, `.tmp_${name}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const total = opt.fps * opt.loop;
  const url = `http://127.0.0.1:${port}/${file}`;
  const shards = Math.max(1, Math.min(opt.shards, 16));
  const per = Math.ceil(total / shards);

  console.log(`\n=== ${name} =================================================`);
  console.log(`    ${total} frames @ ${opt.fps}fps  (${opt.loop}s loop)  |  ${shards} shards x ~${per}`);

  let done = 0;
  const t0 = Date.now();
  const tick = () => {
    if (++done % 500 !== 0 && done !== total) return;
    const el = (Date.now() - t0) / 1000;
    const rate = done / el;
    process.stdout.write(
      `    ${String(done).padStart(6)}/${total}  ${rate.toFixed(1)} fps  ` +
      `elapsed ${el.toFixed(0)}s  eta ${((total - done) / rate).toFixed(0)}s\n`);
  };

  const segs = [];
  const jobs = [];
  for (let s = 0; s < shards; s++) {
    const start = s * per, end = Math.min(total, start + per);
    if (start >= end) break;
    const seg = `shard_${String(s).padStart(2, "0")}.mp4`;
    segs.push(seg);
    jobs.push(renderShard({ url, outFile: path.join(tmpDir, seg), start, end, opt, onFrame: tick }));
  }
  const reports = await Promise.all(jobs);

  const listFile = path.join(tmpDir, "concat.txt");
  await fsp.writeFile(listFile, segs.map((f) => `file '${f}'`).join("\n"));

  const outFile = path.join(outDir, `${name}_loop${opt.loop}s.mp4`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat",
    "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", outFile]);

  const seam = await verifySeam(outFile, tmpDir, total);
  const size = (await fsp.stat(outFile)).size / 1048576;
  const r = reports[0];
  const ok = seam.wrap >= seam.step - 1.5;

  console.log(`    retuned: ${r.css.length} CSS + ${r.smil.length} SMIL, max drift ${r.maxDriftPct}%`);
  if (r.warnings.length) console.log(`    warnings: ${r.warnings.join("; ")}`);
  console.log(`    seam PSNR wrap ${seam.wrap.toFixed(2)} dB vs normal step ${seam.step.toFixed(2)} dB ` +
              `-> ${ok ? "SEAMLESS" : "*** VISIBLE CUT ***"}`);
  console.log(`    ${outFile}  (${size.toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  if (!opt.keep) await fsp.rm(tmpDir, { recursive: true, force: true });
  return { name, outFile, size, seam, drift: r.maxDriftPct, ok };
}

const opt = parseArgs(process.argv.slice(2));
const { server, port } = await serveRoot();
await fsp.mkdir(path.resolve(ROOT, opt.out), { recursive: true });

const results = [];
try {
  for (const f of opt.files) results.push(await bakeOne(f, port, opt));
} finally {
  server.close();
}

console.log("\n================ summary ================");
for (const r of results) {
  console.log(`${r.name.padEnd(14)} ${r.size.toFixed(1).padStart(6)} MB  drift ${String(r.drift).padStart(5)}%  ` +
              `seam ${r.ok ? "ok" : "CHECK"}`);
}
