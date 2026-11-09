const express = require("express");
const path = require("path");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const store = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-secret-change-me";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GAME_LIMIT = 5;
const WS_BASE_URL = process.env.WS_BASE_URL || `ws://localhost:${PORT}/play`;

function sendPage(name) {
  return (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
}

// redirection functions

function redirectHome(req, res) {
  res.redirect(req.session.userId ? "/games" : "/login");
}

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Your session has expired. Log in again to continue." });
  res.redirect("/login?expired=1");
}

// signup validation function

function validateSignup({ username, email, password }) {
  if (!username || !username.trim()) return "Username is required.";
  if (!email || !EMAIL_RE.test(email)) return "Enter a valid email address.";
  if (!password || password.length < 8) return "Password must be at least 8 characters.";
  if (store.findUserByUsername(username.trim())) return "Username is already taken.";
  if (store.findUserByEmail(email.trim())) return "An account with this email already exists.";
  return null;
}

// session start function

function startSession(req, res, userId) {
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Something went wrong. Try again." });
    req.session.userId = userId;
    res.json({ redirect: "/games" });
  });
}

// signup handler function

function handleSignup(req, res) {
  const error = validateSignup(req.body);
  if (error) return res.status(400).json({ error });
  const id = store.createUser(req.body.username.trim(), req.body.email.trim(), req.body.password);
  startSession(req, res, id);
}

// login handler function

function handleLogin(req, res) {
  const { email, password } = req.body;
  const user = email && store.findUserByEmail(email.trim());
  if (!user || !password || !store.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  startSession(req, res, user.id);
}

// logout handler function

function handleLogout(req, res) {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
}

// current user handler function

function handleMe(req, res) {
  res.json(store.findUserById(req.session.userId));
}

// game response shape functions

function gameSummary(game) {
  return { id: game.id, name: game.name, maxPlayers: game.max_players, createdAt: game.created_at };
}

function gameDetail(game) {
  return { ...gameSummary(game), description: game.description, apiKey: game.api_key, endpoint: `${WS_BASE_URL}/${game.public_id}`, keyCopied: !!game.key_copied };
}

// game validation function

function validateGame(userId, { name, description, maxPlayers }) {
  const trimmed = (name || "").trim();
  if (trimmed.length < 3 || trimmed.length > 40) return "Game name must be 3 to 40 characters.";
  if (description && description.length > 200) return "Description must be 200 characters or less.";
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 16) return "Max players must be between 2 and 16.";
  if (store.countGames(userId) >= GAME_LIMIT) return `You have reached the limit of ${GAME_LIMIT} games.`;
  if (store.findGameByName(userId, trimmed)) return "You already have a game with this name.";
  return null;
}

// game lookup function

function loadGame(req, res, next) {
  const game = store.findGame(req.session.userId, Number(req.params.id));
  if (!game) return res.status(404).json({ error: "Game not found." });
  req.game = game;
  next();
}

// game handler functions

function handleListGames(req, res) {
  res.json({ games: store.listGames(req.session.userId).map(gameSummary), limit: GAME_LIMIT });
}

function handleCreateGame(req, res) {
  const error = validateGame(req.session.userId, req.body);
  if (error) return res.status(400).json({ error });
  const id = store.createGame(req.session.userId, { name: req.body.name.trim(), description: (req.body.description || "").trim(), maxPlayers: req.body.maxPlayers });
  res.status(201).json({ redirect: `/games/${id}?registered=1` });
}

function handleGetGame(req, res) {
  res.json(gameDetail(req.game));
}

function handleRegenerateKey(req, res) {
  res.json({ apiKey: store.regenerateApiKey(req.session.userId, req.game.id) });
}

function handleKeyCopied(req, res) {
  store.markKeyCopied(req.session.userId, req.game.id);
  res.status(204).end();
}

// SQLite session store setup function

function setupSQLiteSession(app) {
  app.use(express.json());
  app.use(session({
    store: new SqliteStore({ client: store.db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));
  app.use(express.static(PUBLIC_DIR, { index: false }));
}

function setupRoutes(app) {
  app.get("/", redirectHome);
  app.get("/login", sendPage("login.html"));
  app.get("/signup", sendPage("signup.html"));
  app.get("/games", requireAuth, sendPage("games.html"));
  app.get("/games/new", requireAuth, sendPage("register.html"));
  app.get("/games/:id(\\d+)", requireAuth, sendPage("game.html"));
  app.get("/api/games", requireAuth, handleListGames);
  app.post("/api/games", requireAuth, handleCreateGame);
  app.get("/api/games/:id(\\d+)", requireAuth, loadGame, handleGetGame);
  app.post("/api/games/:id(\\d+)/regenerate-key", requireAuth, loadGame, handleRegenerateKey);
  app.post("/api/games/:id(\\d+)/key-copied", requireAuth, loadGame, handleKeyCopied);
  app.post("/api/signup", handleSignup);
  app.post("/api/login", handleLogin);
  app.get("/api/me", requireAuth, handleMe);
  app.get("/logout", handleLogout);
}

function startServer() {
  const app = express();
  setupSQLiteSession(app);
  setupRoutes(app);
  app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
}

startServer();
