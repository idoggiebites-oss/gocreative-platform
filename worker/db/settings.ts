export const isMaintenance = async (db: D1Database) => (await db.prepare("SELECT 1 FROM settings WHERE key = 'maintenance'").first()) !== null
