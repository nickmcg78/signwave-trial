import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

type FeedbackRow = {
  id: string
  rating: string
  would_use: string
  comment: string | null
  created_at: string
  job_id: string
  user_id: string | null
}

type MockupRow = {
  id: string
  status: string
  result_url: string | null
  error: string | null
  created_at: string
  user_id: string | null
}

type Tab = 'feedback' | 'mockups'

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('feedback')
  const [feedback, setFeedback] = useState<FeedbackRow[]>([])
  const [mockups, setMockups] = useState<MockupRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const [{ data: fb }, { data: mk }] = await Promise.all([
        supabase
          .from('mockup_feedback')
          .select('id, rating, would_use, comment, created_at, job_id, user_id')
          .order('created_at', { ascending: false }),
        supabase
          .from('mockup_jobs')
          .select('id, status, result_url, error, created_at, user_id')
          .order('created_at', { ascending: false })
          .limit(200),
      ])

      if (cancelled) return
      if (fb) setFeedback(fb as FeedbackRow[])
      if (mk) setMockups(mk as MockupRow[])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  function shortId(id: string | null): string {
    if (!id) return '—'
    return id.slice(0, 8)
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  return (
    <>
      <h2 className="text-2xl font-bold text-gray-900 mt-1 mb-4">Admin</h2>

      {/* Tab switcher */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <button
          onClick={() => setTab('feedback')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
            tab === 'feedback' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'
          }`}
        >
          Feedback ({feedback.length})
        </button>
        <button
          onClick={() => setTab('mockups')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
            tab === 'mockups' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'
          }`}
        >
          All mockups ({mockups.length})
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : tab === 'feedback' ? (
        feedback.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
            <p className="text-sm">No feedback yet.</p>
            <p className="text-xs mt-1">Feedback will appear here once franchisees submit reviews.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-gray-200">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Rating</th>
                  <th className="px-4 py-3">Send to client?</th>
                  <th className="px-4 py-3">Comment</th>
                  <th className="px-4 py-3">Mockup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {feedback.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {formatDate(row.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                      {shortId(row.user_id)}
                    </td>
                    <td className="px-4 py-3">
                      {row.rating === 'up' ? (
                        <span className="text-green-600 font-medium">👍 Good</span>
                      ) : (
                        <span className="text-red-600 font-medium">👎 Poor</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{row.would_use}</td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                      {row.comment ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/result/${row.job_id}`} className="text-blue-600 text-xs underline">
                        view
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : mockups.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">No mockups yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {mockups.map((row) => (
            <Link
              key={row.id}
              to={`/result/${row.id}`}
              className="block bg-white rounded-2xl border border-gray-200 overflow-hidden hover:border-gray-300"
            >
              <div className="aspect-square bg-gray-100 relative">
                {row.status === 'complete' && row.result_url ? (
                  <img
                    src={row.result_url}
                    alt="Mockup"
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : row.status === 'failed' ? (
                  <div className="w-full h-full flex flex-col items-center justify-center text-red-400 text-xs px-2 text-center">
                    <span className="text-2xl mb-1">⚠</span>
                    <span>Failed</span>
                  </div>
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 text-xs">
                    <span className="inline-block w-5 h-5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin mb-2" />
                    <span>{row.status}</span>
                  </div>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="text-xs text-gray-500">{formatDate(row.created_at)}</p>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{shortId(row.user_id)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
