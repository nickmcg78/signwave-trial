import { Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function FranchiseeLayout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Signwave</h1>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Sign out
        </button>
      </header>

      {/* Page content */}
      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto pb-28">
        <p className="text-gray-500 text-xs">
          Signed in as {user?.full_name ?? user?.email}
        </p>
        <Outlet />
      </main>

      {/* Sticky bottom bar with "New Mockup" CTA */}
      <div
        className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200"
        style={{
          paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
          paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
          paddingTop: '0.75rem',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        <div className="max-w-lg mx-auto">
          <button
            onClick={() => navigate('/new')}
            className="w-full min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
          >
            + New Mockup
          </button>
        </div>
      </div>
    </div>
  )
}
