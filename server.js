const express = require("express");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

function sendPage(name) {
  return (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
}

function redirectHome(req, res) {
  res.redirect("/login");
}

function setupMiddleware(app) {
  app.use(express.static(PUBLIC_DIR));
}

function setupRoutes(app) {
  app.get("/", redirectHome);
  app.get("/login", sendPage("login.html"));
  app.get("/signup", sendPage("signup.html"));
}

function startServer() {
  const app = express();
  setupMiddleware(app);
  setupRoutes(app);
  app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
}

startServer();
