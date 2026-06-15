/**
 * JobSmith build script.
 *
 * Bundles every extension entry point with esbuild (IIFE bundles so there are
 * no ESM/worker quirks in the MV3 runtime), copies static assets, injects the
 * package version into the manifest, and generates PNG icons from scratch with
 * a tiny pure-JS PNG encoder (no native image dependencies).
 *
 * Usage:
 *   node build.mjs            # one-off production build
 *   node build.mjs --watch    # rebuild on change
 */
import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, "dist");
const watch = process.argv.includes("--watch");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Entry points. Everything is bundled to a single self-contained IIFE file. */
const entryPoints = {
  "service-worker": "src/background/service-worker.ts",
  content: "src/content/autofill-content.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
  "llm.worker": "src/resume/llm.worker.ts",
};

/** Static files copied verbatim into dist/. */
const staticCopies = [
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/options/options.css", "options.css"],
  ["src/content/overlay.css", "overlay.css"],
];

const esbuildOptions = {
  entryPoints: Object.fromEntries(
    Object.entries(entryPoints).map(([name, file]) => [name, join(root, file)]),
  ),
  outdir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

function prepareDist() {
  if (existsSync(outdir)) rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
}

function copyStatic() {
  for (const [from, to] of staticCopies) {
    const src = join(root, from);
    if (existsSync(src)) cpSync(src, join(outdir, to));
  }
  // Manifest with injected version.
  const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
  manifest.version = pkg.version;
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/* ----------------------------- PNG icon encoder ---------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode RGBA pixel buffer (width*height*4) as a PNG (color type 6, 8-bit). */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10-12 = compression/filter/interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Brand palette.
const BRAND = [37, 99, 235]; // #2563eb
const BRAND_DARK = [29, 78, 216]; // #1d4ed8
const WHITE = [255, 255, 255];

function blendPixel(rgba, w, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 4;
  if (i + 3 >= rgba.length) return;
  const af = a / 255;
  rgba[i] = Math.round(r * af + rgba[i] * (1 - af));
  rgba[i + 1] = Math.round(g * af + rgba[i + 1] * (1 - af));
  rgba[i + 2] = Math.round(b * af + rgba[i + 2] * (1 - af));
  rgba[i + 3] = Math.min(255, rgba[i + 3] + a);
}

function fillRoundRect(rgba, w, x0, y0, x1, y1, radius, color, alpha = 255) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = Math.min(x - x0, x1 - 1 - x);
      const dy = Math.min(y - y0, y1 - 1 - y);
      if (dx < radius && dy < radius) {
        const ddx = radius - dx;
        const ddy = radius - dy;
        if (ddx * ddx + ddy * ddy > radius * radius) continue;
      }
      blendPixel(rgba, w, x, y, color, alpha);
    }
  }
}

/** Draw a briefcase glyph on a rounded-square brand background. */
function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const s = (v) => Math.round(v * size);
  // Background rounded square.
  fillRoundRect(rgba, size, 0, 0, size, size, s(0.22), BRAND);
  // Briefcase body.
  fillRoundRect(rgba, size, s(0.22), s(0.4), s(0.78), s(0.74), s(0.06), WHITE);
  // Handle (white bar on top with brand cutout).
  fillRoundRect(rgba, size, s(0.38), s(0.3), s(0.62), s(0.42), s(0.03), WHITE);
  fillRoundRect(rgba, size, s(0.43), s(0.34), s(0.57), s(0.42), s(0.02), BRAND);
  // Divider line + clasp.
  fillRoundRect(rgba, size, s(0.22), s(0.54), s(0.78), s(0.58), 0, BRAND_DARK);
  fillRoundRect(rgba, size, s(0.46), s(0.52), s(0.54), s(0.6), s(0.01), BRAND);
  return encodePng(size, size, rgba);
}

function generateIcons() {
  const dir = join(outdir, "icons");
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(dir, `icon${size}.png`), makeIcon(size));
  }
}

/* --------------------------------- runner --------------------------------- */

async function run() {
  prepareDist();
  copyStatic();
  generateIcons();

  if (watch) {
    const ctx = await context(esbuildOptions);
    await ctx.watch();
    console.log("[build] watching for changes…");
  } else {
    await build(esbuildOptions);
    console.log(`[build] JobSmith v${pkg.version} → dist/`);
  }
}

run().catch((err) => {
  console.error("[build] failed:", err);
  process.exit(1);
});
