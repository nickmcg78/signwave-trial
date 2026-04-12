import { useEffect, useState } from 'react'
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

export default function AdminDashboard() {
  const [rows, setRows] = useState<FeedbackRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('mockup_feedback')
        .select('id, rating, would_use, comment, created_at, job_id, user_id')
        .order('created_at', { ascending: false })

      if (data) setRows(data as FeedbackRow[])
      setLoading(false)
    }
    load()
  }, [])

  return (
    <>
      <h2 className="text-2xl font-bold text-gray-900 mt-1 mb-6">Feedback</h2>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
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
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Send to client?</th>
                <th className="px-4 py-3">Comment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {new Date(row.created_at).toLocaleDateString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
