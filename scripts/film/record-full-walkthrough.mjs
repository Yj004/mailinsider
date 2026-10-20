#!/usr/bin/env node
/**
 * Record full-walkthrough-motion.html + mux Indian-English VO → product film.
 * Final deliverable also sped to ~1.5x for brisk presentation.
 */
import { createRequire } from "node:module"
import { mkdir, readdir, copyFile, rm, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const webRoot = path.join(root, "apps/web")
const marketing = path.join(root, "marketing")
const outDir = path.join(webRoot, "dist-video")
const ffmpeg = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg"
const ffprobe = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe"
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(webRoot, ".playwright-browsers")

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (res.status !== 0) throw new Error(`${cmd} failed\n${res.stderr || res.stdout}`)
  return res
}

// 1) Voiceover (skip if SKIP_VO=1 and timing exists)
if (process.env.SKIP_VO !== "1" || !existsSync(path.join(__dirname, "audio/timing.json"))) {
  console.log("=== generate-voiceover ===")
  const res = spawnSync(process.execPath, [path.join(__dirname, "generate-voiceover.mjs")], {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      FILM_VOICE: process.env.FILM_VOICE || "en-IN-NeerjaNeural",
      FILM_VOICE_RATE: process.env.FILM_VOICE_RATE || "+40%",
    },
  })
  if (res.status !== 0) process.exit(res.status || 1)
} else {
  console.log("=== skip VO (reuse existing) ===")
}

const timing = JSON.parse(await readFile(path.join(__dirname, "audio/timing.json"), "utf8"))
const audio =
  (existsSync(path.join(__dirname, "audio/voiceover-mixed.wav")) && path.join(__dirname, "audio/voiceover-mixed.wav")) ||
  path.join(__dirname, "audio/voiceover.wav")

const audioDur = Number(
  run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audio])
    .stdout.trim(),
)
const recordMs = Math.ceil((audioDur + 0.4) * 1000)
console.log(`VO duration ${audioDur.toFixed(1)}s — recording ${recordMs}ms`)

// 2) Record motion
const recDir = path.join(outDir, "_walkthrough_rec")
await rm(recDir, { recursive: true, force: true })
await mkdir(recDir, { recursive: true })
await mkdir(outDir, { recursive: true })

const html = path.join(__dirname, "full-walkthrough-motion.html")
const url = pathToFileURL(html).href + "?v=" + Date.now()
console.log("=== record motion ===", url)
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: recDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
await page.waitForSelector("#stage")
await page.waitForTimeout(recordMs)
await context.close()
await browser.close()

const webms = (await readdir(recDir))
  .filter((f) => f.endsWith(".webm"))
  .map((f) => ({ f, m: 0 }))
const { statSync } = await import("node:fs")
for (const item of webms) item.m = statSync(path.join(recDir, item.f)).mtimeMs
webms.sort((a, b) => b.m - a.m)
const silent = path.join(outDir, "mailinsider-walkthrough-silent.webm")
await copyFile(path.join(recDir, webms[0].f), silent)

// 3) Mux 1x
const muxed = path.join(outDir, "mailinsider-walkthrough-1x.mp4")
console.log("=== mux ===")
run(ffmpeg, [
  "-y",
  "-i",
  silent,
  "-i",
  audio,
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-shortest",
  "-movflags",
  "+faststart",
  muxed,
])

// 4) 1.5x final (video + audio)
const speed = Number(process.env.FILM_SPEED || "1.2")
const finalMp4 = path.join(outDir, "mailinsider-product-film.mp4")
const finalWebm = path.join(outDir, "mailinsider-product-film.webm")
console.log(`=== speed ${speed}x ===`)
run(ffmpeg, [
  "-y",
  "-i",
  muxed,
  "-filter_complex",
  `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
  "-map",
  "[v]",
  "-map",
  "[a]",
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-movflags",
  "+faststart",
  finalMp4,
])
run(ffmpeg, [
  "-y",
  "-i",
  finalMp4,
  "-c:v",
  "libvpx-vp9",
  "-b:v",
  "4M",
  "-c:a",
  "libopus",
  finalWebm,
])

const finalDur = Number(
  run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", finalMp4])
    .stdout.trim(),
)

// 5) Copy to public + marketing
const publicDir = path.join(webRoot, "public/video")
await mkdir(publicDir, { recursive: true })
await copyFile(finalMp4, path.join(publicDir, "mailinsider-product-film.mp4"))
await mkdir(marketing, { recursive: true })
await copyFile(finalMp4, path.join(marketing, "mailinsider-product-film-vo.mp4"))

// 6) Write scene map for frontend (sped timeline)
let t = 0
const scenes = timing.chapters.map((c, i) => {
  const dur = c.duration / speed
  const start = t
  t += dur
  return {
    id: c.id,
    start: Number(start.toFixed(2)),
    end: Number(t.toFixed(2)),
    chapter: String(i + 1).padStart(2, "0"),
    title: c.caption,
    caption: c.voice.split(".")[0] + ".",
  }
})
await writeFile(
  path.join(__dirname, "audio/scenes-sped.json"),
  JSON.stringify({ duration: Number(finalDur.toFixed(2)), speed, voice: timing.voice, scenes }, null, 2),
)

console.log(`\nDone ${finalDur.toFixed(1)}s @ ${speed}x`)
console.log(`  ${finalMp4}`)
console.log(`  ${path.join(publicDir, "mailinsider-product-film.mp4")}`)
console.log(`  ${path.join(marketing, "mailinsider-product-film-vo.mp4")}`)
