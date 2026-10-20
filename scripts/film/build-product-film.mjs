#!/usr/bin/env node
/** Mux directed silent capture + neural VO/ambient into final deliverables. */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, copyFileSync, mkdirSync } from "node:fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const outDir = path.join(root, "apps/web/dist-video")
const ffmpeg = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg"
const video =
  (existsSync(path.join(outDir, "mailinsider-enterprise-silent.webm")) &&
    path.join(outDir, "mailinsider-enterprise-silent.webm")) ||
  path.join(outDir, "mailinsider-live-silent.webm")
const audioCandidates = [
  path.join(__dirname, "audio/voiceover-mixed.wav"),
  path.join(__dirname, "audio/voiceover.wav"),
]
const audio = audioCandidates.find((p) => existsSync(p))
const mp4 = path.join(outDir, "mailinsider-product-film.mp4")
const webm = path.join(outDir, "mailinsider-product-film.webm")

if (!existsSync(video)) throw new Error(`Missing silent video at ${video}`)
if (!audio) throw new Error("Missing voiceover — run generate-voiceover.mjs first")

function run(args) {
  const res = spawnSync(ffmpeg, args, { encoding: "utf8" })
  if (res.status !== 0) throw new Error(res.stderr || res.stdout)
}

console.log("Video:", video)
console.log("Audio:", audio)
console.log("Muxing MP4…")
run([
  "-y",
  "-i",
  video,
  "-i",
  audio,
  "-c:v",
  "libx264",
  "-preset",
  "slow",
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
  mp4,
])
console.log("Muxing WebM…")
run([
  "-y",
  "-i",
  video,
  "-i",
  audio,
  "-c:v",
  "libvpx-vp9",
  "-b:v",
  "5M",
  "-c:a",
  "libopus",
  "-shortest",
  webm,
])
const publicDir = path.join(root, "apps/web/public/video")
mkdirSync(publicDir, { recursive: true })
const publicMp4 = path.join(publicDir, "mailinsider-product-film.mp4")
copyFileSync(mp4, publicMp4)
console.log(`Wrote\n  ${mp4}\n  ${webm}\n  ${publicMp4}`)
