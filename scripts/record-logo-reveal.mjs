#!/usr/bin/env node
/** Records marketing/logo-reveal.html → 7s 1920×1080 H.264 master + audio. */
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
process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = "0"

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

const ffmpeg = process.env.FFMPEG || "ffmpeg"
const outDir = path.join(marketing, "_record")
const durationMs = 7_400
const html = path.join(marketing, "logo-reveal.html")
const url = pathToFileURL(html).href + "?v=" + Date.now()
const audio = path.join(marketing, "_record", "logo-reveal-audio.wav")
const master = path.join(marketing, "mailinsider-logo-reveal-7s.mp4")
const webmOut = path.join(marketing, "mailinsider-logo-reveal-7s.webm")

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" })
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

console.log("=== audio bed ===")
run(ffmpeg, [
  "-y",
  "-f", "lavfi", "-i", "anoisesrc=d=7:c=pink:r=48000:a=0.04",
  "-f", "lavfi", "-i", "sine=f=220:d=7:r=48000",
  "-f", "lavfi", "-i", "anoisesrc=d=1.5:c=pink:r=48000:a=0.22",
  "-f", "lavfi", "-i", "sine=f=523.25:d=0.32:r=48000",
  "-f", "lavfi", "-i", "sine=f=784:d=0.55:r=48000",
  "-f", "lavfi", "-i", "sine=f=1174.7:d=0.7:r=48000",
  "-filter_complex",
  [
    "[0]highpass=f=180,lowpass=f=900,volume=0.12,afade=t=in:d=0.6,afade=t=out:st=6.1:d=0.9[air]",
    "[1]volume=0.012,afade=t=in:d=1.2,afade=t=out:st=6.2:d=0.8[drone]",
    "[2]highpass=f=500,lowpass=f=2400,afade=t=in:d=0.12,afade=t=out:st=1.05:d=0.4,adelay=1450|1450,volume=0.55[whoosh]",
    "[3]afade=t=in:d=0.01,afade=t=out:d=0.28,adelay=2780|2780,volume=0.16[tone]",
    "[4]afade=t=in:d=0.01,afade=t=out:d=0.42,adelay=4680|4680,volume=0.11[ch1]",
    "[5]afade=t=in:d=0.02,afade=t=out:d=0.55,adelay=4720|4720,volume=0.09[ch2]",
    "[air][drone][whoosh][tone][ch1][ch2]amix=inputs=6:duration=first:dropout_transition=0,alimiter=limit=0.9,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo",
  ].join(";"),
  "-t", "7",
  audio,
])

console.log("=== record ===", url)
const browser = await chromium.launch({
  headless: true,
  executablePath: chromium.executablePath(),
})
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()
await page.goto(url, { waitUntil: "load", timeout: 60_000 })
await page.waitForSelector("#stage", { timeout: 15_000 })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(200)
await page.evaluate(() => document.getElementById("stage").classList.add("play"))
await page.waitForTimeout(durationMs)
await context.close()
await browser.close()

const files = (await readdir(outDir)).filter((f) => f.endsWith(".webm"))
if (!files.length) {
  console.error("No WebM produced.")
  process.exit(1)
}
files.sort()
const recorded = path.join(outDir, files[files.length - 1])
await copyFile(recorded, webmOut)

console.log("=== mux master ===")
run(ffmpeg, [
  "-y",
  "-i", webmOut,
  "-i", audio,
  "-t", "7",
  "-r", "30",
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "16",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "192k",
  "-ar", "48000",
  "-ac", "2",
  "-shortest",
  "-movflags", "+faststart",
  master,
])

console.log("Wrote", master)
