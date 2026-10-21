import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { FILM_SRC, SCENES, VIDEO_DURATION, sceneAt } from "./productVideoData"

export function ProductVideoPage() {
  const [params] = useSearchParams()
  const auto = params.get("autoplay") === "1" || params.get("record") === "1"
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(VIDEO_DURATION)

  useEffect(() => {
    document.title = "MailInsider — Product film"
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !auto) return
    v.play().then(() => setPlaying(true)).catch(() => undefined)
  }, [auto])

  const scene = useMemo(() => sceneAt(time), [time])

  const seek = useCallback((next: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.min(duration, Math.max(0, next))
    setTime(v.currentTime)
  }, [duration])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.ended || v.currentTime >= duration - 0.05) {
      v.currentTime = 0
    }
    if (v.paused) {
      v.play().then(() => setPlaying(true)).catch(() => undefined)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  const toggleFullscreen = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    else el.requestFullscreen?.().catch(() => undefined)
  }

  return (
    <div className="pv-page">
      <div className="pv-chrome">
        <Link to="/" className="pv-brand">
          Mail<span style={{ color: "#ea4335" }}>I</span>
          <span style={{ color: "#fbbc04" }}>n</span>
          <span style={{ color: "#34a853" }}>s</span>
          <span style={{ color: "#4285f4" }}>ider</span>
        </Link>
        <span className="pv-chrome-label">Product film · mailbox → send → opens · links · docs</span>
        <div className="pv-chrome-actions">
          <button type="button" className="pv-btn ghost" onClick={toggleFullscreen}>
            Fullscreen
          </button>
          <Link className="pv-btn" to="/waitlist">
            Join waitlist
          </Link>
        </div>
      </div>

      <div className="pv-stage-wrap" ref={stageRef}>
        <div className="pv-stage" aria-label="MailInsider product video">
          <video
            ref={videoRef}
            className="pv-video"
            src={FILM_SRC}
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d) && d > 0) setDuration(d)
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onClick={togglePlay}
          />
          <div className="pv-caption" key={scene.id}>
            <span className="pv-caption-kicker">
              {scene.chapter} · {scene.title}
            </span>
            <p>{scene.caption}</p>
          </div>
        </div>
      </div>

      <div className="pv-controls">
        <button type="button" className="pv-play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>
          {playing ? "Pause" : "Play"}
        </button>
        <div className="pv-timeline">
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={Math.min(time, duration)}
            aria-label="Seek"
            onChange={(e) => {
              seek(Number(e.target.value))
            }}
          />
          <div className="pv-chapters">
            {SCENES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === scene.id ? "is-active" : ""}
                style={{ left: `${(s.start / duration) * 100}%` }}
                title={s.title}
                onClick={() => {
                  seek(s.start)
                  videoRef.current?.play().then(() => setPlaying(true)).catch(() => undefined)
                }}
              />
            ))}
          </div>
        </div>
        <span className="pv-clock">
          {formatClock(time)} / {formatClock(duration)}
        </span>
      </div>

      <ol className="pv-chapters-list">
        {SCENES.map((s) => (
          <li key={s.id} className={s.id === scene.id ? "is-active" : ""}>
            <button
              type="button"
              onClick={() => {
                seek(s.start)
                videoRef.current?.play().then(() => setPlaying(true)).catch(() => undefined)
              }}
            >
              <span>{s.chapter}</span>
              <strong>{s.title}</strong>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

function formatClock(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}
