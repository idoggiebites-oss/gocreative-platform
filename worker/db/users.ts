import type { Role } from '../../shared/enums'

export type AppUser = { id: number; email: string; name: string; role: Role }

// email is COLLATE NOCASE, so this match is case-insensitive.
export function findActiveUserByEmail(db: D1Database, email: string) {
  return db
    .prepare('SELECT id, email, name, role FROM users WHERE email = ? AND active = 1')
    .bind(email)
    .first<AppUser>()
}

export async function listUsers(db: D1Database) {
  const { results } = await db
    .prepare('SELECT id, email, name, role, active FROM users ORDER BY name')
    .all<AppUser & { active: 0 | 1 }>()
  return results
}
