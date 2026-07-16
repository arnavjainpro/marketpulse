// Email/password auth with server-side sessions. Bun.password (bcrypt) for
// hashing, no new deps. Sessions are opaque tokens stored in SQLite so logout
// is an instant DELETE — no JWT signing/verification needed at this scale.
import { db } from "../db";

const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 days

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function createUser(email: string, passwordHash: string): number {
  const res = db
    .query(`INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, unixepoch()) RETURNING id`)
    .get(email.toLowerCase().trim(), passwordHash) as { id: number };
  if (res.id === 1) adoptLegacySingleUserData(res.id);
  return res.id;
}

// The first account created inherits everything from the pre-auth, single-user
// era: the Robinhood link and any broker-import blob were stored in the global
// settings namespace (user_id=0) before users existed. Move them under the new
// owner so the link keeps working after the upgrade.
function adoptLegacySingleUserData(userId: number) {
  const rh = db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = 'robinhood_auth'`).get() as { value: string } | null;
  if (rh?.value) {
    db.query(
      `INSERT INTO broker_links (user_id, provider, auth_json, linked_at) VALUES (?, 'robinhood', ?, unixepoch())
       ON CONFLICT(user_id) DO NOTHING`
    ).run(userId, rh.value);
    db.query(`DELETE FROM settings WHERE user_id = 0 AND key = 'robinhood_auth'`).run();
    console.log(`[auth] migrated legacy Robinhood link to user ${userId}`);
  }
  const imp = db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = 'broker_import'`).get() as { value: string } | null;
  if (imp?.value) {
    db.query(`INSERT INTO settings (user_id, key, value) VALUES (?, 'broker_import', ?) ON CONFLICT(user_id, key) DO NOTHING`).run(userId, imp.value);
    db.query(`DELETE FROM settings WHERE user_id = 0 AND key = 'broker_import'`).run();
    console.log(`[auth] migrated legacy broker import to user ${userId}`);
  }
}

export function findUserByEmail(email: string): UserRow | null {
  return db
    .query(`SELECT id, email, password_hash FROM users WHERE email = ?`)
    .get(email.toLowerCase().trim()) as UserRow | null;
}

export function findUserById(id: number): { id: number; email: string } | null {
  return db.query(`SELECT id, email FROM users WHERE id = ?`).get(id) as { id: number; email: string } | null;
}

export function getProfile(id: number): { email: string; full_name: string | null; phone: string | null } | null {
  return db.query(`SELECT email, full_name, phone FROM users WHERE id = ?`).get(id) as
    | { email: string; full_name: string | null; phone: string | null }
    | null;
}

export function updateProfile(id: number, fields: { full_name: string | null; phone: string | null }) {
  db.query(`UPDATE users SET full_name = ?, phone = ? WHERE id = ?`).run(fields.full_name, fields.phone, id);
}

export function createSession(userId: number): string {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 256+ bits, unguessable
  const now = Math.floor(Date.now() / 1000);
  db.query(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now, now + SESSION_TTL_SEC);
  return token;
}

export function validateSession(token: string): number | null {
  const row = db.query(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(token) as
    | { user_id: number; expires_at: number }
    | null;
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.user_id;
}

export function destroySession(token: string) {
  db.query(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function cleanupExpiredSessions() {
  db.query(`DELETE FROM sessions WHERE expires_at < ?`).run(Math.floor(Date.now() / 1000));
}
