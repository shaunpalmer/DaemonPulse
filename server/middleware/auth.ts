/**
 * Auth Middleware — JWT verification for protected routes.
 *
 * Attaches the decoded payload to res.locals.user so downstream
 * route handlers can use it without re-decoding.
 */

import { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'change_this_before_deploying';

interface AuthPayload {
  sub: number;
  username: string;
  role: 'admin' | 'viewer';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as AuthPayload;
    res.locals['user'] = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Use this for admin-only routes.
 * Kept intentionally as security scaffolding for privileged remote orchestration routes.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = res.locals['user'] as AuthPayload | undefined;
    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
    next();
  });
}
