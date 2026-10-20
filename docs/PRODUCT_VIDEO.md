# MailInsider enterprise product film

Directed ~80s explainer: cinematic hook/problem cards → **real product UI** → neural female voiceover (Jenny) + ambient bed.

Storyboard: [`PRODUCT_FILM_STORYBOARD.md`](./PRODUCT_FILM_STORYBOARD.md)

## Demo credentials

- Email: `demo@mailinsider.app`
- Password: `DemoFilm2026!`

## Produce

API `:8765` · web `:5178` with `VITE_API_URL=http://127.0.0.1:8765`

```bash
node scripts/film/make-product-film.mjs
```

**Deliverable:** `apps/web/dist-video/mailinsider-product-film.mp4`

Pipeline steps:

1. `ensure-demo.mjs` — demo account, Gmail demo, sample mail  
2. `generate-voiceover.mjs` — Edge `en-US-JennyNeural` + original ambient bed  
3. `record-enterprise-film.mjs` — directed capture with zooms / cursor focus  
4. `build-product-film.mjs` — H.264 + AAC mux  

## Honest scope

Shows only shipping capabilities: Gmail connect (demo), Sent, engagement tags, timeline, compose/send, same-thread reply UI, follow-up cadence.

## Voiceover script (for narration track)

| Time | Line |
|------|------|
| 0:00 | MailInsider — outreach that still feels human, with engagement you can trust. |
| 0:08 | Most teams send from Gmail, then guess. Opens, clicks, and replies live in different places. |
| 0:18 | Sign in to your workspace. One secure login — your Gmail and conversations, ready in seconds. |
| 0:28 | Connect Gmail once. Send as yourself, and sync recipient replies from the same thread. |
| 0:40 | Compose with intent. Write a personal note, attach a PDF, toggle tracking — send through Gmail. |
| 0:54 | Sent, not assumed. Acceptance is recorded honestly. Sent becomes your system of record. |
| 1:04 | See what happened. Opens, link requests, and document views — labeled clearly. |
| 1:16 | When they reply in Gmail, MailInsider syncs it here. Answer in place — same thread. |
| 1:30 | Follow-up cadence. Three days, seven days, end, or dead mail — without leaving the conversation. |
| 1:38 | Send with clarity. Connect Gmail and start with MailInsider. |

## Chapters

1. Open  
2. Problem  
3. Login  
4. Connect Gmail  
5. Compose  
6. Sent  
7. Tracking  
8. Replies  
9. Follow-ups  
10. Close  
