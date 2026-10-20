#!/usr/bin/env node
/** Records marketing/mailbox-motion.html → marketing/mailinsider-product-30s.mp4 */
import { createRequire } from "node:module"
import { mkdir, readdir, copyFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const webRoot = path.join(root, "apps/web")
const marketing = path.join(root, "marketing")
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(webRoot, ".playwright-browsers")

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

const outDir = path.join(marketing, "_record")
const durationMs = 30_600
const html = path.join(marketing, "mailbox-motion.html")
const url = pathToFileURL(html).href + "?v=" + Date.now()

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

console.log("Recording 30s product film", url)
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
await page.waitForSelector("#stage", { timeout: 15_000 })
await page.waitForTimeout(durationMs)
await context.close()
await browser.close()

const files = (await readdir(outDir))
  .filter((f) => f.endsWith(".webm"))
  .map((f) => ({ f, m: 0 }))
for (const item of files) {
  const { statSync } = await import("node:fs")
  item.m = statSync(path.join(outDir, item.f)).mtimeMs
}
files.sort((a, b) => b.m - a.m)
const webm = path.join(outDir, files[0].f)
const webmOut = path.join(marketing, "mailinsider-product-30s.webm")
const mp4 = path.join(marketing, "mailinsider-product-30s.mp4")
await copyFile(webm, webmOut)

const ff = spawnSync(
  "ffmpeg",
  ["-y", "-i", webmOut, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", mp4],
  { stdio: "inherit" },
)
if (ff.status !== 0) process.exit(ff.status || 1)
console.log("Wrote", mp4)
