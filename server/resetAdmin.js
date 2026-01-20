import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getUserByUsernameLower, createUser, updateUser, setUserPassword } from './db.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'loan-app.sqlite');
const PASSWORD_MIN_LENGTH = 8;

function normalizeUsername(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

const username = normalizeUsername(process.env.ADMIN_USERNAME || 'Admin');
const password = process.env.ADMIN_PASSWORD || 'change-me-please';

if (!username || password.length < PASSWORD_MIN_LENGTH) {
  console.error('ADMIN_USERNAME or ADMIN_PASSWORD invalid (min 8 chars).');
  process.exit(1);
}

const db = initDb(DB_PATH);
const passwordHash = bcrypt.hashSync(password, 10);
const existing = getUserByUsernameLower(db, username.toLowerCase());

if (existing) {
  setUserPassword(db, { id: existing.id, passwordHash });
  updateUser(db, {
    id: existing.id,
    username,
    usernameLower: username.toLowerCase(),
    role: 'Admin',
    disabled: 0,
  });
  console.log(`Reset admin password for ${username}.`);
} else {
  createUser(db, {
    username,
    usernameLower: username.toLowerCase(),
    passwordHash,
    role: 'Admin',
    disabled: 0,
  });
  console.log(`Created admin user ${username}.`);
}
