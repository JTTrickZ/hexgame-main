// redis-server.js
const path = require("path");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// Colyseus
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { RedisDriver } = require("@colyseus/redis-driver");

// Redis Rooms
const { RedisLobbyRoom } = require("./rooms/RedisLobbyRoom");
const { RedisGameRoom } = require("./rooms/RedisGameRoom");
const { RedisReplayRoom } = require("./rooms/RedisReplayRoom");

// Redis Data Layer
const GameData = require("./redis/GameData");
const config = require("./config");

// --- Express ---
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers: HMAC sign/verify ---
function signPlayerId(playerId) {
  return crypto.createHmac("sha256", config.server.hmacSecret).update(playerId).digest("hex");
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
app.post("/api/register", async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== "string" || username.trim().length < 2) {
      return res.status(400).json({ error: "Username must be at least 2 chars." });
    }
    
    const clean = username.trim().slice(0, 24);
    const gameData = new GameData();

    // Check if player exists by username (simplified - in production you'd want a username index)
    const existingPlayers = await gameData.redis.zrange('players:active', 0, -1);
    let existingPlayer = null;
    
    for (const playerId of existingPlayers) {
      const player = await gameData.getPlayer(playerId);
      if (player && player.username === clean) {
        existingPlayer = player;
        break;
      }
    }

    if (!existingPlayer) {
      const playerId = await gameData.createPlayer(clean);
      const token = signPlayerId(playerId);
      const player = await gameData.getPlayer(playerId);
      await gameData.disconnect();
      return res.json({ 
        playerId, 
        token, 
        username: clean,
        color: player.color
      });
    } else {
      // Update last seen
      await gameData.redis.hset(`player:${existingPlayer.id}`, 'lastSeen', Date.now());
      const token = signPlayerId(existingPlayer.id);
      await gameData.disconnect();
      return res.json({ 
        playerId: existingPlayer.id, 
        token, 
        username: existingPlayer.username, 
        color: existingPlayer.color 
      });
    }
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/player/color", async (req, res) => {
  try {
    const { playerId, token, color } = req.body || {};
    if (!verifyPlayerId(playerId, token)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    
    const gameData = new GameData();
    if (!(await gameData.playerExists(playerId))) {
      return res.status(410).json({ error: "player not found" });
    }
    
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: "invalid color" });
    }
    
    await gameData.updatePlayerColor(playerId, color);
    await gameData.disconnect();
    return res.json({ ok: true });
  } catch (e) {
    console.error("update color error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const lobbyId = req.query.lobbyId;
    if (!lobbyId) return res.status(400).json({ error: "lobbyId required" });

    const gameData = new GameData();
    const events = await gameData.getGameEvents(lobbyId);
    await gameData.disconnect();
    
    return res.json({ clicks: events });
  } catch (e) {
    console.error("history error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

// --- HTTP server + Colyseus ---
const server = http.createServer(app);

// Create Redis driver for Colyseus
const redisDriver = new RedisDriver(config.redis);

const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
  driver: redisDriver,
});

// Define rooms with Redis driver
gameServer.define("redisLobby", RedisLobbyRoom, { verifyPlayer: verifyPlayerId });
gameServer.define("redisGame", RedisGameRoom, { verifyPlayer: verifyPlayerId });
gameServer.define("redisReplay", RedisReplayRoom, { verifyPlayer: verifyPlayerId });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await gameServer.gracefullyShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await gameServer.gracefullyShutdown();
  process.exit(0);
});

server.listen(config.server.port, () => {
  console.log(`✅ Redis + Colyseus server running on http://localhost:${config.server.port}`);
  console.log(`📊 Using Redis at ${config.redis.host}:${config.redis.port}`);
  console.log(`🎮 Game rooms: redisLobby, redisGame, redisReplay`);
});
