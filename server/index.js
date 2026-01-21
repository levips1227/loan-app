import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDb,
  getState,
  saveState,
  listUsers,
  getUserById,
  getUserByUsernameLower,
  createUser,
  updateUser,
  setUserPassword,
  deleteUser,
  countActiveAdmins,
} from './db.js';
import { defaultAdminSettings, defaultState } from './defaultState.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'loan-app.sqlite');
const JWT_SECRET = process.env.JWT_SECRET || '';
const FALLBACK_JWT_SECRET = JWT_SECRET || 'dev-insecure-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PASSWORD_MIN_LENGTH = 8;
const RESET_ADMIN_ON_START = process.env.RESET_ADMIN_ON_START === 'true';

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const db = initDb(DB_PATH);

function normalizeUsername(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: !!user.disabled,
    createdAt: user.created_at,
  };
}

function ensureDefaultState() {
  const state = getState(db);
  if (!state) {
    saveState(db, defaultState);
    return defaultState;
  }
  return state;
}

function ensureDefaultAdmin() {
  const admins = countActiveAdmins(db);
  if (admins > 0 && !RESET_ADMIN_ON_START) return;
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'Admin');
  const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || 'change-me-please';
  if (!username || !password || password.length < PASSWORD_MIN_LENGTH) {
    console.warn('Default admin not created: set ADMIN_USERNAME and ADMIN_PASSWORD (min 8 chars).');
    return;
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const existing = getUserByUsernameLower(db, username.toLowerCase());
  if (existing) {
    setUserPassword(db, { id: existing.id, passwordHash });
    const updated = updateUser(db, {
      id: existing.id,
      username,
      usernameLower: username.toLowerCase(),
      role: 'Admin',
      disabled: 0,
    });
    console.log(`Admin user reset: ${updated.username}`);
  } else {
    createUser(db, {
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      role: 'Admin',
      disabled: 0,
    });
    console.log(`Default admin created: ${username}`);
  }
  if (usingDefaultPassword) {
    console.warn('Using default admin password. Set ADMIN_PASSWORD before production.');
  }
}

if (!JWT_SECRET) {
  if (NODE_ENV === 'production') {
    console.error('JWT_SECRET not set. Refusing to start in production.');
    process.exit(1);
  }
  console.warn('JWT_SECRET not set. Using insecure default secret.');
}

function getJwtSecret() {
  return FALLBACK_JWT_SECRET;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    getJwtSecret(),
    { expiresIn: '7d' },
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
  });
}

function getUserFromRequest(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = getUserById(db, payload.id);
    if (!user || user.disabled) return null;
    return user;
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  return next();
}

function requireAdmin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  return next();
}

function normalizeState(input) {
  const safe = {
    loans: Array.isArray(input?.loans) ? input.loans : defaultState.loans,
    payments: Array.isArray(input?.payments) ? input.payments : defaultState.payments,
    draws: Array.isArray(input?.draws) ? input.draws : [],
    selectedId: input?.selectedId ?? defaultState.selectedId,
    admin: {
      ...defaultAdminSettings,
      ...(typeof input?.admin === 'object' && input.admin ? input.admin : {}),
    },
  };
  if (!Array.isArray(safe.admin.frequencies)) {
    safe.admin.frequencies = defaultAdminSettings.frequencies;
  }
  if (safe.loans.length === 0) {
    safe.selectedId = null;
  } else if (!safe.loans.some((loan) => loan.id === safe.selectedId)) {
    safe.selectedId = safe.loans[0].id;
  }
  return safe;
}

ensureDefaultState();
ensureDefaultAdmin();

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password || '';
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = getUserByUsernameLower(db, username.toLowerCase());
  if (!user || user.disabled) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  setSessionCookie(res, user);
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/state', requireAuth, (req, res) => {
  const state = getState(db) || defaultState;
  res.json({ state });
});

app.put('/api/state', requireAuth, (req, res) => {
  const state = normalizeState(req.body || {});
  saveState(db, state);
  res.json({ state });
});

app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers(db) });
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password || '';
  const role = req.body?.role === 'Admin' ? 'Admin' : 'Standard User';
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const exists = getUserByUsernameLower(db, username.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Username already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser(db, {
    username,
    usernameLower: username.toLowerCase(),
    passwordHash,
    role,
    disabled: 0,
  });
  res.status(201).json({ user: sanitizeUser(user) });
});

app.put('/api/users/me/password', requireAuth, async (req, res) => {
  const currentPassword = req.body?.currentPassword || '';
  const newPassword = req.body?.newPassword || '';
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const user = getUserById(db, req.user.id);
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Choose a password different from the current one.' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  setUserPassword(db, { id: req.user.id, passwordHash });
  return res.json({ ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const existing = getUserById(db, id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const username = normalizeUsername(req.body?.username ?? existing.username);
  const role = req.body?.role === 'Admin'
    ? 'Admin'
    : req.body?.role === 'Standard User'
      ? 'Standard User'
      : existing.role;
  const disabled = typeof req.body?.disabled === 'boolean' ? req.body.disabled : !!existing.disabled;
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  const lower = username.toLowerCase();
  const collision = getUserByUsernameLower(db, lower);
  if (collision && collision.id !== id) {
    return res.status(409).json({ error: 'Username already exists.' });
  }
  if (existing.role === 'Admin' && role !== 'Admin' && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'At least one admin must remain.' });
  }
  if (existing.role === 'Admin' && disabled && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'Keep at least one admin active.' });
  }
  const updated = updateUser(db, {
    id,
    username,
    usernameLower: lower,
    role,
    disabled,
  });
  if (req.user.id === id) {
    if (updated.disabled) {
      clearSessionCookie(res);
    } else {
      setSessionCookie(res, updated);
    }
  }
  return res.json({ user: sanitizeUser(updated) });
});

app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const password = req.body?.password || '';
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const user = getUserById(db, id);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  setUserPassword(db, { id, passwordHash });
  return res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const existing = getUserById(db, id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (existing.role === 'Admin' && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'Cannot delete the last admin.' });
  }
  deleteUser(db, id);
  if (req.user.id === id) {
    clearSessionCookie(res);
  }
  return res.status(204).end();
});

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
