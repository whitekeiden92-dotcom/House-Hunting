import './env.js';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db.js';
import { authRouter } from './auth.js';
import { sendMail } from './mailer.js';
import { sha256, readCookie, cookieOpts } from './util.js';

const env = process.env;
if (!env.APP_URL) {
  console.error('Set APP_URL first, for example APP_URL=https://yourdomain.com');
  process.exit(1);
}
mkdirSync('uploads', { recursive: true });
mkdirSync(join('private', 'documents'), { recursive: true });

const app = express();
app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '20kb' }));

const limiter = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/auth', limiter(30, 15 * 60e3), authRouter);

// Browsers always send Origin on writes, so reject writes that come from any other site.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/auth/')) return next();
  if (req.get('origin') !== env.APP_URL) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// Load the signed-in user. The session token is stored only as a hash.
app.use((req, res, next) => {
  const token = readCookie(req, 'hh_session');
  req.user = token
    ? db.prepare(`SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now()) || null
    : null;
  next();
});

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first' }));
const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Not allowed' }));
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) ? n : null; };

// Returns the listing id if the signed-in user owns it (or is an admin). Otherwise it sends the error and returns null.
function ownedListing(req, res) {
  const id = idOf(req);
  const row = id && db.prepare('SELECT owner_id FROM listings WHERE id = ?').get(id);
  if (!row) { res.sendStatus(404); return null; }
  if (row.owner_id !== req.user.id && req.user.role !== 'admin') { res.sendStatus(403); return null; }
  return id;
}

const KINDS = ['sale', 'rent', 'stay'];
const TYPES = ['House', 'Apartment', 'Townhouse', 'Condo'];
const SORTS = { price_asc: 'price ASC', price_desc: 'price DESC', beds_desc: 'beds DESC, price ASC' };
const COVER = '(SELECT file FROM photos p WHERE p.listing_id = listings.id ORDER BY p.id LIMIT 1) AS cover';
const photoUrl = (file) => `/uploads/${file}`;
const photosOf = (id) => db.prepare('SELECT file FROM photos WHERE listing_id = ? ORDER BY id').all(id).map((p) => photoUrl(p.file));
const checksFor = (table) => `(SELECT (rc.photos_checked AND rc.address_checked AND rc.price_checked AND rc.owner_checked)
  FROM review_checks rc WHERE rc.listing_id = ${table}.id) AS checks_passed`;
const CHECKS = checksFor('listings');
const OWNER_RATING = `(SELECT ROUND(AVG(stars), 1) FROM reviews WHERE owner_id = listings.owner_id AND hidden = 0) AS owner_rating,
  (SELECT COUNT(*) FROM reviews WHERE owner_id = listings.owner_id AND hidden = 0) AS owner_reviews`;
const REASONS = ['fake', 'wrong_details', 'sold_or_rented', 'scam', 'other'];
// Verified means: approved, and every check ticked by the review team.
const withVerified = (row) => {
  const { checks_passed: passed, ...rest } = row;
  return { ...rest, verified: !!passed && (rest.status === undefined || rest.status === 'approved') };
};
const withCover = (row) => ({ ...withVerified(row), cover: row.cover ? photoUrl(row.cover) : null });

// Allow-list validation: every field is checked and trimmed before it reaches the database.
function cleanListing(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const o = {
    kind: b.kind, type: b.type, area: txt(b.area, 80), address: txt(b.address, 160),
    description: txt(b.description, 2000), price: num(b.price), beds: num(b.beds),
    baths: num(b.baths), sqft: num(b.sqft),
  };
  o.lat = b.lat === '' || b.lat == null ? null : Number(b.lat);
  o.lng = b.lng === '' || b.lng == null ? null : Number(b.lng);
  const ok = KINDS.includes(o.kind) && TYPES.includes(o.type) && o.area && o.address && o.description
    && Number.isInteger(o.price) && o.price > 0 && o.price <= 1e10
    && Number.isInteger(o.beds) && o.beds >= 0 && o.beds <= 20
    && Number.isFinite(o.baths) && o.baths >= 0 && o.baths <= 20 && Number.isInteger(o.baths * 2)
    && Number.isInteger(o.sqft) && o.sqft > 0 && o.sqft <= 100000;
  if (o.lat !== null && !(o.lat >= -90 && o.lat <= 90)) return null;
  if (o.lng !== null && !(o.lng >= -180 && o.lng <= 180)) return null;
  return ok ? o : null;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(readCookie(req, 'hh_session')));
  res.clearCookie('hh_session', cookieOpts());
  res.json({ ok: true });
});

// Public search: only approved listings. Every filter is a bound parameter.
app.get('/api/listings', limiter(120, 60e3), (req, res) => {
  const q = req.query, where = ["status = 'approved'"], args = [];
  if (KINDS.includes(q.kind)) { where.push('kind = ?'); args.push(q.kind); }
  if (TYPES.includes(q.type)) { where.push('type = ?'); args.push(q.type); }
  const minBeds = Number(q.minBeds), maxPrice = Number(q.maxPrice);
  if (Number.isInteger(minBeds) && minBeds > 0) { where.push('beds >= ?'); args.push(minBeds); }
  if (Number.isFinite(maxPrice) && maxPrice > 0) { where.push('price <= ?'); args.push(Math.floor(maxPrice)); }
  const text = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(area LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const sort = Object.hasOwn(SORTS, q.sort) ? SORTS[q.sort] : SORTS.price_asc;
  const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 20, 1), 50);
  const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
  const rows = db.prepare(`SELECT id, kind, type, area, address, price, beds, baths, sqft, description, lat, lng, ${COVER}, ${CHECKS}, ${OWNER_RATING}
    FROM listings WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ listings: rows.map(withCover) });
});

app.get('/api/listings/:id', (req, res) => {
  const id = idOf(req);
  const row = id && db.prepare(`SELECT listings.*, ${CHECKS}, ${OWNER_RATING} FROM listings WHERE id = ?`).get(id);
  if (!row) return res.sendStatus(404);
  const { owner_id: ownerId, ...listing } = row;
  const canSee = row.status === 'approved' || (req.user && (req.user.id === ownerId || req.user.role === 'admin'));
  if (!canSee) return res.sendStatus(404);
  res.json({ listing: { ...withVerified(listing), photos: photosOf(id), photo_items: photoItemsOf(id), owner_id: ownerId } });
});

app.post('/api/listings', limiter(20, 60e3), requireUser, (req, res) => {
  const o = cleanListing(req.body);
  if (!o) return res.status(400).json({ error: 'Check the listing fields and try again' });
  const r = db.prepare(`INSERT INTO listings (owner_id, kind, type, area, address, price, beds, baths, sqft, description, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, o.kind, o.type, o.area, o.address, o.price, o.beds, o.baths, o.sqft, o.description, o.lat, o.lng);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: 'pending' });
});

app.get('/api/my/listings', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT id, kind, type, area, address, price, beds, baths, sqft, status, ${COVER}, ${CHECKS}
    FROM listings WHERE owner_id = ? ORDER BY id DESC`).all(req.user.id);
  res.json({ listings: rows.map(withCover) });
});

app.put('/api/listings/:id', limiter(30, 60e3), requireUser, (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  const o = cleanListing(req.body);
  if (!o) return res.status(400).json({ error: 'Check the listing fields and try again' });
  db.prepare(`UPDATE listings SET kind = ?, type = ?, area = ?, address = ?, price = ?, beds = ?, baths = ?, sqft = ?,
    description = ?, lat = ?, lng = ?, status = 'pending', updated_at = datetime('now') WHERE id = ?`)
    .run(o.kind, o.type, o.area, o.address, o.price, o.beds, o.baths, o.sqft, o.description, o.lat, o.lng, id);
  db.prepare('DELETE FROM review_checks WHERE listing_id = ?').run(id); // a changed listing needs a new review
  res.json({ ok: true, status: 'pending' });
});

app.delete('/api/listings/:id', limiter(30, 60e3), requireUser, (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  for (const p of db.prepare('SELECT file FROM photos WHERE listing_id = ?').all(id)) {
    unlink(join('uploads', p.file)).catch(() => {});
  }
  for (const d of db.prepare('SELECT file FROM documents WHERE listing_id = ?').all(id)) {
    unlink(join('private', 'documents', d.file)).catch(() => {});
  }
  db.prepare('DELETE FROM listings WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Photos: only real JPEG, PNG or WebP files, re-encoded to JPEG with metadata (such as GPS) removed.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 8 } });
const isImage = (b) =>
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
  || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
  || (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP');

app.post('/api/listings/:id/photos', limiter(20, 60e3), requireUser, upload.array('photos', 8), async (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  const files = Array.isArray(req.files) ? req.files : [];
  const count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE listing_id = ?').get(id).n;
  if (!files.length || count + files.length > 8) return res.status(400).json({ error: 'Add between 1 and 8 photos per home' });
  if (!files.every((f) => isImage(f.buffer))) return res.status(400).json({ error: 'Photos must be JPEG, PNG or WebP' });
  try {
    const names = [];
    for (const f of files) {
      const name = `${randomUUID()}.jpg`;
      await sharp(f.buffer, { limitInputPixels: 40e6 }).rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toFile(join('uploads', name));
      names.push(name);
    }
    const insert = db.prepare('INSERT INTO photos (listing_id, file) VALUES (?, ?)');
    for (const name of names) insert.run(id, name);
    res.status(201).json({ photos: names.map(photoUrl) });
  } catch {
    res.status(400).json({ error: 'One of the photos could not be read' });
  }
});

app.get('/api/saved', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT l.id, l.kind, l.type, l.area, l.address, l.price, l.beds, l.baths, l.sqft,
    (SELECT file FROM photos p WHERE p.listing_id = l.id ORDER BY p.id LIMIT 1) AS cover, ${checksFor('l')}
    FROM saved s JOIN listings l ON l.id = s.listing_id WHERE s.user_id = ? AND l.status = 'approved'`).all(req.user.id);
  res.json({ listings: rows.map(withCover) });
});

app.post('/api/saved/:id', limiter(60, 60e3), requireUser, (req, res) => {
  const id = idOf(req);
  const ok = id && db.prepare("SELECT 1 FROM listings WHERE id = ? AND status = 'approved'").get(id);
  if (!ok) return res.sendStatus(404);
  db.prepare('INSERT OR IGNORE INTO saved (user_id, listing_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});

app.delete('/api/saved/:id', limiter(60, 60e3), requireUser, (req, res) => {
  const id = idOf(req);
  if (!id) return res.sendStatus(404);
  db.prepare('DELETE FROM saved WHERE user_id = ? AND listing_id = ?').run(req.user.id, id);
  res.json({ ok: true });
});

// Anyone can send an inquiry, but each address is limited to 5 per hour.
app.post('/api/listings/:id/inquiries', limiter(5, 60 * 60e3), (req, res) => {
  const id = idOf(req), b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  const email = typeof b.email === 'string' ? b.email.trim().slice(0, 254) : '';
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 1000) : '';
  if (!id || !name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Check your name, email and message' });
  }
  const ok = db.prepare("SELECT 1 FROM listings WHERE id = ? AND status = 'approved'").get(id);
  if (!ok) return res.sendStatus(404);
  db.prepare('INSERT INTO inquiries (listing_id, name, email, message) VALUES (?, ?, ?, ?)').run(id, name, email, message);
  notifyOwner(id, name, email, message).catch((err) => console.error('Owner email failed:', err.message));
  res.status(201).json({ ok: true });
});

app.get('/api/admin/listings', requireUser, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT id, kind, type, area, address, price, beds, baths, sqft, status, created_at
    FROM listings WHERE status = ? ORDER BY id`).all(status);
  res.json({ listings: rows.map((l) => ({
    ...l,
    photos: photosOf(l.id),
    documents: db.prepare('SELECT id, original_name FROM documents WHERE listing_id = ? ORDER BY id').all(l.id),
    checks: db.prepare(`SELECT photos_checked AS photos, address_checked AS address, price_checked AS price,
      owner_checked AS owner, note, reviewed_by, reviewed_at FROM review_checks WHERE listing_id = ?`).get(l.id) || null,
  })) });
});

app.post('/api/admin/listings/:id/status', requireUser, requireAdmin, (req, res) => {
  const id = idOf(req), status = req.body?.status;
  if (!id || !['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Bad request' });
  if (status === 'approved') {
    const c = db.prepare('SELECT photos_checked, address_checked, price_checked, owner_checked FROM review_checks WHERE listing_id = ?').get(id);
    if (!c || !c.photos_checked || !c.address_checked || !c.price_checked || !c.owner_checked) {
      return res.status(400).json({ error: 'Tick all four checks before you approve' });
    }
  }
  const r = db.prepare("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  if (status === 'approved') alertSearches(id).catch((err) => console.error('Search alert failed:', err.message));
  if (!r.changes) return res.sendStatus(404);
  res.json({ ok: true });
});

// Proof of ownership: private files. Only the review team can open them, and they are never served as public files.
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
const docExtension = (buffer) => {
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return '.pdf';
  if (!isImage(buffer)) return null;
  if (buffer[0] === 0x89) return '.png';
  return buffer[0] === 0xff ? '.jpg' : '.webp';
};

app.post('/api/listings/:id/documents', limiter(20, 60e3), requireUser, docUpload.array('documents', 3), (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  const files = Array.isArray(req.files) ? req.files : [];
  const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE listing_id = ?').get(id).n;
  if (!files.length || count + files.length > 5) return res.status(400).json({ error: 'Add between 1 and 5 documents per home' });
  const extensions = files.map((f) => docExtension(f.buffer));
  if (extensions.some((ext) => !ext)) return res.status(400).json({ error: 'Documents must be PDF, JPEG, PNG or WebP' });
  const insert = db.prepare('INSERT INTO documents (listing_id, file, original_name) VALUES (?, ?, ?)');
  files.forEach((f, i) => {
    const name = `${randomUUID()}${extensions[i]}`;
    writeFileSync(join('private', 'documents', name), f.buffer);
    insert.run(id, name, String(f.originalname || 'document').replace(/[^\w.\- ]/g, '_').slice(0, 100));
  });
  res.status(201).json({ ok: true, count: files.length });
});

app.get('/api/admin/documents/:id', requireUser, requireAdmin, (req, res) => {
  const d = db.prepare('SELECT file, original_name FROM documents WHERE id = ?').get(idOf(req));
  if (!d) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${d.original_name.replace(/"/g, '')}"`);
  res.sendFile(join(process.cwd(), 'private', 'documents', d.file));
});

// The review team's four checks, saved with a note and the reviewer's name.
app.put('/api/admin/listings/:id/checks', requireUser, requireAdmin, (req, res) => {
  const id = idOf(req), b = req.body || {};
  if (!id || !db.prepare('SELECT 1 FROM listings WHERE id = ?').get(id)) return res.sendStatus(404);
  const flag = (value) => (value === true ? 1 : 0);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
  db.prepare(`INSERT INTO review_checks (listing_id, photos_checked, address_checked, price_checked, owner_checked, note, reviewed_by, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (listing_id) DO UPDATE SET photos_checked = excluded.photos_checked, address_checked = excluded.address_checked,
      price_checked = excluded.price_checked, owner_checked = excluded.owner_checked, note = excluded.note,
      reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`)
    .run(id, flag(b.photos), flag(b.address), flag(b.price), flag(b.owner), note, req.user.email || req.user.name || 'reviewer');
  res.json({ ok: true });
});

// Visitors can report a listing. Each address can send 5 reports an hour.
app.post('/api/listings/:id/reports', limiter(5, 60 * 60e3), (req, res) => {
  const id = idOf(req), b = req.body || {};
  const reason = REASONS.includes(b.reason) ? b.reason : '';
  const details = typeof b.details === 'string' ? b.details.trim().slice(0, 1000) : '';
  const email = typeof b.email === 'string' ? b.email.trim().slice(0, 254) : '';
  if (!id || !reason || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ error: 'Choose a reason, and check your email address if you added one' });
  }
  if (!db.prepare("SELECT 1 FROM listings WHERE id = ? AND status = 'approved'").get(id)) return res.sendStatus(404);
  db.prepare('INSERT INTO reports (listing_id, reason, details, email) VALUES (?, ?, ?, ?)').run(id, reason, details, email || null);
  res.status(201).json({ ok: true });
});

app.get('/api/admin/reports', requireUser, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.reason, r.details, r.created_at, l.id AS listing_id, l.address
    FROM reports r JOIN listings l ON l.id = r.listing_id WHERE r.status = 'open' ORDER BY r.id`).all();
  res.json({ reports: rows });
});

app.post('/api/admin/reports/:id/status', requireUser, requireAdmin, (req, res) => {
  const id = idOf(req), status = req.body?.status;
  if (!id || !['resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Bad request' });
  const r = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
  if (!r.changes) return res.sendStatus(404);
  res.json({ ok: true });
});

// Messages about a home go to its owner by email, as well as into My homes.
async function notifyOwner(listingId, name, email, message) {
  const owner = db.prepare('SELECT u.email, l.address FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = ?').get(listingId);
  if (!owner?.email) return;
  await sendMail(owner.email, 'New message about your home', `Someone sent a message about ${owner.address} on House Hunting.

From: ${name} <${email}>

${message}

Reply to them directly at ${email}, or open My homes on the site to see every message.`);
}

app.get('/api/my/inbox', requireUser, (req, res) => {
  const messages = db.prepare(`SELECT i.id, i.name, i.email, i.message, i.created_at, i.read_at, l.id AS listing_id, l.address
    FROM inquiries i JOIN listings l ON l.id = i.listing_id WHERE l.owner_id = ? ORDER BY i.id DESC LIMIT 100`).all(req.user.id);
  res.json({ messages, unread: messages.filter((m) => !m.read_at).length });
});

app.post('/api/my/inbox/:id/read', requireUser, (req, res) => {
  const id = idOf(req);
  if (!id) return res.sendStatus(404);
  const r = db.prepare(`UPDATE inquiries SET read_at = datetime('now')
    WHERE id = ? AND listing_id IN (SELECT id FROM listings WHERE owner_id = ?)`).run(id, req.user.id);
  if (!r.changes) return res.sendStatus(404);
  res.json({ ok: true });
});

// Saved searches. When a home is approved, everyone whose saved search matches gets an email.
function searchMatches(filters, l) {
  if (filters.kind && filters.kind !== l.kind) return false;
  if (filters.type && filters.type !== l.type) return false;
  if (filters.minBeds && l.beds < filters.minBeds) return false;
  if (filters.maxPrice && l.price > filters.maxPrice) return false;
  if (filters.q && !`${l.area} ${l.address}`.toLowerCase().includes(filters.q.toLowerCase())) return false;
  return true;
}

async function alertSearches(listingId) {
  const l = db.prepare('SELECT kind, type, area, address, price, beds, alerted FROM listings WHERE id = ?').get(listingId);
  if (!l || l.alerted) return; // each home is announced once, even if it is edited and approved again
  db.prepare('UPDATE listings SET alerted = 1 WHERE id = ?').run(listingId);
  const searches = db.prepare('SELECT s.name, s.filters, u.email FROM saved_searches s JOIN users u ON u.id = s.user_id WHERE u.email IS NOT NULL').all();
  for (const s of searches) {
    if (!searchMatches(JSON.parse(s.filters), l)) continue;
    await sendMail(s.email, `A new home matches "${s.name}"`, `A newly approved home matches your saved search "${s.name}" on House Hunting.

${l.address}, ${l.area} (${l.type})

Open House Hunting to see the photos and details.`);
  }
}

app.get('/api/searches', requireUser, (req, res) => {
  const rows = db.prepare('SELECT id, name, filters FROM saved_searches WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ searches: rows.map((r) => ({ id: r.id, name: r.name, filters: JSON.parse(r.filters) })) });
});

app.post('/api/searches', limiter(20, 60e3), requireUser, (req, res) => {
  const b = req.body || {};
  const f = b.filters && typeof b.filters === 'object' ? b.filters : {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  const filters = {};
  if (typeof f.q === 'string' && f.q.trim()) filters.q = f.q.trim().slice(0, 100);
  if (KINDS.includes(f.kind)) filters.kind = f.kind;
  if (TYPES.includes(f.type)) filters.type = f.type;
  if (Number.isInteger(Number(f.minBeds)) && Number(f.minBeds) > 0) filters.minBeds = Number(f.minBeds);
  if (Number.isFinite(Number(f.maxPrice)) && Number(f.maxPrice) > 0) filters.maxPrice = Math.floor(Number(f.maxPrice));
  if (!name || !Object.keys(filters).length) return res.status(400).json({ error: 'Choose at least one filter to save' });
  if (db.prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?').get(req.user.id).n >= 10) {
    return res.status(400).json({ error: 'You can save up to 10 searches' });
  }
  const r = db.prepare('INSERT INTO saved_searches (user_id, name, filters) VALUES (?, ?, ?)').run(req.user.id, name, JSON.stringify(filters));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/searches/:id', requireUser, (req, res) => {
  const id = idOf(req);
  if (!id) return res.sendStatus(404);
  db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ ok: true });
});

// Sent to the review team when a home is submitted (or edited and submitted again).
const KIND_TEXT = { sale: 'For sale', rent: 'For rent', stay: 'Short stay' };
async function notifyReviewers(listingId) {
  const reviewers = (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  const h = db.prepare(`SELECT l.kind, l.type, l.area, l.address, l.price, l.beds, l.baths, l.sqft,
      u.name AS owner_name, u.email AS owner_email,
      (SELECT COUNT(*) FROM photos p WHERE p.listing_id = l.id) AS photos,
      (SELECT COUNT(*) FROM documents d WHERE d.listing_id = l.id) AS documents
    FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = ?`).get(listingId);
  if (!h || !reviewers.length) return;
  const text = `A home is waiting for your approval.

Owner: ${h.owner_name || 'Unknown'} <${h.owner_email || 'no email'}>
Listing: ${KIND_TEXT[h.kind] ?? h.kind}, ${h.type}
Address: ${h.address}, ${h.area}
Price: KSh ${Number(h.price).toLocaleString('en-US')}
Bedrooms ${h.beds}, bathrooms ${h.baths}, ${h.sqft} sq ft
Photos: ${h.photos}. Ownership documents: ${h.documents}.

To verify it, open the Review page, tick the four checks, then approve or reject:
${env.APP_URL}/app.html#/admin`;
  for (const to of reviewers) {
    await sendMail(to, `Please verify a new home: ${h.address}`, text);
  }
}

app.post('/api/listings/:id/submit', limiter(20, 60e3), requireUser, (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  if (!db.prepare("SELECT 1 FROM listings WHERE id = ? AND status = 'pending'").get(id)) {
    return res.status(400).json({ error: 'This home is not waiting for review' });
  }
  notifyReviewers(id).catch((err) => console.error('Reviewer email failed:', err.message));
  res.json({ ok: true });
});

// Star reviews. Only people who have messaged one of the owner's homes with their account email can review.
const displayName = (name) => {
  const parts = String(name || 'Member').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};
const contactedOwner = (ownerId, email) => !!email && !!db.prepare(
  'SELECT 1 FROM inquiries i JOIN listings l ON l.id = i.listing_id WHERE l.owner_id = ? AND lower(i.email) = lower(?) LIMIT 1',
).get(ownerId, email);

app.get('/api/owners/:id', limiter(120, 60e3), (req, res) => {
  const id = idOf(req);
  const owner = id && db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  if (!owner) return res.sendStatus(404);
  const stats = db.prepare('SELECT ROUND(AVG(stars), 1) AS rating, COUNT(*) AS count FROM reviews WHERE owner_id = ? AND hidden = 0').get(id);
  const listings = db.prepare(`SELECT id, kind, type, area, address, price, beds, baths, sqft, description, lat, lng, ${COVER}, ${CHECKS}
    FROM listings WHERE owner_id = ? AND status = 'approved' ORDER BY id DESC`).all(id).map(withCover);
  const reviews = db.prepare(`SELECT r.id, r.stars, r.comment, r.created_at, r.reply, r.reply_at, u.name AS reviewer
    FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.owner_id = ? AND r.hidden = 0 ORDER BY r.updated_at DESC LIMIT 50`)
    .all(id).map((r) => ({ ...r, reviewer: displayName(r.reviewer), created_at: r.created_at.slice(0, 10) }));
  const mine = req.user
    ? db.prepare('SELECT stars, comment FROM reviews WHERE reviewer_id = ? AND owner_id = ?').get(req.user.id, id) || null
    : null;
  res.json({
    owner: {
      id: owner.id, name: displayName(owner.name), rating: stats.rating, count: stats.count,
      trusted: stats.count >= 5 && stats.rating >= 4.5,
    },
    listings,
    reviews,
    myReview: mine,
    canReview: !!req.user && req.user.id !== id && contactedOwner(id, req.user.email),
  });
});

app.post('/api/owners/:id/reviews', limiter(10, 60 * 60e3), requireUser, (req, res) => {
  const id = idOf(req), b = req.body || {};
  const stars = Number(b.stars);
  const comment = typeof b.comment === 'string' ? b.comment.trim().slice(0, 500) : '';
  if (!id || id === req.user.id || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Choose 1 to 5 stars' });
  }
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.sendStatus(404);
  if (!contactedOwner(id, req.user.email)) {
    return res.status(403).json({ error: 'You can review an owner after you message one of their homes with your account email' });
  }
  db.prepare(`INSERT INTO reviews (reviewer_id, owner_id, stars, comment) VALUES (?, ?, ?, ?)
    ON CONFLICT (reviewer_id, owner_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment, updated_at = datetime('now')`)
    .run(req.user.id, id, stars, comment);
  res.json({ ok: true });
});

app.post('/api/admin/reviews/:id/hide', requireUser, requireAdmin, (req, res) => {
  const id = idOf(req);
  const r = id ? db.prepare('UPDATE reviews SET hidden = 1 WHERE id = ?').run(id) : null;
  if (!r || !r.changes) return res.sendStatus(404);
  res.json({ ok: true });
});

// Each photo of a home, with the id needed to remove it.
const photoItemsOf = (id) => db.prepare('SELECT id, file FROM photos WHERE listing_id = ? ORDER BY id').all(id)
  .map((p) => ({ id: p.id, url: photoUrl(p.file) }));

// The owner of a home answers a review of their own profile.
app.post('/api/reviews/:id/reply', limiter(20, 60e3), requireUser, (req, res) => {
  const id = idOf(req);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
  if (!id || !text) return res.status(400).json({ error: 'Write a short reply first' });
  const r = db.prepare("UPDATE reviews SET reply = ?, reply_at = datetime('now') WHERE id = ? AND owner_id = ? AND hidden = 0")
    .run(text, id, req.user.id);
  if (!r.changes) return res.sendStatus(404);
  res.json({ ok: true });
});

// Removing a photo sends the home back to review, like any other change.
app.delete('/api/listings/:id/photos/:photoId', limiter(30, 60e3), requireUser, (req, res) => {
  const id = ownedListing(req, res);
  if (!id) return;
  const photoId = Number(req.params.photoId);
  const photo = Number.isInteger(photoId) ? db.prepare('SELECT file FROM photos WHERE id = ? AND listing_id = ?').get(photoId, id) : null;
  if (!photo) return res.sendStatus(404);
  unlink(join('uploads', photo.file)).catch(() => {});
  db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
  db.prepare("UPDATE listings SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(id);
  db.prepare('DELETE FROM review_checks WHERE listing_id = ?').run(id);
  res.json({ ok: true, status: 'pending' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/uploads', express.static('uploads', {
  dotfiles: 'deny', index: false, setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));
app.use(express.static('dist', { dotfiles: 'deny', index: 'index.html' }));
app.use((req, res) => res.status(404).send('Page not found'));
app.use((err, req, res, next) => {
  const code = err instanceof multer.MulterError ? 400 : err.status && err.status < 500 ? err.status : 500;
  if (code === 500) console.error(err);
  res.status(code).json({ error: code === 500 ? 'Something went wrong' : 'Check your request and try again' });
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`House Hunting running on http://localhost:${port}`));
