import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { API_URL } from "../api"
import { BrandLockup } from "../components/BrandMark"

type Meta = {
  filename: string
  content_type: string
  size_bytes: number
  disclosure: string
}

export function ViewerPage() {
  const { token = "" } = useParams()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState("")
  const [text, setText] = useState("")
  const [imageUrl, setImageUrl] = useState("")
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [pdfReady, setPdfReady] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pdfRef = useRef<PdfDoc | null>(null)
  const started = useRef(false)

  useEffect(() => {
    let cancel = false
    fetch(`${API_URL}/api/v1/public/documents/${token}`)
      .then(async (response) => {
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.error?.message || "This document link is unavailable.")
        return data as Meta
      })
      .then(async (next) => {
        if (cancel) return
        setMeta(next)
        if (next.content_type === "text/plain") {
          const file = await fetch(`${API_URL}/api/v1/public/documents/${token}/file`)
          if (!file.ok) throw new Error("This document link is unavailable.")
          setText(await file.text())
          record("document_view_started")
          record("document_page_viewed", 1)
        } else if (next.content_type.startsWith("image/")) {
          const file = await fetch(`${API_URL}/api/v1/public/documents/${token}/file`)
          if (!file.ok) throw new Error("This document link is unavailable.")
          setImageUrl(URL.createObjectURL(await file.blob()))
        } else if (next.content_type === "application/pdf") {
          const file = await fetch(`${API_URL}/api/v1/public/documents/${token}/file`)
          if (!file.ok) throw new Error("This document link is unavailable.")
          const pdfjs = await import("pdfjs-dist")
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
          const pdf = (await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise) as unknown as PdfDoc
          if (cancel) return
          pdfRef.current = pdf
          setPages(pdf.numPages)
          setPdfReady(true)
        }
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "This document link is unavailable.")
      })
    return () => {
      cancel = true
    }
  }, [token])

  useEffect(() => {
    if (!pdfReady || !pdfRef.current) return
    draw(pdfRef.current, 1).then(() => {
      record("document_view_started")
      record("document_page_viewed", 1)
    })
  }, [pdfReady])

  async function draw(pdf: PdfDoc, pageNumber: number) {
    const canvas = canvasRef.current
    if (!canvas) return
    const pdfPage = await pdf.getPage(pageNumber)
    const viewport = pdfPage.getViewport({ scale: 1.3 })
    canvas.width = viewport.width
    canvas.height = viewport.height
    const context = canvas.getContext("2d")
    if (!context) return
    await pdfPage.render({ canvasContext: context, viewport }).promise
  }

  function record(type: string, pageNumber?: number) {
    if (type === "document_view_started") {
      if (started.current) return
      started.current = true
    }
    fetch(`${API_URL}/api/v1/public/documents/${token}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, page: pageNumber }),
    }).catch(() => undefined)
  }

  async function changePage(next: number) {
    if (!pdfRef.current || next < 1 || next > pages) return
    setPage(next)
    await draw(pdfRef.current, next)
    record("document_page_viewed", next)
  }

  async function download() {
    if (!meta) return
    record("document_download_requested")
    const response = await fetch(`${API_URL}/api/v1/public/documents/${token}/file?download=1`)
    if (!response.ok) return
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = meta.filename
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <div>
          <strong>{meta?.filename || "Document"}</strong>
          <div className="disclosure">{meta?.disclosure || "The sender can see that this document was opened and which pages were displayed."}</div>
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          {meta ? (
            <button className="btn" onClick={download}>
              Download
            </button>
          ) : null}
          <BrandLockup to="/login" size={20} />
        </div>
      </header>
      <div className="viewer-stage">
        {error ? <div className="card">{error}</div> : null}
        {text ? <pre className="viewer-sheet">{text}</pre> : null}
        {imageUrl ? (
          <img
            className="viewer-canvas"
            alt={meta?.filename || "Document"}
            src={imageUrl}
            onLoad={() => {
              record("document_view_started")
              record("document_page_viewed", 1)
            }}
          />
        ) : null}
        {meta?.content_type === "application/pdf" ? <canvas ref={canvasRef} className="viewer-canvas" /> : null}
      </div>
      {meta?.content_type === "application/pdf" && pages > 1 ? (
        <div className="viewer-controls">
          <button type="button" onClick={() => changePage(page - 1)} disabled={page <= 1}>
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button type="button" onClick={() => changePage(page + 1)} disabled={page >= pages}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  )
}

type PdfDoc = {
  numPages: number
  getPage: (pageNumber: number) => Promise<{
    getViewport: (options: { scale: number }) => { width: number; height: number }
    render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> }
  }>
}
