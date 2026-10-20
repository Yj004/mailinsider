#!/usr/bin/env node
/**
 * Enterprise product film: real MailInsider UI + camera zooms + captions.
 * Pair with generate-voiceover.mjs and mux via build-product-film.mjs.
 */
import { createRequire } from "node:module"
import { mkdir, rename, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const webRoot = path.join(root, "apps/web")
const filmDir = path.join(__dirname)
const outDir = path.join(webRoot, "dist-video")
const browsersPath = path.join(webRoot, ".playwright-browsers")
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

const APP = process.env.PRODUCT_VIDEO_URL || "http://127.0.0.1:5178"
const EMAIL = "demo@mailinsider.app"
const PASSWORD = "DemoFilm2026!"
const chapters = JSON.parse(await readFile(path.join(filmDir, "chapters.json"), "utf8"))

await mkdir(outDir, { recursive: true })
spawnSync("node", [path.join(filmDir, "ensure-demo.mjs")], { stdio: "inherit", cwd: root })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()

async function injectFilmChrome() {
  await page.addStyleTag({
    content: `
      html.film-mode body {
        transform-origin: var(--cam-x, 50%) var(--cam-y, 45%);
        transform: scale(var(--cam-scale, 1));
        transition: transform 1.35s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #film-caption {
        position: fixed; left: 48px; right: 48px; bottom: 42px; z-index: 99999;
        padding: 16px 20px; border-radius: 14px;
        background: rgba(7, 26, 31, 0.78); color: #f8fafc;
        border: 1px solid rgba(94, 234, 212, 0.28);
        font: 500 18px/1.45 "IBM Plex Sans", system-ui, sans-serif;
        backdrop-filter: blur(12px);
        pointer-events: none;
        box-shadow: 0 18px 50px rgba(0,0,0,0.35);
      }
      #film-caption strong {
        display:block; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
        color: #5eead4; margin-bottom: 6px; font-weight: 600;
      }
      #film-bars-top, #film-bars-bottom {
        position: fixed; left: 0; right: 0; height: 54px; background: #000; z-index: 99998;
        pointer-events: none;
      }
      #film-bars-top { top: 0; }
      #film-bars-bottom { bottom: 0; }
    `,
  })
  await page.evaluate(() => {
    document.documentElement.classList.add("film-mode")
    if (!document.getElementById("film-bars-top")) {
      const t = document.createElement("div")
      t.id = "film-bars-top"
      const b = document.createElement("div")
      b.id = "film-bars-bottom"
      const c = document.createElement("div")
      c.id = "film-caption"
      c.innerHTML = "<strong>MailInsider</strong><span></span>"
      document.body.append(t, b, c)
    }
  })
}

async function cam(scale, x = "50%", y = "42%") {
  await page.evaluate(
    ({ scale, x, y }) => {
      const rootEl = document.documentElement
      rootEl.style.setProperty("--cam-scale", String(scale))
      rootEl.style.setProperty("--cam-x", x)
      rootEl.style.setProperty("--cam-y", y)
    },
    { scale, x, y },
  )
}

async function caption(chapter, text) {
  await page.evaluate(
    ({ chapter, text }) => {
      const el = document.getElementById("film-caption")
      if (!el) return
      el.querySelector("strong").textContent = chapter
      el.querySelector("span").textContent = text
    },
    { chapter, text },
  )
}

async function hold(seconds) {
  await page.waitForTimeout(Math.round(seconds * 1000))
}

async function typeSlow(locator, text, delay = 38) {
  await locator.click()
  await locator.fill("")
  await locator.pressSequentially(text, { delay })
}

const log = []
function mark(id) {
  log.push({ id, at: Date.now() })
  console.log("•", id)
}

try {
  // —— HOME ——
  mark("home")
  await page.goto(`${APP}/`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("01 · Product", chapters[0].caption)
  await cam(1.08, "38%", "32%")
  await hold(3.2)
  await cam(1.22, "72%", "48%")
  await hold(3.2)
  await cam(1.05, "50%", "40%")
  await hold(chapters[0].duration - 6.4)

  // —— LOGIN ——
  mark("login")
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("02 · Sign in", chapters[1].caption)
  await cam(1.18, "50%", "48%")
  await hold(1.2)
  const email = page.locator('input[name="email"]')
  const password = page.locator('input[name="password"]')
  await typeSlow(email, EMAIL, 42)
  await hold(0.4)
  await typeSlow(password, PASSWORD, 36)
  await cam(1.28, "50%", "62%")
  await hold(0.8)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/app\/mail/, { timeout: 30_000 })
  await injectFilmChrome()
  await hold(Math.max(1, chapters[1].duration - 8))

  // —— MAIL LIST ——
  mark("mail")
  await caption("03 · Sent", chapters[2].caption)
  await cam(1.12, "58%", "40%")
  await page.waitForSelector(".gmail-thread, .gmail-thread-list", { timeout: 20_000 })
  await hold(3)
  await cam(1.3, "55%", "28%")
  await hold(3.5)
  await cam(1.15, "50%", "45%")
  await hold(chapters[2].duration - 6.5)

  // —— MESSAGE DETAIL ——
  mark("detail")
  const thread = page.locator(".gmail-thread").first()
  await thread.click()
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 20_000 })
  await injectFilmChrome()
  await caption("04 · Conversation", chapters[3].caption)
  await cam(1.1, "45%", "30%")
  await hold(3)
  await cam(1.35, "42%", "22%")
  await hold(3.5)
  const activity = page.locator("text=Activity").first()
  if (await activity.count()) {
    await activity.click().catch(() => undefined)
  }
  await cam(1.25, "78%", "50%")
  await hold(3.5)
  await cam(1.08, "50%", "55%")
  await hold(Math.max(1, chapters[3].duration - 10))

  // —— COMPOSE ——
  mark("compose")
  await page.goto(`${APP}/app/compose`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("05 · Compose", chapters[4].caption)
  await cam(1.12, "50%", "40%")
  await hold(1)
  const toInput = page.locator('input[aria-label="To"]')
  await typeSlow(toInput, "priya@northwind.example", 40)
  await toInput.press("Enter")
  await hold(0.5)
  const subjectBox = page.locator(".field").filter({ hasText: "Subject" }).locator("input")
  await typeSlow(subjectBox, "Q3 rollout — one-pager", 32)
  await hold(0.4)
  const body = page.locator("#composer-body")
  await body.click()
  await body.pressSequentially(
    "Hi Priya —\n\nSharing a quick note on the Q3 rollout. Happy to walk through it this week.\n\nBest,\nDemo",
    { delay: 16 },
  )
  await cam(1.22, "55%", "58%")
  await hold(1.5)
  await page.getByRole("button", { name: "Review and send" }).click()
  await hold(1.2)
  await cam(1.3, "50%", "55%")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 45_000 }).catch(() => undefined)
  await injectFilmChrome()
  await hold(Math.max(1, chapters[4].duration - 16))

  // —— SENT LIST AGAIN ——
  mark("sent")
  await page.goto(`${APP}/app/mail`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("06 · Sent", chapters[5].caption)
  await cam(1.18, "52%", "32%")
  await hold(4)
  await cam(1.08, "50%", "45%")
  await hold(chapters[5].duration - 4)

  // —— REPLY / FOLLOW-UP UI ——
  mark("reply")
  await page.locator(".gmail-thread").first().click()
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 20_000 })
  await injectFilmChrome()
  await caption("07 · Same thread", chapters[6].caption)
  await cam(1.12, "48%", "35%")
  await hold(3)
  const replyBox = page.locator(".gmail-inline-reply textarea, textarea.gmail-inline-body")
  if (await replyBox.count()) {
    await cam(1.32, "50%", "78%")
    await replyBox.first().click()
    await replyBox.first().pressSequentially("Thanks — Thursday works. I'll send a hold.", { delay: 22 })
    await hold(2)
    // Don't actually send again to keep film shorter / avoid spam — show intent
    await cam(1.2, "35%", "82%")
  }
  const follow = page.locator(".gmail-conv-follow").first()
  if (await follow.count()) {
    await follow.scrollIntoViewIfNeeded().catch(() => undefined)
    await cam(1.28, "55%", "28%")
  } else {
    const followText = page.getByText("Follow-up", { exact: false }).first()
    if (await followText.count()) {
      await followText.scrollIntoViewIfNeeded().catch(() => undefined)
      await cam(1.28, "55%", "28%")
    }
  }
  await hold(Math.max(2, chapters[6].duration - 8))

  // —— FOLLOW-UPS ——
  mark("followups")
  await page.goto(`${APP}/app/follow-ups`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("08 · Follow-ups", chapters[7].caption)
  await cam(1.14, "50%", "40%")
  await hold(5)
  await cam(1.24, "40%", "55%")
  await hold(chapters[7].duration - 5)

  // —— INTEGRATIONS ——
  mark("integrations")
  await page.goto(`${APP}/app/integrations`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("09 · Gmail", chapters[8].caption)
  await cam(1.16, "48%", "42%")
  await hold(5)
  await cam(1.3, "50%", "35%")
  await hold(chapters[8].duration - 5)

  // —— CLOSE on marketing ——
  mark("close")
  await page.goto(`${APP}/`, { waitUntil: "networkidle" })
  await injectFilmChrome()
  await caption("10 · MailInsider", chapters[9].caption)
  await cam(1.1, "40%", "35%")
  await hold(3)
  await cam(1.2, "50%", "45%")
  await hold(chapters[9].duration - 3)
} catch (err) {
  console.error("Film recording failed:", err)
  await page.screenshot({ path: path.join(outDir, "film-error.png"), fullPage: true }).catch(() => undefined)
  throw err
} finally {
  await context.close()
  await browser.close()
}

const files = (await readdir(outDir)).filter((f) => f.endsWith(".webm") && !f.includes("mailinsider-live"))
files.sort()
if (!files.length) throw new Error("No WebM produced")
const latest = path.join(outDir, files[files.length - 1])
const target = path.join(outDir, "mailinsider-live-silent.webm")
await rename(latest, target)
await writeFile(path.join(outDir, "film-log.json"), JSON.stringify(log, null, 2))
console.log(`Wrote ${target}`)
