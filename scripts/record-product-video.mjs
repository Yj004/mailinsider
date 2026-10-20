#!/usr/bin/env node
/**
 * Records the MailInsider product film to WebM via Playwright.
 *
 * Usage:
 *   1. Start the web app (apps/web: npm run dev -- --port 5178)
 *   2. node scripts/record-product-video.mjs
 */
import { createRequire } from "node:module"
import { mkdir, rename, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const webRoot = path.join(root, "apps/web")
const browsersPath = path.join(webRoot, ".playwright-browsers")
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")
const outDir = path.join(webRoot, "dist-video")
const base = process.env.PRODUCT_VIDEO_URL || "http://127.0.0.1:5178"
const durationMs = Number(process.env.PRODUCT_VIDEO_MS || 108_000)

await mkdir(outDir, { recursive: true })

console.log("Browsers path", browsersPath)
console.log("Chromium", chromium.executablePath())
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()
const url = `${base.replace(/\/$/, "")}/product-video?record=1`
console.log(`Recording ${url} for ${(durationMs / 1000).toFixed(0)}s…`)
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
await page.waitForSelector(".pv-stage", { timeout: 30_000 })
await page.waitForTimeout(durationMs)
await context.close()
await browser.close()

const files = (await readdir(outDir)).filter((f) => f.endsWith(".webm"))
if (!files.length) {
  console.error("No WebM produced.")
  process.exit(1)
}
files.sort()
const latest = path.join(outDir, files[files.length - 1])
const target = path.join(outDir, "mailinsider-product-film.webm")
await rename(latest, target)
console.log(`Wrote ${target}`)
