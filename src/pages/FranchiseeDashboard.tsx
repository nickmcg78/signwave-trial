import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

type MockupRow = {
  id: string
  status: 'pending' | 'processing' | 'complete' | 'failed' | string
  result_url: string | null
  error: string | null
  created_at: string
}

export default function FranchiseeDashboard() {
  const { user } = useAuth()
  const [rows, setRows] = useState<MockupRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) { setLoading(false); return }

    let cancelled = false

    async function load() {
      const { data, error } = await supabase
        .from('mockup_jobs')
        .select('id, status, result_url, error, created_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (cancelled) return
      if (error) {
        console.error('[FranchiseeDashboard] failed to load mockups:', error)
        setRows([])
      } else if (data) {
        setRows(data as MockupRow[])
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [user])

  function formatDate(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return `Today, ${d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`
    }
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <>
      <h2 className="text-2xl font-bold text-gray-900 mt-1 mb-6">My Mockups</h2>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">No mockups yet.</p>
          <p className="text-xs mt-1">Tap "+ New Mockup" below to start.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {rows.map((row) => (
            <Link
              key={row.id}
              to={`/result/${row.id}`}
              className="block bg-white rounded-2xl border border-gray-200 overflow-hidden hover:border-gray-300 active:bg-gray-50 transition-colors"
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
                    <span>Generation failed</span>
                  </div>
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 text-xs">
                    <span className="inline-block w-5 h-5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin mb-2" />
                    <span>{row.status === 'processing' ? 'Generating…' : 'Pending…'}</span>
                  </div>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="text-xs text-gray-500">{formatDate(row.created_at)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
