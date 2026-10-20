import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
export const db = new Database(process.env.DB_PATH || 'data/app.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_sub TEXT NOT NULL,
    email TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, provider_sub)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('sale', 'rent', 'stay')),
    type TEXT NOT NULL CHECK (type IN ('House', 'Apartment', 'Townhouse', 'Condo')),
    area TEXT NOT NULL,
    address TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    beds INTEGER NOT NULL CHECK (beds BETWEEN 0 AND 20),
    baths REAL NOT NULL CHECK (baths BETWEEN 0 AND 20),
    sqft INTEGER NOT NULL CHECK (sqft > 0),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS listings_browse ON listings (status, kind, price);
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    file TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, listing_id)
  );
  CREATE TABLE IF NOT EXISTS review_checks (
    listing_id INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
    photos_checked INTEGER NOT NULL DEFAULT 0,
    address_checked INTEGER NOT NULL DEFAULT 0,
    price_checked INTEGER NOT NULL DEFAULT 0,
    owner_checked INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    original_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    email TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filters TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (reviewer_id, owner_id)
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// Upgrades for databases created by earlier versions of the site
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (!columnsOf('listings').includes('lat')) {
  db.exec('ALTER TABLE listings ADD COLUMN lat REAL; ALTER TABLE listings ADD COLUMN lng REAL;');
}
if (!columnsOf('inquiries').includes('read_at')) {
  db.exec('ALTER TABLE inquiries ADD COLUMN read_at TEXT;');
}
if (!columnsOf('listings').includes('alerted')) {
  db.exec('ALTER TABLE listings ADD COLUMN alerted INTEGER NOT NULL DEFAULT 0;');
}
if (!columnsOf('reviews').includes('reply')) {
  db.exec('ALTER TABLE reviews ADD COLUMN reply TEXT; ALTER TABLE reviews ADD COLUMN reply_at TEXT;');
}
