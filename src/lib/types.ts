export type UserRole = 'franchisee' | 'admin'

export interface AppUser {
  id: string
  email: string
  role: UserRole
  full_name?: string
}
