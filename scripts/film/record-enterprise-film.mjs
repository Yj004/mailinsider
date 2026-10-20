#!/usr/bin/env node
/**
 * Directed product film — real MailInsider mail UI only.
 * Mailbox → compose/send (loading) → opened → link click → document views.
 */
import { createRequire } from "node:module"
import { mkdir, rename, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const webRoot = path.join(root, "apps/web")
const outDir = path.join(webRoot, "dist-video")
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(webRoot, ".playwright-browsers")

const require = createRequire(path.join(webRoot, "package.json"))
const { chromium } = require("playwright")

const APP = process.env.PRODUCT_VIDEO_URL || "http://127.0.0.1:5178"
const EMAIL = "demo@mailinsider.app"
const PASSWORD = "DemoFilm2026!"
const chapters = JSON.parse(await readFile(path.join(__dirname, "chapters.json"), "utf8"))
const byId = Object.fromEntries(chapters.map((c) => [c.id, c]))

await mkdir(outDir, { recursive: true })
spawnSync(process.execPath, [path.join(__dirname, "ensure-demo.mjs")], { stdio: "inherit", cwd: root })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
})
const page = await context.newPage()

const FILM_CSS = `
  html.film-mode body {
    transform-origin: var(--cam-x, 50%) var(--cam-y, 42%);
    transform: scale(var(--cam-scale, 1));
    transition: transform 1.45s cubic-bezier(0.22, 1, 0.36, 1);
  }
  #film-bars-top, #film-bars-bottom {
    position: fixed; left: 0; right: 0; height: 48px; background: #202124; z-index: 100000;
    pointer-events: none;
  }
  #film-bars-top { top: 0; } #film-bars-bottom { bottom: 0; }
  #film-caption {
    position: fixed; left: 48px; right: 48px; bottom: 72px; z-index: 100001;
    padding: 14px 20px; border-radius: 14px;
    background: rgba(255, 255, 255, 0.95); color: #202124;
    border: 1px solid #e0e3e7;
    font: 500 17px/1.45 "Google Sans", "IBM Plex Sans", system-ui, sans-serif;
    backdrop-filter: blur(14px); pointer-events: none;
    box-shadow: 0 8px 24px rgba(60, 64, 67, 0.16);
    opacity: 0; transform: translateY(10px);
    transition: opacity 0.45s ease, transform 0.45s ease;
  }
  #film-caption.is-on { opacity: 1; transform: none; }
  #film-caption strong {
    display:block; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #0b57d0; margin-bottom: 5px; font-weight: 600;
  }
  #film-cursor {
    position: fixed; width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid #0b57d0; box-shadow: 0 0 0 6px rgba(11,87,208,0.16);
    background: rgba(11,87,208,0.1);
    z-index: 100002; pointer-events: none; opacity: 0;
    transition: left 0.55s cubic-bezier(0.22,1,0.36,1), top 0.55s cubic-bezier(0.22,1,0.36,1), opacity 0.25s;
  }
  #film-cursor.is-on { opacity: 1; }
`

async function injectChrome() {
  await page.addStyleTag({ content: FILM_CSS })
  await page.evaluate(() => {
    document.documentElement.classList.add("film-mode")
    if (!document.getElementById("film-bars-top")) {
      const t = document.createElement("div")
      t.id = "film-bars-top"
      const b = document.createElement("div")
      b.id = "film-bars-bottom"
      const c = document.createElement("div")
      c.id = "film-caption"
      c.innerHTML = "<strong></strong><span></span>"
      const cur = document.createElement("div")
      cur.id = "film-cursor"
      document.body.append(t, b, c, cur)
    }
  })
}

async function cam(scale, x = "50%", y = "42%") {
  await page.evaluate(
    ({ scale, x, y }) => {
      document.documentElement.style.setProperty("--cam-scale", String(scale))
      document.documentElement.style.setProperty("--cam-x", x)
      document.documentElement.style.setProperty("--cam-y", y)
    },
    { scale, x, y },
  )
}

async function caption(kicker, text) {
  await page.evaluate(
    ({ kicker, text }) => {
      const el = document.getElementById("film-caption")
      if (!el) return
      el.querySelector("strong").textContent = kicker
      el.querySelector("span").textContent = text
      el.classList.add("is-on")
    },
    { kicker, text },
  )
}

async function cursorTo(selector) {
  const box = await page.locator(selector).first().boundingBox().catch(() => null)
  if (!box) return
  await page.evaluate(
    ({ x, y }) => {
      const cur = document.getElementById("film-cursor")
      if (!cur) return
      cur.style.left = `${x - 9}px`
      cur.style.top = `${y - 9}px`
      cur.classList.add("is-on")
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
}

async function hold(s) {
  await page.waitForTimeout(Math.round(s * 1000))
}

async function typeSlow(locator, text, delay = 34) {
  await locator.click()
  await locator.fill("")
  await locator.pressSequentially(text, { delay })
}

async function openThreadBySubject(partial) {
  const row = page.locator(".gmail-thread").filter({ hasText: partial }).first()
  await row.waitFor({ timeout: 15_000 })
  await cursorTo(`.gmail-thread:has-text("${partial}")`)
  await hold(0.6)
  await row.click()
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 20_000 })
  await injectChrome()
}

async function showActivitySide() {
  const activity = page.getByRole("button", { name: /Activity/i })
  if (await activity.count()) {
    await activity.first().click().catch(() => undefined)
    await hold(0.4)
  }
  const side = page.locator("aside.gmail-conv-side, .gmail-conv-side")
  if (await side.count()) {
    await side.first().scrollIntoViewIfNeeded().catch(() => undefined)
  }
  const timeline = page.locator("ol.timeline, .timeline").first()
  if (await timeline.count()) {
    await timeline.scrollIntoViewIfNeeded().catch(() => undefined)
  }
}

async function showBoard({ eyebrow, title, lines = [], duration }) {
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600&display=swap');
    html,body{margin:0;height:100%;font-family:'Google Sans',system-ui,sans-serif;color:#202124;overflow:hidden;
      background:#f6f8fc;background-image:radial-gradient(ellipse 70% 50% at 80% 0%,rgba(26,115,232,.14),transparent 55%),
      radial-gradient(ellipse 40% 35% at 10% 90%,rgba(194,231,255,.55),transparent 50%)}
    .wrap{height:100%;display:grid;place-items:center;padding:72px 96px}
    .eyebrow{letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#0b57d0;margin:0 0 16px;font-weight:600;
      opacity:0;animation:rise .55s ease forwards}
    h1{font-weight:600;font-size:52px;line-height:1.08;letter-spacing:-.03em;margin:0;max-width:18ch;
      opacity:0;transform:translateY(16px);animation:rise .7s ease forwards .12s}
    .bar{width:0;height:3px;margin-top:22px;border-radius:99px;background:linear-gradient(90deg,#0b57d0,#4285f4,#34a853);
      animation:grow 1s cubic-bezier(.22,1,.36,1) forwards .2s}
    .lines{margin-top:28px;display:grid;gap:10px;max-width:620px}
    .line{padding:12px 16px;border-radius:12px;background:#fff;border:1px solid #e0e3e7;font-size:16px;color:#5f6368;
      opacity:0;transform:translateY(12px);animation:rise .6s ease forwards}
    .line:nth-child(1){animation-delay:.25s}.line:nth-child(2){animation-delay:.42s}.line:nth-child(3){animation-delay:.58s}
    @keyframes rise{to{opacity:1;transform:none}}
    @keyframes grow{to{width:160px}}
  </style></head><body>
  <div class="wrap"><div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <div class="bar"></div>
    <div class="lines">${lines.map((l) => `<div class="line">${l}</div>`).join("")}</div>
  </div></div>
  </body></html>`)
  await injectChrome()
  await cam(1.05, "46%", "42%")
  await hold(1)
  await cam(1.14, "50%", "45%")
  await hold(Math.max(0.8, duration - 1))
}

try {
  // Login
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" })
  await injectChrome()
  await cam(1.1, "70%", "50%")
  await typeSlow(page.locator('input[name="email"]'), EMAIL, 28)
  await typeSlow(page.locator('input[name="password"]'), PASSWORD, 24)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/app\/mail/, { timeout: 30_000 })
  await injectChrome()

  // ── 1 MAILBOX ──
  await caption("01 · Mailbox", byId.mailbox.caption)
  await page.waitForSelector(".gmail-thread", { timeout: 20_000 })
  await cam(1.0, "50%", "40%")
  await hold(2.0)
  await cam(1.2, "55%", "28%")
  await cursorTo(".gmail-thread")
  await hold(2.5)
  await cam(1.12, "42%", "18%")
  await cursorTo('.gmail-tabs, [role="tablist"]')
  await hold(2.0)
  await cam(1.06, "50%", "42%")
  await hold(Math.max(1, byId.mailbox.duration - 6.5))

  // ── 2 COMPOSE → SEND (loading) ──
  await page.goto(`${APP}/app/compose`, { waitUntil: "networkidle" })
  await injectChrome()
  await caption("02 · Compose & send", byId.send.caption)
  await cam(1.04, "50%", "36%")
  await hold(0.8)
  await typeSlow(page.locator('input[aria-label="To"]'), "alex@harbor.example", 32)
  await page.locator('input[aria-label="To"]').press("Enter")
  await hold(0.3)
  await typeSlow(
    page.locator(".field").filter({ hasText: "Subject" }).locator("input"),
    "Quick note — product walkthrough",
    26,
  )
  await page.locator("#composer-body").click()
  await page.locator("#composer-body").pressSequentially(
    "Hi Alex —\n\nSending this from MailInsider so you can see opens, link clicks, and document views on the same conversation.\n\n— Demo",
    { delay: 10 },
  )
  await cam(1.18, "55%", "55%")
  await hold(1.0)
  await cursorTo("button:has-text('Review and send')")
  await page.getByRole("button", { name: "Review and send" }).click()
  await hold(1.0)
  await cam(1.28, "50%", "55%")
  await caption("02 · Sending…", "Gmail accept — watch the send complete")
  const sendBtn = page.getByRole("button", { name: /^(Send|Sending)$/ })
  await cursorTo('button:has-text("Send"), button:has-text("Sending")')
  await sendBtn.click()
  // Hold on loading / transition
  await hold(1.8)
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 45_000 }).catch(() => undefined)
  await injectChrome()
  await cam(1.08, "48%", "40%")
  await hold(2.2)
  await hold(Math.max(0.5, byId.send.duration - 14))

  // ── 3 OPENED ──
  await page.goto(`${APP}/app/mail`, { waitUntil: "networkidle" })
  await injectChrome()
  await caption("03 · Opens", byId.opened.caption)
  await page.waitForSelector(".gmail-thread", { timeout: 20_000 })
  const openedTab = page.getByRole("tab", { name: /Opened/i })
  if (await openedTab.count()) {
    await cursorTo('.gmail-tab:has-text("Opened"), [role="tab"]:has-text("Opened")')
    await openedTab.click()
    await hold(1.4)
  }
  await cam(1.16, "55%", "32%")
  await hold(1.2)
  await openThreadBySubject("Northwind")
  await caption("03 · Open on the conversation", "Activity timeline — opened")
  await cam(1.08, "40%", "30%")
  await hold(1.5)
  await showActivitySide()
  await cam(1.32, "82%", "48%")
  await hold(3.5)
  // Highlight open-related timeline rows if present
  const openRow = page.locator(".tl-body strong, .pill").filter({ hasText: /open/i }).first()
  if (await openRow.count()) {
    await openRow.scrollIntoViewIfNeeded().catch(() => undefined)
    await hold(2.0)
  }
  await hold(Math.max(1, byId.opened.duration - 10))

  // ── 4 LINK CLICK (same Northwind thread has link) ──
  await caption("04 · Link click", byId.link.caption)
  await page.goto(`${APP}/app/mail`, { waitUntil: "networkidle" })
  await injectChrome()
  const linksTab = page.getByRole("tab", { name: /Links/i })
  if (await linksTab.count()) {
    await cursorTo('.gmail-tab:has-text("Links"), [role="tab"]:has-text("Links")')
    await linksTab.click()
    await hold(1.3)
  }
  await cam(1.14, "55%", "30%")
  await hold(1.0)
  await openThreadBySubject("Northwind")
  await showActivitySide()
  await cam(1.3, "82%", "52%")
  const linkRow = page.locator(".tl-body strong, .pill, .mi-tag-link").filter({ hasText: /link/i }).first()
  if (await linkRow.count()) {
    await linkRow.scrollIntoViewIfNeeded().catch(() => undefined)
    await hold(2.5)
  } else {
    await hold(2.5)
  }
  await cam(1.12, "50%", "45%")
  await hold(Math.max(1, byId.link.duration - 8))

  // ── 5 DOCUMENT VIEWS ──
  await caption("05 · Document views", byId.docs.caption)
  await page.goto(`${APP}/app/mail`, { waitUntil: "networkidle" })
  await injectChrome()
  const filesTab = page.getByRole("tab", { name: /Files/i })
  if (await filesTab.count()) {
    await cursorTo('.gmail-tab:has-text("Files"), [role="tab"]:has-text("Files")')
    await filesTab.click()
    await hold(1.3)
  }
  await cam(1.14, "55%", "30%")
  await hold(1.0)
  // Prefer signed order form sample
  const fileThread = page.locator(".gmail-thread").filter({ hasText: /order form|Signed|Brightpath|document|PDF|file/i }).first()
  if (await fileThread.count()) {
    await fileThread.click()
  } else {
    await page.locator(".gmail-thread").first().click()
  }
  await page.waitForURL(/\/app\/mail\/.+/, { timeout: 20_000 }).catch(() => undefined)
  await injectChrome()
  await showActivitySide()
  await cam(1.28, "80%", "48%")
  const docRow = page.locator(".tl-body strong, .pill, .mi-tag-file").filter({ hasText: /document|page|file|view/i }).first()
  if (await docRow.count()) {
    await docRow.scrollIntoViewIfNeeded().catch(() => undefined)
    await hold(3.0)
  } else {
    await hold(3.0)
  }
  await cam(1.1, "45%", "40%")
  await hold(Math.max(1.5, byId.docs.duration - 9))

  // ── 6 CLOSE ──
  await showBoard({
    eyebrow: "MailInsider",
    title: byId.close.caption,
    lines: ["Send from the mailbox", "See opens, links, and document views", "Reply in the same thread"],
    duration: byId.close.duration,
  })
  await caption("MailInsider", byId.close.caption)
} catch (err) {
  console.error(err)
  await page.screenshot({ path: path.join(outDir, "enterprise-film-error.png"), fullPage: true }).catch(() => undefined)
  throw err
} finally {
  await context.close()
  await browser.close()
}

const { statSync } = await import("node:fs")
const files = (await readdir(outDir))
  .filter((f) => f.endsWith(".webm"))
  .filter((f) => !/mailinsider-(product-film|enterprise-silent|live-silent)/.test(f))
  .map((f) => ({ f, mtime: statSync(path.join(outDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
if (!files.length) throw new Error("No WebM produced")
const latest = path.join(outDir, files[0].f)
const target = path.join(outDir, "mailinsider-enterprise-silent.webm")
await rename(latest, target)
await writeFile(path.join(outDir, "enterprise-film-chapters.json"), JSON.stringify(chapters, null, 2))
console.log(`Wrote ${target}`)
