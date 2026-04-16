import { useRef, useState, useEffect, useCallback } from 'react'

/**
 * Percentage-based rectangle describing where the sign should go.
 * Resolution-independent — the edge function converts to pixels
 * using the actual image dimensions before building the mask.
 */
export type SignZone = {
  xPct: number // left edge as % of image width  (0–100)
  yPct: number // top edge as % of image height (0–100)
  wPct: number // width as % of image width
  hPct: number // height as % of image height
}

type Props = {
  photoUrl: string
  onZoneSelected: (zone: SignZone | null) => void
  initialZone?: SignZone | null
}

// Minimum drag size in display pixels to count as a real rectangle
// (filters out accidental taps)
const MIN_RECT_PX = 10

/**
 * SignZoneSelector — draw-a-box overlay on the building photo.
 *
 * Renders the building photo at full available width with a transparent
 * canvas on top. The user taps/clicks and drags to draw a rectangle
 * that defines where the sign should be placed. Works with both mouse
 * and touch events (iOS Safari compatible).
 */
export default function SignZoneSelector({ photoUrl, onZoneSelected, initialZone }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  // Track the displayed image size (may differ from natural size)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)

  // Drawing state — stored in refs to avoid re-renders mid-drag
  const dragging = useRef(false)
  const startPt = useRef({ x: 0, y: 0 })
  const currentPt = useRef({ x: 0, y: 0 })

  // The finalised rectangle (display-pixel coords relative to the image)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // ── helpers ──────────────────────────────────────────────────────

  /** Get pointer position relative to the canvas element. */
  function pointerPos(
    e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent,
  ): { x: number; y: number } {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const br = canvas.getBoundingClientRect()
    const clientX = 'touches' in e ? (e as TouchEvent).touches[0]?.clientX ?? (e as TouchEvent).changedTouches[0]?.clientX ?? 0 : (e as MouseEvent).clientX
    const clientY = 'touches' in e ? (e as TouchEvent).touches[0]?.clientY ?? (e as TouchEvent).changedTouches[0]?.clientY ?? 0 : (e as MouseEvent).clientY
    return { x: clientX - br.left, y: clientY - br.top }
  }

  /** Draw the current rectangle onto the canvas. */
  const drawRect = useCallback((x: number, y: number, w: number, h: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Semi-transparent blue fill
    ctx.fillStyle = 'rgba(59, 130, 246, 0.25)'
    ctx.fillRect(x, y, w, h)

    // Blue border
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 3])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])
  }, [])

  /** Convert a display-pixel rect to a SignZone (percentages). */
  function rectToZone(r: { x: number; y: number; w: number; h: number }): SignZone | null {
    if (!imgSize) return null
    return {
      xPct: (r.x / imgSize.w) * 100,
      yPct: (r.y / imgSize.h) * 100,
      wPct: (r.w / imgSize.w) * 100,
      hPct: (r.h / imgSize.h) * 100,
    }
  }

  /** Convert a SignZone back to display-pixel rect. */
  function zoneToRect(z: SignZone): { x: number; y: number; w: number; h: number } | null {
    if (!imgSize) return null
    return {
      x: (z.xPct / 100) * imgSize.w,
      y: (z.yPct / 100) * imgSize.h,
      w: (z.wPct / 100) * imgSize.w,
      h: (z.hPct / 100) * imgSize.h,
    }
  }

  /** Normalise a rect so w and h are always positive. */
  function normalise(x: number, y: number, w: number, h: number) {
    return {
      x: w < 0 ? x + w : x,
      y: h < 0 ? y + h : y,
      w: Math.abs(w),
      h: Math.abs(h),
    }
  }

  // ── image load → size the canvas ─────────────────────────────────

  function handleImageLoad() {
    const img = imgRef.current
    if (!img) return
    const w = img.clientWidth
    const h = img.clientHeight
    setImgSize({ w, h })

    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = w
      canvas.height = h
    }
  }

  // Resize canvas if the viewport changes (e.g. orientation flip on mobile)
  useEffect(() => {
    function handleResize() {
      const img = imgRef.current
      if (!img) return
      const w = img.clientWidth
      const h = img.clientHeight
      setImgSize({ w, h })
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = w
        canvas.height = h
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Restore initial zone when imgSize becomes available
  useEffect(() => {
    if (initialZone && imgSize) {
      const r = zoneToRect(initialZone)
      if (r) {
        setRect(r)
        drawRect(r.x, r.y, r.w, r.h)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize, initialZone])

  // Redraw the finalised rect whenever imgSize changes (e.g. after resize)
  useEffect(() => {
    if (rect && imgSize) {
      drawRect(rect.x, rect.y, rect.w, rect.h)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize])

  // ── pointer handlers ─────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function onStart(e: MouseEvent | TouchEvent) {
      e.preventDefault()
      const pos = pointerPos(e)
      dragging.current = true
      startPt.current = pos
      currentPt.current = pos
    }

    function onMove(e: MouseEvent | TouchEvent) {
      if (!dragging.current) return
      e.preventDefault()
      const pos = pointerPos(e)
      currentPt.current = pos

      const raw = {
        x: startPt.current.x,
        y: startPt.current.y,
        w: pos.x - startPt.current.x,
        h: pos.y - startPt.current.y,
      }
      const n = normalise(raw.x, raw.y, raw.w, raw.h)
      drawRect(n.x, n.y, n.w, n.h)
    }

    function onEnd(e: MouseEvent | TouchEvent) {
      if (!dragging.current) return
      e.preventDefault()
      dragging.current = false

      const pos = pointerPos(e)
      const raw = {
        x: startPt.current.x,
        y: startPt.current.y,
        w: pos.x - startPt.current.x,
        h: pos.y - startPt.current.y,
      }
      const n = normalise(raw.x, raw.y, raw.w, raw.h)

      // Ignore tiny accidental taps
      if (n.w < MIN_RECT_PX || n.h < MIN_RECT_PX) {
        const ctx = canvas?.getContext('2d')
        if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
        return
      }

      setRect(n)
      drawRect(n.x, n.y, n.w, n.h)

      const zone = rectToZone(n)
      if (zone) onZoneSelected(zone)
    }

    // Mouse events
    canvas.addEventListener('mousedown', onStart)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseup', onEnd)

    // Touch events — passive: false so preventDefault() works on iOS
    canvas.addEventListener('touchstart', onStart, { passive: false })
    canvas.addEventListener('touchmove', onMove, { passive: false })
    canvas.addEventListener('touchend', onEnd, { passive: false })

    return () => {
      canvas.removeEventListener('mousedown', onStart)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseup', onEnd)
      canvas.removeEventListener('touchstart', onStart)
      canvas.removeEventListener('touchmove', onMove)
      canvas.removeEventListener('touchend', onEnd)
    }
    // Re-bind when imgSize changes so rectToZone uses current dimensions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize, drawRect, onZoneSelected])

  // ── clear ────────────────────────────────────────────────────────

  function handleClear() {
    setRect(null)
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    onZoneSelected(null)
  }

  // ── render ───────────────────────────────────────────────────────

  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-gray-700 mb-2">
        Draw a box where you want the sign to go
      </p>

      <div ref={containerRef} className="relative inline-block w-full">
        <img
          ref={imgRef}
          src={photoUrl}
          alt="Building — draw sign zone"
          onLoad={handleImageLoad}
          className="w-full rounded-2xl border border-gray-200 select-none"
          draggable={false}
        />
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 w-full h-full rounded-2xl cursor-crosshair touch-none"
        />
      </div>

      {rect && (
        <button
          type="button"
          onClick={handleClear}
          className="mt-3 w-full min-h-[48px] border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
        >
          Clear &amp; redraw
        </button>
      )}

      {!rect && imgSize && (
        <p className="mt-2 text-xs text-gray-400 text-center">
          Tap and drag on the photo above
        </p>
      )}
    </div>
  )
}
