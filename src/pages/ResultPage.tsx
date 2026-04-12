import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

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

function LoadingScreen({ progressText }: { progressText: string }) {
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
        <p className="mt-6 text-xs text-gray-400 max-w-xs">
          This usually takes 30–90 seconds. Keep this tab open.
        </p>
      </main>
    </div>
  )
}

function CompleteScreen({
  resultUrl,
  onNewMockup,
}: {
  resultUrl: string
  onNewMockup: () => void
}) {
  function handleDownload() {
    // The result_url is a base64 data URL, so we can just anchor-download it.
    // data URLs work for <a download> in modern browsers including iOS Safari.
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = 'mockup.png'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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
        <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50">
          <img
            src={resultUrl}
            alt="Generated sign mockup"
            className="w-full h-auto block"
          />
        </div>
        <p className="text-xs text-gray-500 mt-3 text-center">
          Tap the image and hold to save, or use the Download button below.
        </p>
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
        <div className="max-w-lg mx-auto w-full grid grid-cols-2 gap-3">
          <button
            onClick={handleDownload}
            className="min-w-0 h-14 border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
          >
            Download
          </button>
          <button
            onClick={onNewMockup}
            className="min-w-0 h-14 bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
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
            className="w-full h-14 bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  )
}
