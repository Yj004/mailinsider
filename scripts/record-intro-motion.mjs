#!/usr/bin/env node
/** Records marketing/intro-motion.html → marketing/mailinsider-intro-12s.mp4 */
import { createRequire } from "node:module"
import { mkdir, rename, readdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const webRoot = path.join(root, "apps/web")
const marketing = path.join(root, "marketing")
const browsersPath = path.join(webRoot, ".playwright-browsers")
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

const outDir = path.join(marketing, "_record")
const durationMs = 12_800
const html = path.join(marketing, "intro-motion.html")
const url = pathToFileURL(html).href

await mkdir(outDir, { recursive: true })

console.log("Recording", url)
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

const files = (await readdir(outDir)).filter((f) => f.endsWith(".webm"))
if (!files.length) {
  console.error("No WebM produced.")
  process.exit(1)
}
files.sort()
const webm = path.join(outDir, files[files.length - 1])
const webmOut = path.join(marketing, "mailinsider-intro-12s.webm")
await copyFile(webm, webmOut)

const mp4 = path.join(marketing, "mailinsider-intro-12s.mp4")
const ff = spawnSync(
  "ffmpeg",
  ["-y", "-i", webmOut, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", mp4],
  { stdio: "inherit" },
)
if (ff.status !== 0) {
  console.error("ffmpeg failed; webm kept at", webmOut)
  process.exit(ff.status || 1)
}
console.log("Wrote", mp4)
