/** Timeline for the MailInsider product film — VO walkthrough @ 1.2x. */

export type VideoSceneId =
  | "hook"
  | "home"
  | "inbox"
  | "compose"
  | "ai_rag"
  | "send"
  | "engagement"
  | "reply"
  | "close"

export type VideoScene = {
  id: VideoSceneId
  start: number
  end: number
  title: string
  caption: string
  chapter: string
}

export const VIDEO_FPS = 30
export const VIDEO_DURATION = 84.5
export const FILM_SRC = "/video/mailinsider-product-film.mp4"

export const SCENES: VideoScene[] = [
  {
    id: "hook",
    start: 0,
    end: 10.09,
    chapter: "01",
    title: "The problem",
    caption: "You send admissions emails, LoRs, and marketing outreach — then wait in the dark.",
  },
  {
    id: "home",
    start: 10.09,
    end: 17.84,
    chapter: "02",
    title: "What MailInsider is",
    caption: "Gmail-native email client with engagement intelligence.",
  },
  {
    id: "inbox",
    start: 17.84,
    end: 27.22,
    chapter: "03",
    title: "Your Sent mailbox",
    caption: "A full pipeline — opens, link clicks, and document views on every thread.",
  },
  {
    id: "compose",
    start: 27.22,
    end: 35.05,
    chapter: "04",
    title: "Compose",
    caption: "Short precise messages with PDFs, tracked links, and a clean signature.",
  },
  {
    id: "ai_rag",
    start: 35.05,
    end: 50.38,
    chapter: "05",
    title: "AI and RAG",
    caption: "LLM drafts grounded in your career PDFs — you always review before send.",
  },
  {
    id: "send",
    start: 50.38,
    end: 57.43,
    chapter: "06",
    title: "Send through Gmail",
    caption: "Send via your Google account — honest acceptance, then tracking starts.",
  },
  {
    id: "engagement",
    start: 57.43,
    end: 66.74,
    chapter: "07",
    title: "Opens, links, and files",
    caption: "Filter by Opened, Links, or Files — badges on the same conversation.",
  },
  {
    id: "reply",
    start: 66.74,
    end: 73.49,
    chapter: "08",
    title: "Reply in-thread",
    caption: "Sync replies into the same thread with the full engagement timeline.",
  },
  {
    id: "close",
    start: 73.49,
    end: 84.47,
    chapter: "09",
    title: "Send with clarity",
    caption: "Compose with AI. Track engagement. Reply with clarity.",
  },
]

export function sceneAt(time: number): VideoScene {
  return SCENES.find((s) => time >= s.start && time < s.end) ?? SCENES[SCENES.length - 1]
}

export function progressInScene(time: number, scene: VideoScene): number {
  const span = Math.max(0.001, scene.end - scene.start)
  return Math.min(1, Math.max(0, (time - scene.start) / span))
}
