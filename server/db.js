import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    create table if not exists users (
      id integer primary key,
      username text not null,
      username_lower text not null unique,
      password_hash text not null,
      role text not null,
      disabled integer not null default 0,
      created_at text not null
    );
    create table if not exists app_state (
      id integer primary key,
      data text not null,
      updated_at text not null
    );
  `);
  return db;
}

export function getState(db) {
  const row = db.prepare('select data from app_state where id = 1').get();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (err) {
    console.warn('Failed to parse state payload', err);
    return null;
  }
}

export function saveState(db, state) {
  const payload = JSON.stringify(state);
  const now = new Date().toISOString();
  db.prepare(`
    insert into app_state (id, data, updated_at)
    values (1, ?, ?)
    on conflict(id) do update set data = excluded.data, updated_at = excluded.updated_at
  `).run(payload, now);
}

export function listUsers(db) {
  return db.prepare(`
    select id, username, role, disabled, created_at
    from users
    order by username_lower
  `).all();
}

export function getUserById(db, id) {
  return db.prepare('select * from users where id = ?').get(id);
}

export function getUserByUsernameLower(db, usernameLower) {
  return db.prepare('select * from users where username_lower = ?').get(usernameLower);
}

export function createUser(db, { username, usernameLower, passwordHash, role, disabled = 0 }) {
  const createdAt = new Date().toISOString();
  const info = db.prepare(`
    insert into users (username, username_lower, password_hash, role, disabled, created_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(username, usernameLower, passwordHash, role, disabled ? 1 : 0, createdAt);
  return getUserById(db, info.lastInsertRowid);
}

export function updateUser(db, { id, username, usernameLower, role, disabled }) {
  db.prepare(`
    update users
    set username = ?, username_lower = ?, role = ?, disabled = ?
    where id = ?
  `).run(username, usernameLower, role, disabled ? 1 : 0, id);
  return getUserById(db, id);
}

export function setUserPassword(db, { id, passwordHash }) {
  db.prepare('update users set password_hash = ? where id = ?').run(passwordHash, id);
  return getUserById(db, id);
}

export function deleteUser(db, id) {
  db.prepare('delete from users where id = ?').run(id);
}

export function countActiveAdmins(db, excludeId = null) {
  if (excludeId === null) {
    const row = db.prepare('select count(*) as count from users where role = ? and disabled = 0').get('Admin');
    return row?.count || 0;
  }
  const row = db.prepare('select count(*) as count from users where role = ? and disabled = 0 and id != ?').get('Admin', excludeId);
  return row?.count || 0;
}
