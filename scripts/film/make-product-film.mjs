#!/usr/bin/env node
/** Enterprise film pipeline: demo → neural VO → directed capture → mux. */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")

function run(script) {
  console.log(`\n=== ${path.basename(script)} ===`)
  const res = spawnSync(process.execPath, [script], { stdio: "inherit", cwd: root, env: process.env })
  if (res.status !== 0) process.exit(res.status || 1)
}

run(path.join(__dirname, "ensure-demo.mjs"))
run(path.join(__dirname, "generate-voiceover.mjs"))
run(path.join(__dirname, "record-enterprise-film.mjs"))
run(path.join(__dirname, "build-product-film.mjs"))
console.log("\nEnterprise film ready: apps/web/dist-video/mailinsider-product-film.mp4")
