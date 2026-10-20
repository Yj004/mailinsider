#!/usr/bin/env node
/**
 * Timed chapter voiceover — Indian female English (Neerja) at brisk ~1.5x delivery.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const outDir = path.join(__dirname, "audio")
const chapters = JSON.parse(readFileSync(path.join(__dirname, "chapters.json"), "utf8"))
const ffmpeg = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg"
const ffprobe = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe"
const edge = path.join(root, ".venv/bin/edge-tts")
// Indian English · female · clear product presentation
const voice = process.env.FILM_VOICE || "en-IN-NeerjaNeural"
// ~1.5x brisk delivery (edge-tts rate)
const rate = process.env.FILM_VOICE_RATE || "+40%"

mkdirSync(outDir, { recursive: true })

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`${cmd} failed\n${res.stderr || res.stdout}`)
  return res
}

const parts = []
const timing = []
for (const [index, chapter] of chapters.entries()) {
  const mp3 = path.join(outDir, `${String(index).padStart(2, "0")}-${chapter.id}.mp3`)
  const wav = path.join(outDir, `${String(index).padStart(2, "0")}-${chapter.id}.wav`)
  const padded = path.join(outDir, `${String(index).padStart(2, "0")}-${chapter.id}-pad.wav`)

  run(edge, [
    "--voice",
    voice,
    "--rate",
    rate,
    "--pitch",
    "+0Hz",
    "--text",
    chapter.voice,
    "--write-media",
    mp3,
  ])
  run(ffmpeg, ["-y", "-i", mp3, "-ar", "44100", "-ac", "1", wav])
  const probe = run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    wav,
  ])
  const spoken = Number(probe.stdout.trim()) || 0
  const target = Math.max(chapter.duration, spoken + 0.35)
  const pad = Math.max(0.2, target - spoken)
  const fadeOutStart = Math.max(0, Math.min(spoken - 0.12, spoken * 0.92))
  run(ffmpeg, [
    "-y",
    "-i",
    wav,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-filter_complex",
    `[0:a]afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart}:d=0.1[a0];[1:a]atrim=0:${pad},asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[a]`,
    "-map",
    "[a]",
    "-t",
    String(target),
    padded,
  ])
  parts.push(padded)
  timing.push({ id: chapter.id, caption: chapter.caption, duration: target, voice: chapter.voice })
  if (existsSync(mp3)) unlinkSync(mp3)
  console.log(`${chapter.id}: ${spoken.toFixed(1)}s spoken → ${target.toFixed(1)}s (${voice} ${rate})`)
}

const listFile = path.join(outDir, "concat.txt")
writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"))
const master = path.join(outDir, "voiceover.wav")
run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", master])

const total = timing.reduce((s, c) => s + c.duration, 0)
writeFileSync(path.join(outDir, "timing.json"), JSON.stringify({ total, voice, rate, chapters: timing }, null, 2))

const bed = path.join(outDir, "ambient-bed.wav")
run(ffmpeg, [
  "-y",
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=98:sample_rate=44100:duration=${total}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=146.83:sample_rate=44100:duration=${total}`,
  "-filter_complex",
  "[0:a]volume=0.03[a0];[1:a]volume=0.018[a1];[a0][a1]amix=inputs=2:duration=longest,lowpass=f=700,afade=t=in:d=1.5,afade=t=out:st=" +
    Math.max(0, total - 2) +
    ":d=2[a]",
  "-map",
  "[a]",
  bed,
])

const mixed = path.join(outDir, "voiceover-mixed.wav")
run(ffmpeg, [
  "-y",
  "-i",
  master,
  "-i",
  bed,
  "-filter_complex",
  "[0:a]volume=1.05[v];[1:a]volume=0.16[m];[v][m]amix=inputs=2:duration=first:dropout_transition=2[a]",
  "-map",
  "[a]",
  mixed,
])
console.log(`Wrote ${master}`)
console.log(`Wrote ${mixed} (${total.toFixed(1)}s, ${voice})`)
