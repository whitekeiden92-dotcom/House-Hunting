import { createHash, randomBytes } from 'node:crypto';

export const b64 = (buf) => buf.toString('base64url');
export const sha256 = (text) => createHash('sha256').update(text).digest('base64url');
export const newToken = () => b64(randomBytes(32));
export const isProd = process.env.NODE_ENV === 'production';

export function readCookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!part) return '';
  try {
    return decodeURIComponent(part.slice(name.length + 1));
  } catch {
    return '';
  }
}

export const cookieOpts = (extra = {}) => ({ httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', ...extra });
