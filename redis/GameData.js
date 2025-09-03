// redis/GameData.js
const RedisManager = require("./RedisManager");
const config = require("../config");

class GameData {
  constructor() {
    this.redisManager = RedisManager;
    this.HEX_DIRS = [
      {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
      {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1},
    ];
  }

  // Get Redis connection for this instance
  async getRedis() {
    return await this.redisManager.getConnection();
  }

  // Return Redis connection to pool
  returnRedis(redis) {
    this.redisManager.returnConnection(redis);
  }

  // Helper method to check if Redis is available
  async isRedisAvailable() {
    try {
      const redis = await this.getRedis();
      await redis.ping();
      this.returnRedis(redis);
      return true;
    } catch (error) {
      console.error('Redis ping failed:', error.message);
      return false;
    }
  }

  // Test Redis connection and log status
  async testConnection() {
    try {
      const redis = await this.getRedis();
      const start = Date.now();
      await redis.ping();
      const latency = Date.now() - start;
      this.returnRedis(redis);
      console.log(`✅ Redis connection test successful (${latency}ms latency)`);
      return true;
    } catch (error) {
      console.error('❌ Redis connection test failed:', error.message);
      return false;
    }
  }

  // Player Management
  async createPlayer(username) {
    const redis = await this.getRedis();
    try {
      const playerId = `player:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      const color = config.game.playerColors[Math.floor(Math.random() * config.game.playerColors.length)];
      
      const player = {
        id: playerId,
        username: username.trim().slice(0, 24),
        color,
        createdAt: Date.now(),
        lastSeen: Date.now()
      };

      // Store player data in organized structure
      await redis.hset(`players:${playerId}:data`, player);
      await redis.zadd('players:active', Date.now(), playerId);
      
      return playerId;
    } finally {
      this.returnRedis(redis);
    }
  }

  async getPlayer(playerId) {
    const redis = await this.getRedis();
    try {
      const player = await redis.hgetall(`players:${playerId}:data`);
      return Object.keys(player).length > 0 ? player : null;
    } finally {
      this.returnRedis(redis);
    }
  }

  async updatePlayerColor(playerId, color) {
    const redis = await this.getRedis();
    try {
      await redis.hset(`players:${playerId}:data`, 'color', color);
    } finally {
      this.returnRedis(redis);
    }
  }

  async playerExists(playerId) {
    const redis = await this.getRedis();
    try {
      return await redis.exists(`players:${playerId}:data`);
    } finally {
      this.returnRedis(redis);
    }
  }

  async updatePlayerSession(playerId, sessionId) {
    const redis = await this.getRedis();
    try {
      await redis.set(`players:${playerId}:session`, sessionId, 'EX', 3600); // 1 hour expiry
    } finally {
      this.returnRedis(redis);
    }
  }

  async getPlayerSession(playerId) {
    const redis = await this.getRedis();
    try {
      return await redis.get(`players:${playerId}:session`);
    } finally {
      this.returnRedis(redis);
    }
  }

  // Lobby Management
  async createLobby(lobbyId) {
    const redis = await this.getRedis();
    try {
      const lobby = {
        id: lobbyId,
        createdAt: Date.now(),
        status: 'active',
        lobbyStartTime: Date.now()
      };

      await redis.hset(`lobbies:${lobbyId}:data`, lobby);
      await redis.zadd('lobbies:active', Date.now(), lobbyId);
    } finally {
      this.returnRedis(redis);
    }
  }

  async getLobby(lobbyId) {
    const redis = await this.getRedis();
    try {
      const lobby = await redis.hgetall(`lobbies:${lobbyId}:data`);
      return Object.keys(lobby).length > 0 ? lobby : null;
    } finally {
      this.returnRedis(redis);
    }
  }

  async addPlayerToLobby(lobbyId, playerId) {
    const redis = await this.getRedis();
    try {
      await redis.sadd(`lobbies:${lobbyId}:players`, playerId);
    } finally {
      this.returnRedis(redis);
    }
  }

  async removePlayerFromLobby(lobbyId, playerId) {
    const redis = await this.getRedis();
    try {
      await redis.srem(`lobbies:${lobbyId}:players`, playerId);
    } finally {
      this.returnRedis(redis);
    }
  }

  async getLobbyPlayers(lobbyId) {
    const redis = await this.getRedis();
    try {
      return await redis.smembers(`lobbies:${lobbyId}:players`);
    } finally {
      this.returnRedis(redis);
    }
  }

  async closeLobby(lobbyId) {
    const redis = await this.getRedis();
    try {
      await redis.zrem('lobbies:active', lobbyId);
      await redis.hset(`lobbies:${lobbyId}:data`, 'status', 'closed', 'closedAt', Date.now());
    } finally {
      this.returnRedis(redis);
    }
  }

  // Game Management
  async createGame(gameId, startPlayers = []) {
    const redis = await this.getRedis();
    try {
      const game = {
        id: gameId,
        createdAt: Date.now(),
        status: 'active',
        startPlayers: JSON.stringify(startPlayers),
        lobbyStartTime: Date.now()
      };

      await redis.hset(`games:${gameId}:data`, game);
      await redis.zadd('games:active', Date.now(), gameId);
      
      // Add players to game
      for (const player of startPlayers) {
        await redis.sadd(`games:${gameId}:players`, player.playerId);
        // Initialize player points
        await this.setPlayerPoints(gameId, player.playerId, config.game.startingPoints, config.game.startingMaxPoints);
      }
    } finally {
      this.returnRedis(redis);
    }
  }

  async getGame(gameId) {
    const redis = await this.getRedis();
    try {
      const game = await redis.hgetall(`games:${gameId}:data`);
      if (Object.keys(game).length === 0) return null;
      
      game.startPlayers = JSON.parse(game.startPlayers || '[]');
      return game;
    } finally {
      this.returnRedis(redis);
    }
  }

  async updateGameStatus(gameId, status) {
    const redis = await this.getRedis();
    try {
      await redis.hset(`games:${gameId}:data`, 'status', status);
    } finally {
      this.returnRedis(redis);
    }
  }

  async addPlayerToGame(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      await redis.sadd(`games:${gameId}:players`, playerId);
    } finally {
      this.returnRedis(redis);
    }
  }

  async removePlayerFromGame(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      await redis.srem(`games:${gameId}:players`, playerId);
    } finally {
      this.returnRedis(redis);
    }
  }

  async getGamePlayers(gameId) {
    const redis = await this.getRedis();
    try {
      return await redis.smembers(`games:${gameId}:players`);
    } finally {
      this.returnRedis(redis);
    }
  }

  // Hex Management
  async setHex(gameId, q, r, playerId, color, upgrade = null, terrain = null, isStart = false) {
    const hexKey = `${q}:${r}`;
    const hex = {
      q: q.toString(),
      r: r.toString(),
      playerId,
      color,
      upgrade: upgrade || '',
      terrain: terrain || '',
      captureTime: Date.now(),
      isStart: isStart
    };

    const redis = await this.getRedis();
    try {
      await redis.hset(`games:${gameId}:hexes`, hexKey, JSON.stringify(hex));
      // Note: Hex count is now calculated dynamically when needed via getHexCountForPlayer
    } finally {
      this.returnRedis(redis);
    }
  }

  async getHex(gameId, q, r) {
    const redis = await this.getRedis();
    try {
      const hexData = await redis.hget(`games:${gameId}:hexes`, `${q}:${r}`);
      return hexData ? JSON.parse(hexData) : null;
    } finally {
      this.returnRedis(redis);
    }
  }

  async getAllHexes(gameId) {
    const redis = await this.getRedis();
    try {
      const hexes = await redis.hgetall(`games:${gameId}:hexes`);
      return Object.values(hexes).map(hex => JSON.parse(hex));
    } finally {
      this.returnRedis(redis);
    }
  }

  async getHexOwner(gameId, q, r) {
    return await this.getHex(gameId, q, r);
  }

  async setHexUpgrade(gameId, q, r, upgrade) {
    const redis = await this.getRedis();
    try {
      const hex = await this.getHex(gameId, q, r);
      if (hex) {
        hex.upgrade = upgrade;
        hex.upgradeTime = Date.now();
        await redis.hset(`games:${gameId}:hexes`, `${q}:${r}`, JSON.stringify(hex));
      }
    } finally {
      this.returnRedis(redis);
    }
  }

  // ===== CENTRALIZED POINTS MANAGEMENT =====
  
  /**
   * Calculate max points based on current game state
   * This is the AUTHORITATIVE source for max points calculation
   */
  async calculateMaxPoints(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      // Get all hexes for this player
      const hexes = await redis.hgetall(`games:${gameId}:hexes`);
      const playerHexes = Object.values(hexes)
        .map(hex => JSON.parse(hex))
        .filter(hex => hex.playerId === playerId);
      
      // Count banks and total tiles
      const bankCount = playerHexes.filter(h => h.upgrade === 'bank').length;
      const tileCount = playerHexes.length;
      
      // Calculate max points: base + banks (50 each) + tiles (5 each)
      const maxPoints = config.game.startingMaxPoints + (bankCount * 50) + (tileCount * 5);
      
      return maxPoints;
    } finally {
      this.returnRedis(redis);
    }
  }

  /**
   * Get player points with calculated max points
   * This is the AUTHORITATIVE source for getting player points
   */
  async getPlayerPoints(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      const pointsData = await redis.hget(`games:${gameId}:points`, playerId);
      if (!pointsData) {
        // Initialize with default values
        const defaultPoints = config.game.startingPoints;
        const defaultMaxPoints = config.game.startingMaxPoints;
        await this.setPlayerPoints(gameId, playerId, defaultPoints, defaultMaxPoints);
        return { 
          playerId, 
          points: defaultPoints.toString(), 
          maxPoints: defaultMaxPoints.toString(),
          tiles: "0"
        };
      }
      
      const data = JSON.parse(pointsData);
      
      // Always calculate current max points based on current game state
      const currentMaxPoints = await this.calculateMaxPoints(gameId, playerId);
      
      return {
        ...data,
        maxPoints: currentMaxPoints.toString()
      };
    } catch (error) {
      console.warn("Error getting player points:", error.message);
      return { playerId, points: "0", maxPoints: "0", tiles: "0" };
    } finally {
      this.returnRedis(redis);
    }
  }

  /**
   * Update player points with proper clamping
   * This is the AUTHORITATIVE source for updating player points
   */
  async updatePlayerPoints(gameId, playerId, newPoints) {
    const redis = await this.getRedis();
    try {
      // Get current points and calculate current max
      const current = await this.getPlayerPoints(gameId, playerId);
      const currentMaxPoints = await this.calculateMaxPoints(gameId, playerId);
      
      // Clamp points to valid range
      const clampedPoints = Math.max(0, Math.min(newPoints, currentMaxPoints));
      
      // Preserve start coordinates when updating points
      const startQ = current.startQ || null;
      const startR = current.startR || null;
      
      await this.setPlayerPoints(gameId, playerId, clampedPoints, currentMaxPoints, startQ, startR);
      return clampedPoints;
    } catch (error) {
      console.warn("Error updating player points:", error.message);
      return 0;
    } finally {
      this.returnRedis(redis);
    }
  }

  /**
   * Set player points (internal method)
   * This should only be called by the authoritative methods above
   */
  async setPlayerPoints(gameId, playerId, points, maxPoints, startQ = null, startR = null) {
    const redis = await this.getRedis();
    try {
      const pointsData = {
        playerId,
        points: points.toString(),
        maxPoints: maxPoints.toString(),
        lastUpdate: Date.now()
      };
      
      if (startQ !== null) pointsData.startQ = startQ.toString();
      if (startR !== null) pointsData.startR = startR.toString();
      
      await redis.hset(`games:${gameId}:points`, playerId, JSON.stringify(pointsData));
    } finally {
      this.returnRedis(redis);
    }
  }

  /**
   * Get hex count for player (for tiles display)
   */
  async getHexCountForPlayer(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      const hexes = await redis.hgetall(`games:${gameId}:hexes`);
      const playerHexes = Object.values(hexes)
        .map(hex => JSON.parse(hex))
        .filter(hex => hex.playerId === playerId);
      return playerHexes.length;
    } catch (error) {
      console.warn("Error getting hex count for player:", error.message);
      return 0;
    } finally {
      this.returnRedis(redis);
    }
  }

  /**
   * Recalculate and update player points (for UI updates)
   * This is the AUTHORITATIVE method for recalculating points
   */
  async recalculatePlayerPoints(gameId, playerId) {
    const redis = await this.getRedis();
    try {
      // Get current points and calculate current max
      const current = await this.getPlayerPoints(gameId, playerId);
      const currentMaxPoints = await this.calculateMaxPoints(gameId, playerId);
      const tileCount = await this.getHexCountForPlayer(gameId, playerId);
      
      // Clamp current points to new max if needed
      const currentPoints = parseInt(current.points);
      const clampedPoints = Math.max(0, Math.min(currentPoints, currentMaxPoints));
      
      // Preserve start coordinates
      const startQ = current.startQ || null;
      const startR = current.startR || null;
      
      // Update with new values
      await this.setPlayerPoints(gameId, playerId, clampedPoints, currentMaxPoints, startQ, startR);
      
      return {
        points: clampedPoints,
        maxPoints: currentMaxPoints,
        tiles: tileCount
      };
    } catch (error) {
      console.warn("Error recalculating player points:", error.message);
      return { points: 0, maxPoints: 0, tiles: 0 };
    } finally {
      this.returnRedis(redis);
    }
  }

  async getPlayerUpgradeCounts(gameId) {
    const hexes = await this.getAllHexes(gameId);
    const counts = {};
    
    hexes.forEach(hex => {
      if (hex.playerId && hex.upgrade) {
        if (!counts[hex.playerId]) {
          counts[hex.playerId] = { banks: 0, forts: 0, cities: 0 };
        }
        counts[hex.playerId][hex.upgrade + 's']++;
      }
    });
    
    return counts;
  }

  async recalcMaxPoints(gameId, playerId) {
    const hexes = await this.getAllHexes(gameId);
    const bankCount = hexes.filter(h => h.playerId === playerId && h.upgrade === 'bank').length;
    const tileCount = hexes.filter(h => h.playerId === playerId).length;
    
    // Base max points from starting value, plus banks (50 each), plus tiles (5 each)
    const maxPoints = config.game.startingMaxPoints + (bankCount * 50) + (tileCount * 5);
    
    const current = await this.getPlayerPoints(gameId, playerId);
    const currentPoints = parseInt(current.points);
    const clampedPoints = Math.max(0, Math.min(currentPoints, maxPoints));
    
    // Preserve start coordinates when recalculating
    const startQ = current.startQ || null;
    const startR = current.startR || null;
    
    await this.setPlayerPoints(gameId, playerId, clampedPoints, maxPoints, startQ, startR);
    
    return {
      points: clampedPoints,
      maxPoints: maxPoints
    };
  }

  // Game History/Replay
  async saveGameEvent(gameId, playerId, color, q, r, eventType = 'capture') {
    const redis = await this.getRedis();
    try {
      const event = {
        gameId,
        playerId,
        color,
        q: q.toString(),
        r: r.toString(),
        eventType,
        timestamp: Date.now()
      };

      await redis.lpush(`games:${gameId}:events`, JSON.stringify(event));
      await redis.ltrim(`games:${gameId}:events`, 0, 9999); // Keep last 10k events
    } finally {
      this.returnRedis(redis);
    }
  }

  async getGameEvents(gameId) {
    const redis = await this.getRedis();
    try {
      const events = await redis.lrange(`games:${gameId}:events`, 0, -1);
      return events.map(event => JSON.parse(event));
    } finally {
      this.returnRedis(redis);
    }
  }

  // Mountain Generation
  async generateMountains(gameId) {
    const { mountainChains, mountainChainLength, mountainDensity } = config.game;
    
    for (let chain = 0; chain < mountainChains; chain++) {
      // Generate a random starting point
      const startQ = Math.floor(Math.random() * 20) - 10;
      const startR = Math.floor(Math.random() * 20) - 10;
      
      let currentQ = startQ;
      let currentR = startR;
      
      for (let i = 0; i < mountainChainLength; i++) {
        // Set mountain hex
        await this.setHex(gameId, currentQ, currentR, null, '#8B4513', null, 'mountain');
        
        // Randomly branch
        if (Math.random() < mountainDensity) {
          const branchQ = currentQ + (Math.random() > 0.5 ? 1 : -1);
          const branchR = currentR + (Math.random() > 0.5 ? 1 : -1);
          await this.setHex(gameId, branchQ, branchR, null, '#8B4513', null, 'mountain');
        }
        
        // Move along chain
        const dir = this.HEX_DIRS[Math.floor(Math.random() * this.HEX_DIRS.length)];
        currentQ += dir.q;
        currentR += dir.r;
      }
    }
  }

  async getHexTerrain(gameId, q, r) {
    const hex = await this.getHex(gameId, q, r);
    return hex?.terrain || null;
  }

  async isHexPassable(gameId, q, r) {
    const hex = await this.getHex(gameId, q, r);
    return !hex || hex.terrain !== 'mountain';
  }

  // Auto-expansion helpers
  async getNeighborOwners(gameId, q, r) {
    const neighbors = {};
    
    for (const dir of this.HEX_DIRS) {
      const nq = q + dir.q;
      const nr = r + dir.r;
      const hex = await this.getHex(gameId, nq, nr);
      if (hex && hex.playerId) {
        neighbors[hex.playerId] = (neighbors[hex.playerId] || 0) + 1;
      }
    }
    
    return neighbors;
  }

  async getLastGames(playerId, limit = 10) {
    // This is a simplified implementation - in production you'd want a proper index
    const redis = await this.getRedis();
    try {
      const gameIds = await redis.zrange('games:active', 0, -1);
      const games = [];
      
      for (const gameId of gameIds.slice(-limit)) {
        const game = await this.getGame(gameId);
        if (game) {
          const events = await this.getGameEvents(gameId);
          const playerEvents = events.filter(e => e.playerId === playerId);
          if (playerEvents.length > 0) {
            games.push({
              gameId,
              createdAt: game.createdAt,
              eventCount: events.length,
              playerEvents: playerEvents.length
            });
          }
        }
      }
      
      return games.reverse();
    } finally {
      this.returnRedis(redis);
    }
  }

  // Cleanup
  async closeGame(gameId) {
    const redis = await this.getRedis();
    try {
      await redis.zrem('games:active', gameId);
      await redis.hset(`games:${gameId}:data`, 'status', 'closed', 'closedAt', Date.now());
    } catch (error) {
      console.warn("Error closing game:", error.message);
    } finally {
      this.returnRedis(redis);
    }
  }

  async disconnect() {
    try {
      // The RedisManager handles its own connection pool
      // No need to disconnect individual connections
    } catch (error) {
      console.warn("Error disconnecting Redis:", error.message);
    }
  }
}

module.exports = GameData;


