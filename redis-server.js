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
const RedisManager = require("./redis/RedisManager");
const config = require("./config");

// --- Express ---
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Cloudflare compatibility middleware
app.use((req, res, next) => {
  // Trust Cloudflare proxy headers
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Allow WebSocket upgrades through Cloudflare
  if (req.headers.upgrade === 'websocket') {
    res.setHeader('Connection', 'upgrade');
    res.setHeader('Upgrade', 'websocket');
  }
  
  next();
});

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
    const redis = await gameData.getRedis();
    try {
      const existingPlayers = await redis.zrange('players:active', 0, -1);
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
        return res.json({ 
          playerId, 
          token, 
          username: clean,
          color: player.color
        });
      } else {
        // Update last seen
        await redis.hset(`player:${existingPlayer.id}`, 'lastSeen', Date.now());
        const token = signPlayerId(existingPlayer.id);
        return res.json({ 
          playerId: existingPlayer.id, 
          token, 
          username: existingPlayer.username, 
          color: existingPlayer.color 
        });
      }
    } finally {
      gameData.returnRedis(redis);
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

// Health check endpoint for Cloudflare
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "healthy", 
    timestamp: Date.now(),
    redis: "connected",
    rooms: ["redisLobby", "redisGame", "redisReplay"]
  });
});

// WebSocket upgrade endpoint for Cloudflare
app.get("/ws", (req, res) => {
  res.status(200).json({ 
    websocket: "available",
    upgrade: "supported"
  });
});

// --- HTTP server + Colyseus ---
const server = http.createServer(app);

// Parse -local flag
const useLocalRedis = process.argv.includes('-local');
const redisConfig = useLocalRedis ? config.redisLocal : config.redis;

// Create Redis driver for Colyseus
const redisDriver = new RedisDriver(redisConfig);

// Create Redis presence adapter
const RedisPresence = require('@colyseus/redis-presence').RedisPresence;
const presence = new RedisPresence(redisConfig);

const gameServer = new Server({
  transport: new WebSocketTransport({ 
    server,
    // Cloudflare compatibility settings
    pingInterval: config.colyseus.server.pingInterval,
    pingMaxRetries: config.colyseus.server.pingMaxRetries,
    maxPayloadLength: config.colyseus.server.maxPayloadLength,
  }),
  driver: redisDriver,
  presence: presence,
  // Server-level settings for Cloudflare and Docker
  server: {
    healthCheckInterval: config.colyseus.server.healthCheckInterval,
    healthCheckTimeout: config.colyseus.server.healthCheckTimeout,
    roomCleanupInterval: config.colyseus.server.roomCleanupInterval,
    connectTimeout: config.colyseus.server.connectTimeout,
    disconnectTimeout: config.colyseus.server.disconnectTimeout,
  }
});

// Define rooms with Redis driver
gameServer.define("redisLobby", RedisLobbyRoom, { 
  verifyPlayer: verifyPlayerId,
  allowReconnection: true,
  maxClients: 200 // Allow unlimited clients to prevent auto-disposal
});
gameServer.define("redisGame", RedisGameRoom, { 
  verifyPlayer: verifyPlayerId,
  allowReconnection: true,
  maxClients: 2 // Allow unlimited clients to prevent auto-disposal
});
gameServer.define("redisReplay", RedisReplayRoom, { 
  verifyPlayer: verifyPlayerId,
  allowReconnection: true,
  maxClients: 0 // Allow unlimited clients to prevent auto-disposal
});

// Clean up stale Colyseus entries at startup
async function cleanupStaleEntries() {
  try {
    const redis = new (require('ioredis'))(redisConfig);
    
    console.log('🧹 Starting cleanup of stale entries...');
    
    // Clean up ALL Colyseus-related keys first
    try {
      const allColyseusKeys = await redis.keys('colyseus:*');
      if (allColyseusKeys.length > 0) {
        console.log(`🧹 Cleaning up ${allColyseusKeys.length} Colyseus keys...`);
        await redis.del(...allColyseusKeys);
        console.log('✅ Cleaned up all Colyseus keys');
      }
    } catch (error) {
      console.log('ℹ️ No Colyseus keys found');
    }
    
    // Clean up stale process registrations
    try {
      const nodes = await redis.hgetall('colyseus:nodes');
      if (nodes && Object.keys(nodes).length > 0) {
        console.log('🧹 Cleaning up stale process registrations...');
        await redis.del('colyseus:nodes');
        console.log('✅ Cleaned up stale process registrations');
      }
    } catch (error) {
      console.log('ℹ️ No stale process registrations found');
    }
    
    // Clean up stale room caches
    try {
      const roomCaches = await redis.get('roomcaches');
      if (roomCaches) {
        console.log('🧹 Cleaning up stale room caches...');
        await redis.del('roomcaches');
        console.log('✅ Cleaned up stale room caches');
      }
    } catch (error) {
      console.log('ℹ️ No stale room caches found');
    }
    
    // Clean up any other stale Colyseus keys (double-check)
    try {
      const staleKeys = await redis.keys('colyseus:*');
      if (staleKeys.length > 0) {
        console.log('🧹 Final cleanup of remaining Colyseus keys...');
        await redis.del(...staleKeys);
        console.log(`✅ Cleaned up ${staleKeys.length} remaining Colyseus keys`);
      }
    } catch (error) {
      console.log('ℹ️ No remaining Colyseus keys found');
    }
    
    await redis.disconnect();
    console.log('✅ Cleanup completed successfully');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error; // Re-throw to prevent server from starting with cleanup errors
  }
}

// Initialize server with cleanup
async function initializeServer() {
  try {
    // Test Redis connection first using the manager
    const connectionSuccess = await RedisManager.testConnection();
    if (connectionSuccess) {
      console.log('✅ Redis connection verified on startup');
    } else {
      console.error('❌ Redis connection failed on startup - check network connectivity');
      process.exit(1);
    }
    
    // Clean up stale entries BEFORE starting server
    await cleanupStaleEntries();
    
    // Additional cleanup to prevent health check loops
    const redis = new (require('ioredis'))(redisConfig);
    try {
      // Force cleanup of any remaining process registrations
      await redis.del('colyseus:nodes');
      await redis.del('roomcaches');
      const remainingKeys = await redis.keys('colyseus:*');
      if (remainingKeys.length > 0) {
        await redis.del(...remainingKeys);
        console.log(`🧹 Force cleaned ${remainingKeys.length} remaining keys`);
      }
    } finally {
      await redis.disconnect();
    }
    
    // Start the server after cleanup is complete
    server.listen(config.server.port, '0.0.0.0', () => {
      console.log(`✅ Redis + Colyseus server running on http://0.0.0.0:${config.server.port}`);
      console.log(`📊 Using Redis at ${redisConfig.host}:${redisConfig.port}`);
      console.log(`🎮 Game rooms: redisLobby, redisGame, redisReplay`);
      console.log(`🔧 Redis presence enabled`);
      console.log('🚀 Server ready for connections');
      
      // Run additional cleanup after server is fully started
      setTimeout(async () => {
        console.log('🧹 Running post-startup cleanup...');
        await cleanupStaleEntries();
        console.log('✅ Post-startup cleanup completed');
      }, 2000);
    });
  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
  }
}

// Initialize the server
initializeServer();

// Add error handling for the game server
gameServer.onShutdown(() => {
  console.log('Game server shutting down...');
});

// Graceful shutdown
let isShuttingDown = false;

process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('SIGTERM received, shutting down gracefully...');
  try {
    // Shutdown the game server first
    await gameServer.gracefullyShutdown();
    console.log('✅ Game server shutdown completed');
    
    // Clean up Redis presence and driver
    if (presence && presence.shutdown) {
      await presence.shutdown();
      console.log('✅ Redis presence shutdown completed');
    }
    
    if (redisDriver && redisDriver.shutdown) {
      await redisDriver.shutdown();
      console.log('✅ Redis driver shutdown completed');
    }
    
    // Clean up Redis manager connections
    await RedisManager.cleanup();
    console.log('✅ Redis manager cleanup completed');
    
    console.log('✅ Server shutdown completed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('SIGINT received, shutting down gracefully...');
  try {
    // Shutdown the game server first
    await gameServer.gracefullyShutdown();
    console.log('✅ Game server shutdown completed');
    
    // Clean up Redis presence and driver
    if (presence && presence.shutdown) {
      await presence.shutdown();
      console.log('✅ Redis presence shutdown completed');
    }
    
    if (redisDriver && redisDriver.shutdown) {
      await redisDriver.shutdown();
      console.log('✅ Redis driver shutdown completed');
    }
    
    // Clean up Redis manager connections
    await RedisManager.cleanup();
    console.log('✅ Redis manager cleanup completed');
    
    console.log('✅ Server shutdown completed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});
