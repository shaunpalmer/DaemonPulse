/**
 * Auth Routes — /api/auth/login, /api/auth/logout
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/schema';

export const authRouter = Router();

const JWT_SECRET  = process.env['JWT_SECRET'] ?? 'change_this_before_deploying';
const JWT_EXPIRES = '8h';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'viewer';
}

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  );

  res.json({ token });
});

authRouter.post('/logout', (_req, res) => {
  // JWT is stateless — client deletes the token. Nothing to do server-side.
  res.json({ ok: true });
});
