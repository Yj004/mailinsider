#!/usr/bin/env node
/** Patch full-walkthrough-motion.html CSS scene/caption windows from audio/timing.json */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const timing = JSON.parse(readFileSync(path.join(__dirname, "audio/timing.json"), "utf8"))
const htmlPath = path.join(__dirname, "full-walkthrough-motion.html")
let html = readFileSync(htmlPath, "utf8")

const chapters = timing.chapters
const total = timing.total
let t = 0
const scRules = []
const ltRules = []
for (let i = 0; i < chapters.length; i++) {
  const d = chapters[i].duration
  const isLast = i === chapters.length - 1
  const anim = isLast ? "scHold" : "sc"
  const ltAnim = isLast ? "ltHold" : "ltIO"
  scRules.push(`#s${i}{animation:${anim} ${d.toFixed(2)}s ${t.toFixed(2)}s both}`)
  ltRules.push(`#lt${i}{animation:${ltAnim} ${d.toFixed(2)}s ${t.toFixed(2)}s both}`)
  t += d
}

html = html.replace(/--T:\s*[^;]+;/, `--T: ${total.toFixed(2)}s;`)
html = html.replace(
  /\/\* chapter windows from chapters\.json \*\/[\s\S]*?@keyframes ltIO/,
  `/* chapter windows (synced) */\n    ${ltRules.join(" ")}\n    @keyframes ltIO`,
)
// Replace scene animation block
html = html.replace(
  /\.scene\{[^}]+\}[\s\S]*?#s0\{[^}]+\}[\s\S]*?#s8\{[^}]+\}/,
  `.scene{position:absolute;inset:0;opacity:0;pointer-events:none}\n    ${scRules.join(" ")}`,
)

writeFileSync(htmlPath, html)
console.log(`Synced ${chapters.length} scenes to ${total.toFixed(1)}s`)
