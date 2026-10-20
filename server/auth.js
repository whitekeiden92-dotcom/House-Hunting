import express from 'express';
import { randomBytes } from 'node:crypto';
import { SignJWT, importPKCS8, createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './db.js';
import { b64, sha256, newToken, readCookie, cookieOpts, isProd } from './util.js';
import { sendWelcome } from './mailer.js';

const env = process.env;
const adminEmails = () => (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const redirectUri = (name) => `${env.APP_URL}/auth/${name}/callback`;

// Apple wants a short-lived client secret signed with your Sign in with Apple key.
async function appleClientSecret() {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_CLIENT_ID)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    keys: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    clientId: () => env.GOOGLE_CLIENT_ID,
    clientSecret: async () => env.GOOGLE_CLIENT_SECRET,
    scope: 'openid email profile',
    pkce: true,
    sameSite: 'lax',
    extra: { prompt: 'select_account' },
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    keys: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
    issuer: 'https://appleid.apple.com',
    clientId: () => env.APPLE_CLIENT_ID,
    clientSecret: appleClientSecret,
    scope: 'name email',
    pkce: false,
    sameSite: 'none', // Apple posts back cross-site, so the state cookie must be SameSite=None
    extra: { response_mode: 'form_post' },
  },
};

export const authRouter = express.Router();

authRouter.get('/:provider', (req, res) => {
  const name = req.params.provider;
  const p = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
  if (!p) return res.sendStatus(404);
  if (!p.clientId()) return res.status(404).send('This sign-in option is not set up yet.');
  const st = { state: b64(randomBytes(24)), nonce: b64(randomBytes(24)), verifier: b64(randomBytes(32)) };
  res.cookie('hh_oauth', b64(Buffer.from(JSON.stringify(st))), cookieOpts({
    path: '/auth', maxAge: 10 * 60e3, sameSite: p.sameSite, secure: p.sameSite === 'none' || isProd,
  }));
  const params = {
    client_id: p.clientId(), redirect_uri: redirectUri(name), response_type: 'code',
    scope: p.scope, state: st.state, nonce: st.nonce, ...p.extra,
  };
  if (p.pkce) Object.assign(params, { code_challenge: sha256(st.verifier), code_challenge_method: 'S256' });
  res.redirect(`${p.authUrl}?${new URLSearchParams(params)}`);
});

authRouter.all('/:provider/callback', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const name = req.params.provider;
  const p = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
  if (!p) return res.sendStatus(404);
  if (!p.clientId()) return res.status(404).send('This sign-in option is not set up yet.');
  const src = { ...req.query, ...req.body };
  let st = {};
  try {
    st = JSON.parse(Buffer.from(readCookie(req, 'hh_oauth'), 'base64url').toString());
  } catch {
    st = {};
  }
  res.clearCookie('hh_oauth', { path: '/auth' });
  if (!st.state || src.state !== st.state || typeof src.code !== 'string') {
    return res.status(400).send('Sign-in expired. Please try again.');
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: src.code, redirect_uri: redirectUri(name),
      client_id: p.clientId(), client_secret: await p.clientSecret(),
    });
    if (p.pkce) body.set('code_verifier', st.verifier);
    const tokenRes = await fetch(p.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(10000),
    });
    const tokens = await tokenRes.json();
    if (!tokens.id_token) throw new Error('no id_token returned');
    const { payload } = await jwtVerify(tokens.id_token, p.keys, { issuer: p.issuer, audience: p.clientId() });
    if (payload.nonce !== st.nonce) throw new Error('nonce mismatch');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase().slice(0, 254) : null;
    const displayName = typeof payload.name === 'string' ? payload.name.slice(0, 100) : null;
    const isNewUser = !db.prepare('SELECT 1 FROM users WHERE provider = ? AND provider_sub = ?').get(name, String(payload.sub));
    const user = db.prepare(`INSERT INTO users (provider, provider_sub, email, name) VALUES (?, ?, ?, ?)
      ON CONFLICT (provider, provider_sub) DO UPDATE SET email = excluded.email RETURNING id`)
      .get(name, String(payload.sub), email, displayName);
    db.prepare('UPDATE users SET role = ? WHERE id = ?')
      .run(email && adminEmails().includes(email) ? 'admin' : 'user', user.id);
    if (isNewUser && email) sendWelcome(email, displayName).catch((err) => console.error('Welcome email failed:', err.message));
    const token = newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, Date.now() + 30 * 864e5);
    res.cookie('hh_session', token, cookieOpts({ maxAge: 30 * 864e5 }));
    res.redirect(`${env.APP_URL}/app.html#/listings`);
  } catch (err) {
    console.error('Sign-in failed for', name, err.message);
    res.status(400).send('Sign-in failed. Please try again.');
  }
});
