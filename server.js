// server.js (CommonJS)
const path = require("path");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// Colyseus
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");

// Rooms
const { LobbyRoom } = require("./rooms/LobbyRoom");
const { GameRoom } = require("./rooms/GameRoom");
const { ReplayRoom } = require("./rooms/ReplayRoom");

// DB
const db = require("./database");

// --- Config ---
const PORT = process.env.PORT || 3000;
const HMAC_SECRET = process.env.PLAYER_SECRET || "dev-secret-change-me";

// --- Express ---
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers: HMAC sign/verify ---
function signPlayerId(playerId) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(playerId).digest("hex");
}
function verifyPlayerId(playerId, token) {
  try {
    if (!playerId || !token) return false;
    const expected = signPlayerId(playerId);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- REST endpoints ---
app.post("/api/register", (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== "string" || username.trim().length < 2) {
      return res.status(400).json({ error: "Username must be at least 2 chars." });
    }
    const clean = username.trim().slice(0, 24);

    let player = db.getPlayerByUsername(clean);
    if (!player) {
      const playerId = db.createPlayer(clean);
      const token = signPlayerId(playerId);
      return res.json({ playerId, token, username: clean });
    } else {
      db.touchPlayer(player.id);
      const token = signPlayerId(player.id);
      return res.json({ playerId: player.id, token, username: player.username, color: player.color });
    }
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/player/color", (req, res) => {
  try {
    const { playerId, token, color } = req.body || {};
    if (!verifyPlayerId(playerId, token)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    if (!db.playerExists(playerId)) {
      return res.status(410).json({ error: "player not found" });
    }
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: "invalid color" });
    }
    db.updatePlayerColor(playerId, color);
    return res.json({ ok: true });
  } catch (e) {
    console.error("update color error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/history", (req, res) => {
  try {
    const lobbyId = req.query.lobbyId;
    if (!lobbyId) return res.status(400).json({ error: "lobbyId required" });

    // optional: basic existence check for game
    const clicks = db.getClicksForGame ? db.getClicksForGame(lobbyId) : [];
    return res.json({ clicks });
  } catch (e) {
    console.error("history error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

// --- HTTP server + Colyseus ---
const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("lobby", LobbyRoom, { db, verifyPlayer: verifyPlayerId });
gameServer.define("game", GameRoom, { db, verifyPlayer: verifyPlayerId });
gameServer.define("replay", ReplayRoom, { db, verifyPlayer: verifyPlayerId });

server.listen(PORT, () => {
  console.log(`✅ HTTP + Colyseus running on http://localhost:${PORT}`);
});
