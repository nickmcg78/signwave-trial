import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Shape of the columns we care about on the mockup_jobs row. Kept narrow to
// the polling query — other columns (created_at, updated_at) aren't used here.
type JobRow = {
  status: 'pending' | 'processing' | 'complete' | 'failed'
  progress: string | null
  result_url: string | null
  error: string | null
}

// Poll every 3s. Edge function updates the row at each sign/attempt boundary,
// so 3s gives near-live progress text without hammering Supabase.
const POLL_INTERVAL_MS = 3000

export default function ResultPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()

  const [job, setJob] = useState<JobRow | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Keep the interval ID in a ref so the polling effect's cleanup can reach it
  // without re-running whenever we get new state.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!jobId) {
      setFetchError('Missing job ID.')
      return
    }

    let cancelled = false

    async function pollOnce() {
      const { data, error } = await supabase
        .from('mockup_jobs')
        .select('status, progress, result_url, error')
        .eq('id', jobId)
        .single()

      if (cancelled) return

      if (error || !data) {
        // Stop polling on a hard fetch error. Transient network blips are rare
        // enough on Supabase that a single failure is worth surfacing.
        setFetchError("We couldn't load this mockup. Please try again.")
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        return
      }

      const row = data as JobRow
      setJob(row)

      // Terminal states — stop polling.
      if (row.status === 'complete' || row.status === 'failed') {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }
    }

    // Fire once immediately so the UI doesn't sit empty for 3 seconds.
    pollOnce()
    intervalRef.current = setInterval(pollOnce, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [jobId])

  // --- Render branches --------------------------------------------

  if (fetchError) {
    return (
      <ErrorScreen
        message={fetchError}
        onRetry={() => navigate('/new')}
      />
    )
  }

  if (!job || job.status === 'pending' || job.status === 'processing') {
    return <LoadingScreen progressText={job?.progress ?? 'Starting up…'} />
  }

  if (job.status === 'failed') {
    return (
      <ErrorScreen
        message={job.error ?? 'Mockup generation failed.'}
        onRetry={() => navigate('/new')}
      />
    )
  }

  if (job.status === 'complete' && job.result_url) {
    return (
      <CompleteScreen
        jobId={jobId!}
        resultUrl={job.result_url}
        onNewMockup={() => navigate('/new')}
      />
    )
  }

  // Fallback — shouldn't hit this but keep the UI from going blank if the
  // job ends up in an unexpected state.
  return (
    <ErrorScreen
      message="Unexpected job state."
      onRetry={() => navigate('/new')}
    />
  )
}

// --- Sub-screens ----------------------------------------------------

// Reassuring status messages that rotate every 20s so the user knows the app
// is still working during the 1–3 minute generation window.
const LOADING_MESSAGES = [
  'Analysing building…',
  'Mapping sign placement…',
  'Matching colours and lighting…',
  'Placing signage…',
  'Rendering materials and shadows…',
  'Checking proportions…',
  'Finalising your mockup…',
  'Almost there — adding finishing touches…',
]

const ROTATE_INTERVAL_MS = 20_000

function LoadingScreen({ progressText }: { progressText: string }) {
  const [msgIndex, setMsgIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setMsgIndex(prev => (prev + 1) % LOADING_MESSAGES.length)
    }, ROTATE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="px-4 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
        <h1 className="text-base font-semibold text-gray-900">Generating mockup</h1>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {/* Pulsing blue dot as a lightweight spinner substitute. Tailwind's
            animate-pulse is fine on mobile and needs no extra CSS. */}
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-blue-600 opacity-20 animate-ping" />
          <div className="relative h-6 w-6 rounded-full bg-blue-600 animate-pulse" />
        </div>

        <p className="mt-8 text-lg font-semibold text-gray-900">
          Generating your mockup
        </p>
        <p className="mt-2 text-sm text-gray-500 max-w-xs">{progressText}</p>
        <p className="mt-4 text-sm text-blue-600 font-medium max-w-xs transition-opacity">
          {LOADING_MESSAGES[msgIndex]}
        </p>
        <p className="mt-6 text-xs text-gray-400 max-w-xs">
          This can take up to 2 minutes. Keep this tab open.
        </p>
      </main>
    </div>
  )
}

function CompleteScreen({
  jobId,
  resultUrl,
  onNewMockup,
}: {
  jobId: string
  resultUrl: string
  onNewMockup: () => void
}) {
  const { user } = useAuth()

  // Feedback form state
  const [rating, setRating] = useState<'up' | 'down' | null>(null)
  const [wouldUse, setWouldUse] = useState<'Yes' | 'Maybe' | 'No' | null>(null)
  const [comment, setComment] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = rating !== null && wouldUse !== null && !submitting

  async function handleSubmitFeedback() {
    if (!canSubmit) return
    setSubmitting(true)

    const { error } = await supabase.from('mockup_feedback').insert({
      job_id: jobId,
      user_id: user?.id ?? null,
      rating,
      would_use: wouldUse,
      comment: comment.trim() || null,
    })

    setSubmitting(false)
    if (!error) setFeedbackSent(true)
  }

  function handleDownload() {
    // iOS Safari ignores the `download` attribute on <a> tags — it just opens
    // the image in the same tab. Instead we convert the data URL to a Blob,
    // then open it in a new tab. On iOS the user can long-press → "Save to
    // Photos" or tap the share button — which is the native flow they expect.
    // On desktop/Android, the <a download> path still works, so we feature-detect.
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)

    if (isIOS) {
      // Convert data URL to blob
      const [header, base64] = resultUrl.split(',')
      const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png'
      const bytes = atob(base64)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      const blob = new Blob([arr], { type: mime })
      const blobUrl = URL.createObjectURL(blob)
      window.open(blobUrl, '_blank')
    } else {
      const a = document.createElement('a')
      a.href = resultUrl
      a.download = 'mockup.png'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="px-4 py-4 border-b border-gray-200 sticky top-0 bg-white z-10 flex items-center justify-between">
        <h1 className="text-base font-semibold text-gray-900">Mockup ready</h1>
        <Link
          to="/"
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Done
        </Link>
      </header>

      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto pb-32">
        {/* Mockup image */}
        <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50">
          <img
            src={resultUrl}
            alt="Generated sign mockup"
            className="w-full h-auto block"
          />
        </div>

        {/* Feedback form — shown until submitted */}
        {!feedbackSent ? (
          <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-4 space-y-5">
            <p className="text-sm font-semibold text-gray-900">
              Quick feedback before you download
            </p>

            {/* Thumbs up / down */}
            <div>
              <p className="text-sm text-gray-700 mb-2">How does it look?</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setRating('up')}
                  className={`flex-1 min-h-[60px] rounded-xl border text-lg font-medium transition-colors ${
                    rating === 'up'
                      ? 'border-green-600 bg-green-50 text-green-700'
                      : 'border-gray-300 bg-white text-gray-500 active:bg-gray-100'
                  }`}
                >
                  👍 Good
                </button>
                <button
                  type="button"
                  onClick={() => setRating('down')}
                  className={`flex-1 min-h-[60px] rounded-xl border text-lg font-medium transition-colors ${
                    rating === 'down'
                      ? 'border-red-600 bg-red-50 text-red-700'
                      : 'border-gray-300 bg-white text-gray-500 active:bg-gray-100'
                  }`}
                >
                  👎 Poor
                </button>
              </div>
            </div>

            {/* Would you send to a client? */}
            <div>
              <p className="text-sm text-gray-700 mb-2">Would you send this to a client?</p>
              <div className="flex gap-2">
                {(['Yes', 'Maybe', 'No'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setWouldUse(opt)}
                    className={`flex-1 min-h-[60px] rounded-xl border text-sm font-medium transition-colors ${
                      wouldUse === opt
                        ? 'border-blue-600 bg-blue-50 text-blue-700'
                        : 'border-gray-300 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            {/* Optional comment */}
            <div>
              <p className="text-sm text-gray-700 mb-2">Any comments? (optional)</p>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="e.g. colours are off, text too small…"
                style={{ fontSize: '16px' }}
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-base placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            <button
              onClick={handleSubmitFeedback}
              disabled={!canSubmit}
              className={`w-full min-h-[60px] rounded-xl text-sm font-semibold transition-colors ${
                canSubmit
                  ? 'bg-blue-600 text-white active:bg-blue-800'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {submitting ? 'Submitting…' : 'Submit & unlock download'}
            </button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-green-700 text-center font-medium">
            Thanks for your feedback!
          </p>
        )}
      </main>

      {/* Bottom bar — Download only appears after feedback */}
      <div
        className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200"
        style={{
          paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
          paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
          paddingTop: '0.75rem',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        <div className="max-w-lg mx-auto w-full grid grid-cols-2 gap-3">
          {feedbackSent ? (
            <button
              onClick={handleDownload}
              className="min-w-0 min-h-[60px] border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
            >
              Download
            </button>
          ) : (
            <div className="min-w-0 min-h-[60px] border border-gray-200 text-gray-300 font-semibold rounded-xl text-base flex items-center justify-center cursor-not-allowed">
              Download
            </div>
          )}
          <button
            onClick={onNewMockup}
            className="min-w-0 min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
          >
            New Mockup
          </button>
        </div>
      </div>
    </div>
  )
}

function ErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="px-4 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
        <h1 className="text-base font-semibold text-gray-900">Mockup failed</h1>
      </header>

      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto pb-32">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">
            Something went wrong
          </p>
          <p className="text-sm text-red-800 mt-2">{message}</p>
        </div>
      </main>

      <div
        className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200"
        style={{
          paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
          paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
          paddingTop: '0.75rem',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        <div className="max-w-lg mx-auto w-full">
          <button
            onClick={onRetry}
            className="w-full min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  )
}
