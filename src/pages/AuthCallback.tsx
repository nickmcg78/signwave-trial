import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * AuthCallback — handles the redirect from Supabase auth emails.
 *
 * Two flows land here:
 *   1. Password recovery: user clicks the "reset password" link in their
 *      email. Supabase emits PASSWORD_RECOVERY on the auth state change.
 *      We show a "set new password" form and call supabase.auth.updateUser.
 *   2. Magic link / signup confirm: user clicks the link in their email.
 *      Supabase emits SIGNED_IN with a fresh session. We redirect to home.
 *
 * The supabase-js client parses the URL hash automatically and emits the
 * right event; we just listen.
 */
export default function AuthCallback() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'loading' | 'recovery' | 'done' | 'error'>('loading')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // We use a ref so the timeout's check sees the latest mode, not the
  // captured initial value.
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    // Listen for auth events triggered by supabase-js parsing the URL hash.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setMode('recovery')
      } else if (event === 'SIGNED_IN' && session && modeRef.current === 'loading') {
        // Magic link or signup confirm — just send them home.
        navigate('/', { replace: true })
      }
    })

    // Safety net: if no token in the URL at all (someone hit /auth/callback
    // directly), bounce to login after a couple of seconds.
    const stale = setTimeout(() => {
      if (modeRef.current === 'loading') {
        setMode('error')
        setErrMsg('This link has expired or is invalid. Please request a new one.')
      }
    }, 2500)

    return () => {
      subscription.unsubscribe()
      clearTimeout(stale)
    }
  }, [navigate])

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault()
    setErrMsg(null)
    if (newPassword.length < 8) {
      setErrMsg('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setErrMsg('Passwords do not match.')
      return
    }
    setSubmitting(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setSubmitting(false)
    if (error) {
      setErrMsg(error.message)
      return
    }
    setMode('done')
    // Brief confirmation, then home.
    setTimeout(() => navigate('/', { replace: true }), 1500)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center px-5">
      <div className="w-full max-w-sm mx-auto">
        {/* Brand */}
        <div className="text-center mb-10">
          <img src="/signwave-logo.png" alt="Signwave" className="h-10 w-auto mx-auto" />
          <p className="text-gray-500 mt-3 text-sm">Sign mockup tool</p>
        </div>

        {mode === 'loading' && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center text-sm text-gray-500">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Verifying your link…
          </div>
        )}

        {mode === 'recovery' && (
          <form
            onSubmit={handlePasswordSubmit}
            className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-5"
          >
            <h2 className="text-lg font-semibold text-gray-900">Set a new password</h2>
            <p className="text-sm text-gray-500 -mt-3">
              Choose a password you'll remember. Minimum 8 characters.
            </p>

            <div>
              <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full min-h-[60px] px-4 rounded-xl border border-gray-300 text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="At least 8 characters"
              />
            </div>

            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full min-h-[60px] px-4 rounded-xl border border-gray-300 text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Re-enter the same password"
              />
            </div>

            {errMsg && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{errMsg}</p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[60px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 text-white font-semibold rounded-xl text-base transition-colors"
            >
              {submitting ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}

        {mode === 'done' && (
          <div className="bg-green-50 border border-green-200 rounded-2xl px-4 py-4 text-sm text-green-800 text-center">
            <p className="font-semibold">Password updated.</p>
            <p className="mt-1 text-green-700">Signing you in…</p>
          </div>
        )}

        {mode === 'error' && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center">
            <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-4">{errMsg}</p>
            <Link to="/login" className="text-sm text-blue-600 underline">
              Back to login
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
