/**
 * Converts the auth-page background PNGs to appropriately-sized WebP.
 *
 * Run: npx tsx scripts/optimize-login-images.ts
 *
 * Replaces the committed PNGs in public/ (kept as .webp siblings). The original
 * 4.8MB/3.7MB PNGs forced sharp to re-process large inputs on every cold
 * optimizer miss on the Hetzner CX21, producing 5+ second TTFB on the /_next/image
 * endpoint. WebP sources at the target display width reduce source size ~95%
 * and sharp processing time from ~5s to ~200ms.
 */
import sharp from "sharp";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const PUBLIC_DIR = resolve(__dirname, "..", "public");

type Target = {
  srcPng: string;
  outWebp: string;
  maxWidth: number;
  label: string;
};

const TARGETS: Target[] = [
  { srcPng: "login-new-3.png",       outWebp: "login-new-3.webp",       maxWidth: 1920, label: "desktop" },
  { srcPng: "login-side-mobile.png", outWebp: "login-side-mobile.webp", maxWidth: 828,  label: "mobile"  },
];

async function run() {
  for (const t of TARGETS) {
    const srcPath = resolve(PUBLIC_DIR, t.srcPng);
    const outPath = resolve(PUBLIC_DIR, t.outWebp);

    const srcBuf = await readFile(srcPath);
    const srcMeta = await sharp(srcBuf).metadata();

    const outBuf = await sharp(srcBuf)
      .resize({ width: t.maxWidth, withoutEnlargement: true })
      .webp({ quality: 80, effort: 6 })
      .toBuffer();

    await writeFile(outPath, outBuf);
    const outStat = await stat(outPath);

    const srcMb = (srcBuf.length / 1024 / 1024).toFixed(2);
    const outKb = (outStat.size / 1024).toFixed(0);
    const ratio = ((1 - outStat.size / srcBuf.length) * 100).toFixed(1);

    console.log(
      `${t.label.padEnd(8)} ${t.srcPng} (${srcMeta.width}x${srcMeta.height}, ${srcMb} MB) → ${t.outWebp} (${t.maxWidth}w, ${outKb} KB, -${ratio}%)`,
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
