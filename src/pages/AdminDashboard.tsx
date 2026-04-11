import { useAuth } from '../context/AuthContext'

export default function AdminDashboard() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-900">Signwave</h1>
          <span className="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Admin</span>
        </div>
        <button
          onClick={signOut}
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Sign out
        </button>
      </header>

      <main className="px-4 py-6 max-w-lg mx-auto">
        <p className="text-gray-500 text-sm">Signed in as {user?.email}</p>
        <h2 className="text-2xl font-bold text-gray-900 mt-1 mb-6">Admin Panel</h2>

        {/* Placeholder — admin features come in later sessions */}
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">User management and review tools.</p>
          <p className="text-xs mt-1">Coming in later sessions.</p>
        </div>
      </main>
    </div>
  )
}
