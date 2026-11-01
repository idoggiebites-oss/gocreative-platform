const isSet = async (db: D1Database, key: string) => (await db.prepare('SELECT 1 FROM settings WHERE key = ?').bind(key).first()) !== null

export const isMaintenance = (db: D1Database) => isSet(db, 'maintenance')
export const isIntakeClosed = (db: D1Database) => isSet(db, 'intake_closed')
