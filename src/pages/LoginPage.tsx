import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

type Mode = 'login' | 'forgot' | 'forgot-sent'

export default function LoginPage() {
  const { signIn, user, loading: authLoading } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // If already signed in, bounce to the right home
  if (!authLoading && user) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/'} replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError(error)
    setLoading(false)
    // On success, the auth state updates and the Navigate above will redirect
  }

  async function handleForgotSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email) {
      setError('Enter your email address first.')
      return
    }
    setLoading(true)
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback`,
    })
    setLoading(false)
    if (resetError) {
      setError(resetError.message)
      return
    }
    setMode('forgot-sent')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center px-5">
      <div className="w-full max-w-sm mx-auto">
        {/* Logo / Brand */}
        <div className="text-center mb-10">
          <img src="/signwave-logo.png" alt="Signwave" className="h-10 w-auto mx-auto" />
          <p className="text-gray-500 mt-3 text-sm">Sign mockup tool</p>
        </div>

        {mode === 'login' && (
          <>
            <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full min-h-[60px] px-4 rounded-xl border border-gray-300 text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full min-h-[60px] px-4 rounded-xl border border-gray-300 text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full min-h-[60px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 text-white font-semibold rounded-xl text-base transition-colors"
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>

              <button
                type="button"
                onClick={() => { setError(null); setMode('forgot') }}
                className="block w-full text-center text-sm text-blue-600 hover:text-blue-700 active:text-blue-800"
              >
                Forgot password?
              </button>
            </form>

            <p className="text-center text-xs text-gray-400 mt-6">
              Contact your admin to get access.
            </p>
          </>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgotSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Reset your password</h2>
              <p className="text-sm text-gray-500 mt-1">
                Enter your email and we'll send you a link to set a new password.
              </p>
            </div>

            <div>
              <label htmlFor="forgot-email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full min-h-[60px] px-4 rounded-xl border border-gray-300 text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="you@example.com"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[60px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 text-white font-semibold rounded-xl text-base transition-colors"
            >
              {loading ? 'Sending…' : 'Send recovery email'}
            </button>

            <button
              type="button"
              onClick={() => { setError(null); setMode('login') }}
              className="block w-full text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Back to sign in
            </button>
          </form>
        )}

        {mode === 'forgot-sent' && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-4 text-center">
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
              <p className="font-semibold">Check your inbox.</p>
              <p className="mt-1 text-green-700">
                We've sent a password-reset link to <strong>{email}</strong>. The link works for 1 hour.
              </p>
            </div>
            <p className="text-xs text-gray-500">
              Didn't get it? Check your spam folder, or contact your admin.
            </p>
            <button
              type="button"
              onClick={() => { setError(null); setMode('login') }}
              className="block w-full text-center text-sm text-blue-600 hover:text-blue-700"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
