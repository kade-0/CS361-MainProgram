const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      description TEXT,
      max_players INTEGER NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      key_copied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )
  `);
  // Create the initial schema for our Database.
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// simple password hashing and verification functions

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

// user query functions

function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function findUserById(id) {
  return db.prepare("SELECT id, username, email, created_at FROM users WHERE id = ?").get(id);
}

// user creation function

function createUser(username, email, password) {
  const info = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)").run(username, email, hashPassword(password));
  return info.lastInsertRowid;
}

function newApiKey() {
  return "mps_" + crypto.randomBytes(24).toString("hex");
}

function newPublicId() {
  return "g_" + crypto.randomBytes(4).toString("hex");
}

function listGames(userId) {
  return db.prepare("SELECT * FROM games WHERE user_id = ? ORDER BY created_at, id").all(userId);
}

function countGames(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM games WHERE user_id = ?").get(userId).n;
}

function findGame(userId, id) {
  return db.prepare("SELECT * FROM games WHERE user_id = ? AND id = ?").get(userId, id);
}

function findGameByName(userId, name) {
  return db.prepare("SELECT * FROM games WHERE user_id = ? AND name = ?").get(userId, name);
}

function createGame(userId, { name, description, maxPlayers }) {
  const info = db.prepare("INSERT INTO games (public_id, user_id, name, description, max_players, api_key) VALUES (?, ?, ?, ?, ?, ?)").run(newPublicId(), userId, name, description || null, maxPlayers, newApiKey());
  return info.lastInsertRowid;
}

function regenerateApiKey(userId, id) {
  const key = newApiKey();
  db.prepare("UPDATE games SET api_key = ?, key_copied = 0 WHERE user_id = ? AND id = ?").run(key, userId, id);
  return key;
}

function markKeyCopied(userId, id) {
  db.prepare("UPDATE games SET key_copied = 1 WHERE user_id = ? AND id = ?").run(userId, id);
}

initSchema();

module.exports = { db, findUserByEmail, findUserByUsername, findUserById, createUser, verifyPassword, listGames, countGames, findGame, findGameByName, createGame, regenerateApiKey, markKeyCopied };
