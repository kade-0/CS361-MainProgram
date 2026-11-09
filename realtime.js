const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const store = require("./db");

const TEST_SESSION_MS = 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const RESUME_WINDOW_MS = 30 * 1000;
const MAX_BUFFERED = 100;
const MAX_MESSAGE_BYTES = 16 * 1024;

// close codes the client can read to know why it was disconnected

const CLOSE = {
  BAD_KEY: 4001,
  ROOM_FULL: 4003,
  NOT_FOUND: 4004,
  KEY_REVOKED: 4005,
  TEST_EXPIRED: 4008
};

// rooms map a game's public id to its sessions, keyed by client id

const rooms = new Map();
const sessionsByToken = new Map();

// request parsing function

function parseRequest(req) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/play\/(g_[0-9a-f]+)$/);
  if (!match) return null;
  return {
    publicId: match[1],
    key: url.searchParams.get("key") || req.headers["x-api-key"] || "",
    resume: url.searchParams.get("resume") || "",
    isTest: url.searchParams.get("test") === "1"
  };
}

// api key check function

function keysMatch(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// message sending functions

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function reject(ws, code, message) {
  send(ws, { type: "error", message });
  ws.close(code, message);
}

// sends to a session, or buffers the message while it is disconnected

function deliver(session, message) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) return send(session.ws, message);
  if (session.buffer.length < MAX_BUFFERED) session.buffer.push(message);
}

function broadcast(room, message, exceptId) {
  room.forEach(session => {
    if (session.clientId !== exceptId) deliver(session, message);
  });
}

// session lifecycle functions

function getRoom(publicId) {
  if (!rooms.has(publicId)) rooms.set(publicId, new Map());
  return rooms.get(publicId);
}

function createSession(room, game, ws) {
  const session = {
    clientId: crypto.randomBytes(4).toString("hex"),
    token: crypto.randomBytes(24).toString("hex"),
    publicId: game.public_id,
    ws,
    buffer: [],
    timer: null,
    ended: false
  };
  room.set(session.clientId, session);
  sessionsByToken.set(session.token, session);
  return session;
}

function removeSession(session, notify) {
  clearTimeout(session.timer);
  sessionsByToken.delete(session.token);
  const room = rooms.get(session.publicId);
  if (!room || !room.delete(session.clientId)) return;
  if (notify) broadcast(room, { type: "leave", clientId: session.clientId, players: room.size });
  if (room.size === 0) rooms.delete(session.publicId);
}

function holdSession(session) {
  session.ws = null;
  const room = rooms.get(session.publicId);
  broadcast(room, { type: "disconnected", clientId: session.clientId, players: room.size }, session.clientId);
  session.timer = setTimeout(() => removeSession(session, true), RESUME_WINDOW_MS);
}

// a clean close (code 1000) or a server kick ends the session

function handleClose(session, ws, code) {
  if (session.ws !== ws) return;
  if (code === 1000 || session.ended) return removeSession(session, true);
  holdSession(session);
}

// join functions

function joinNewSession(ws, game) {
  const room = getRoom(game.public_id);
  if (room.size >= game.max_players) {
    reject(ws, CLOSE.ROOM_FULL, "Session is full.");
    return null;
  }
  const session = createSession(room, game, ws);
  send(ws, { type: "welcome", clientId: session.clientId, resumeToken: session.token, resumed: false, players: room.size, maxPlayers: game.max_players });
  broadcast(room, { type: "join", clientId: session.clientId, players: room.size }, session.clientId);
  return session;
}

function resumeSession(ws, game, token) {
  const session = sessionsByToken.get(token);
  if (!session || session.publicId !== game.public_id) return null;
  const room = rooms.get(session.publicId);
  const old = session.ws;
  clearTimeout(session.timer);
  session.timer = null;
  session.ws = ws;
  if (old) old.terminate();
  const missed = session.buffer.splice(0);
  send(ws, { type: "welcome", clientId: session.clientId, resumeToken: session.token, resumed: true, players: room.size, maxPlayers: game.max_players, missed });
  if (!old) broadcast(room, { type: "reconnected", clientId: session.clientId, players: room.size }, session.clientId);
  return session;
}

// incoming message handler function

function handleMessage(session, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return send(session.ws, { type: "error", message: "Messages must be JSON." });
  }
  const room = rooms.get(session.publicId);
  if (message.type === "ping") return send(session.ws, { type: "pong", t: message.t, players: room.size });
  broadcast(room, { type: "message", from: session.clientId, data: message }, session.clientId);
}

// connection handler function

function handleConnection(ws, req) {
  const info = parseRequest(req);
  const game = store.findGameByPublicId(info.publicId);
  if (!game) return reject(ws, CLOSE.NOT_FOUND, "Game not found.");
  if (!keysMatch(info.key, game.api_key)) return reject(ws, CLOSE.BAD_KEY, "Invalid API key.");
  const session = (info.resume && resumeSession(ws, game, info.resume)) || joinNewSession(ws, game);
  if (!session) return;
  if (info.isTest) {
    store.markTested(game.id);
    const timer = setTimeout(() => {
      session.ended = true;
      ws.close(CLOSE.TEST_EXPIRED, "Test session ended.");
    }, TEST_SESSION_MS);
    ws.on("close", () => clearTimeout(timer));
  }
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);
  ws.on("message", raw => handleMessage(session, raw));
  ws.on("close", code => handleClose(session, ws, code));
}

// drop clients that stop responding

function startHeartbeat(wss) {
  const timer = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(timer));
}

// disconnects every client of a game, used when its api key is regenerated

function disconnectGame(publicId) {
  const room = rooms.get(publicId);
  if (!room) return;
  [...room.values()].forEach(session => {
    session.ended = true;
    if (session.ws) reject(session.ws, CLOSE.KEY_REVOKED, "API key was regenerated.");
    removeSession(session, false);
  });
}

// attaches the websocket server to the existing http server

function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on("upgrade", (req, socket, head) => {
    if (!parseRequest(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => handleConnection(ws, req));
  });
  startHeartbeat(wss);
  return wss;
}

module.exports = { attachRealtime, disconnectGame };
