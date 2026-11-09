const express = require("express");
const path = require("path");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const users = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-secret-change-me";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (users.findUserByUsername(username.trim())) return "Username is already taken.";
  if (users.findUserByEmail(email.trim())) return "An account with this email already exists.";
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
  const id = users.createUser(req.body.username.trim(), req.body.email.trim(), req.body.password);
  startSession(req, res, id);
}

// login handler function

function handleLogin(req, res) {
  const { email, password } = req.body;
  const user = email && users.findUserByEmail(email.trim());
  if (!user || !password || !users.verifyPassword(password, user.password_hash)) {
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
  res.json(users.findUserById(req.session.userId));
}

// SQLite session store setup function

function setupSQLiteSession(app) {
  app.use(express.json());
  app.use(session({
    store: new SqliteStore({ client: users.db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
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
