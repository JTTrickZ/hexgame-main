// redis/GameData.js
const Redis = require("ioredis");
const config = require("../config");

class GameData {
  constructor() {
    this.redis = new Redis(config.redis);
    this.redis.on('error', (error) => {
      console.warn('Redis connection error:', error.message);
    });
    this.redis.on('close', () => {
      console.log('Redis connection closed');
    });
    this.redis.on('end', () => {
      console.log('Redis connection ended');
    });
    this.HEX_DIRS = [
      {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
      {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1},
    ];
  }

  // Helper method to check if Redis is available
  isRedisAvailable() {
    return this.redis && this.redis.status === 'ready';
  }

  // Player Management
  async createPlayer(username) {
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
    await this.redis.hset(`players:${playerId}:data`, player);
    await this.redis.zadd('players:active', Date.now(), playerId);
    
    return playerId;
  }

  async getPlayer(playerId) {
    const player = await this.redis.hgetall(`players:${playerId}:data`);
    return Object.keys(player).length > 0 ? player : null;
  }

  async updatePlayerColor(playerId, color) {
    await this.redis.hset(`players:${playerId}:data`, 'color', color);
  }

  async playerExists(playerId) {
    return await this.redis.exists(`players:${playerId}:data`);
  }

  async updatePlayerSession(playerId, sessionId) {
    await this.redis.set(`players:${playerId}:session`, sessionId, 'EX', 3600); // 1 hour expiry
  }

  async getPlayerSession(playerId) {
    return await this.redis.get(`players:${playerId}:session`);
  }

  // Lobby Management
  async createLobby(lobbyId) {
    const lobby = {
      id: lobbyId,
      createdAt: Date.now(),
      status: 'active',
      lobbyStartTime: Date.now()
    };

    await this.redis.hset(`lobbies:${lobbyId}:data`, lobby);
    await this.redis.zadd('lobbies:active', Date.now(), lobbyId);
  }

  async getLobby(lobbyId) {
    const lobby = await this.redis.hgetall(`lobbies:${lobbyId}:data`);
    return Object.keys(lobby).length > 0 ? lobby : null;
  }

  async addPlayerToLobby(lobbyId, playerId) {
    await this.redis.sadd(`lobbies:${lobbyId}:players`, playerId);
  }

  async removePlayerFromLobby(lobbyId, playerId) {
    await this.redis.srem(`lobbies:${lobbyId}:players`, playerId);
  }

  async getLobbyPlayers(lobbyId) {
    return await this.redis.smembers(`lobbies:${lobbyId}:players`);
  }

  async closeLobby(lobbyId) {
    await this.redis.zrem('lobbies:active', lobbyId);
    await this.redis.hset(`lobbies:${lobbyId}:data`, 'status', 'closed', 'closedAt', Date.now());
  }

  // Game Management
  async createGame(gameId, startPlayers = []) {
    const game = {
      id: gameId,
      createdAt: Date.now(),
      status: 'active',
      startPlayers: JSON.stringify(startPlayers),
      lobbyStartTime: Date.now()
    };

    await this.redis.hset(`games:${gameId}:data`, game);
    await this.redis.zadd('games:active', Date.now(), gameId);
    
    // Add players to game
    for (const player of startPlayers) {
      await this.redis.sadd(`games:${gameId}:players`, player.playerId);
      // Initialize player points
      await this.setPlayerPoints(gameId, player.playerId, config.game.startingPoints, config.game.startingMaxPoints);
    }
  }

  async getGame(gameId) {
    const game = await this.redis.hgetall(`games:${gameId}:data`);
    if (Object.keys(game).length === 0) return null;
    
    game.startPlayers = JSON.parse(game.startPlayers || '[]');
    return game;
  }

  async updateGameStatus(gameId, status) {
    await this.redis.hset(`games:${gameId}:data`, 'status', status);
  }

  async addPlayerToGame(gameId, playerId) {
    await this.redis.sadd(`games:${gameId}:players`, playerId);
  }

  async removePlayerFromGame(gameId, playerId) {
    await this.redis.srem(`games:${gameId}:players`, playerId);
  }

  async getGamePlayers(gameId) {
    return await this.redis.smembers(`games:${gameId}:players`);
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

    await this.redis.hset(`games:${gameId}:hexes`, hexKey, JSON.stringify(hex));
    
    // Update player's hex count
    await this.updatePlayerHexCount(gameId, playerId);
  }

  async getHex(gameId, q, r) {
    const hexData = await this.redis.hget(`games:${gameId}:hexes`, `${q}:${r}`);
    return hexData ? JSON.parse(hexData) : null;
  }

  async getAllHexes(gameId) {
    const hexes = await this.redis.hgetall(`games:${gameId}:hexes`);
    return Object.values(hexes).map(hex => JSON.parse(hex));
  }

  async getHexOwner(gameId, q, r) {
    return await this.getHex(gameId, q, r);
  }

  async setHexUpgrade(gameId, q, r, upgrade) {
    const hex = await this.getHex(gameId, q, r);
    if (hex) {
      hex.upgrade = upgrade;
      hex.upgradeTime = Date.now();
      await this.redis.hset(`games:${gameId}:hexes`, `${q}:${r}`, JSON.stringify(hex));
    }
  }

  // Player Points Management
  async setPlayerPoints(gameId, playerId, points, maxPoints, startQ = null, startR = null) {
    const pointsData = {
      playerId,
      points: points.toString(),
      maxPoints: maxPoints.toString(),
      lastUpdate: Date.now()
    };
    
    if (startQ !== null) pointsData.startQ = startQ.toString();
    if (startR !== null) pointsData.startR = startR.toString();
    
    await this.redis.hset(`games:${gameId}:points`, playerId, JSON.stringify(pointsData));
  }

  async getPlayerPoints(gameId, playerId) {
    if (!this.isRedisAvailable()) {
      console.warn("Redis not available for getPlayerPoints");
      return { playerId, points: "0", maxPoints: "0" };
    }
    
    try {
      const pointsData = await this.redis.hget(`games:${gameId}:points`, playerId);
      if (!pointsData) {
        // Initialize with default values
        const defaultPoints = config.game.startingPoints;
        const defaultMaxPoints = config.game.startingMaxPoints;
        await this.setPlayerPoints(gameId, playerId, defaultPoints, defaultMaxPoints);
        return { playerId, points: defaultPoints.toString(), maxPoints: defaultMaxPoints.toString() };
      }
      return JSON.parse(pointsData);
    } catch (error) {
      console.warn("Error getting player points:", error.message);
      return { playerId, points: "0", maxPoints: "0" };
    }
  }

  async updatePlayerPoints(gameId, playerId, newPoints) {
    if (!this.isRedisAvailable()) {
      console.warn("Redis not available for updatePlayerPoints");
      return 0;
    }
    
    try {
      const current = await this.getPlayerPoints(gameId, playerId);
      const maxPoints = parseInt(current.maxPoints);
      const clampedPoints = Math.max(0, Math.min(newPoints, maxPoints));
      
      // Preserve start coordinates when updating points
      const startQ = current.startQ || null;
      const startR = current.startR || null;
      
      await this.setPlayerPoints(gameId, playerId, clampedPoints, maxPoints, startQ, startR);
      return clampedPoints;
    } catch (error) {
      console.warn("Error updating player points:", error.message);
      return 0;
    }
  }

  async getHexCountForPlayer(gameId, playerId) {
    if (!this.isRedisAvailable()) {
      console.warn("Redis not available for getHexCountForPlayer");
      return 0;
    }
    
    try {
      const hexes = await this.getAllHexes(gameId);
      return hexes.filter(h => h.playerId === playerId).length;
    } catch (error) {
      console.warn("Error getting hex count for player:", error.message);
      return 0;
    }
  }

  async updatePlayerHexCount(gameId, playerId) {
    if (!this.isRedisAvailable()) {
      console.warn("Redis not available for updatePlayerHexCount");
      return 0;
    }
    
    try {
      const count = await this.getHexCountForPlayer(gameId, playerId);
      const points = await this.getPlayerPoints(gameId, playerId);
      points.tiles = count.toString();
      
      // Preserve start coordinates when updating hex count
      const startQ = points.startQ || null;
      const startR = points.startR || null;
      
      await this.redis.hset(`games:${gameId}:points`, playerId, JSON.stringify(points));
      return count;
    } catch (error) {
      console.warn("Error updating player hex count:", error.message);
      return 0;
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
    const event = {
      gameId,
      playerId,
      color,
      q: q.toString(),
      r: r.toString(),
      eventType,
      timestamp: Date.now()
    };

    await this.redis.lpush(`games:${gameId}:events`, JSON.stringify(event));
    await this.redis.ltrim(`games:${gameId}:events`, 0, 9999); // Keep last 10k events
  }

  async getGameEvents(gameId) {
    const events = await this.redis.lrange(`games:${gameId}:events`, 0, -1);
    return events.map(event => JSON.parse(event));
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
    const gameIds = await this.redis.zrange('games:active', 0, -1);
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
  }

  // Cleanup
  async closeGame(gameId) {
    if (!this.isRedisAvailable()) return;
    try {
      await this.redis.zrem('games:active', gameId);
      await this.redis.hset(`games:${gameId}:data`, 'status', 'closed', 'closedAt', Date.now());
    } catch (error) {
      console.warn("Error closing game:", error.message);
    }
  }

  async disconnect() {
    try {
      if (this.redis && this.redis.status !== 'end' && this.redis.status !== 'close') {
        // Remove all event listeners to prevent errors
        this.redis.removeAllListeners();
        // Use disconnect instead of quit for more graceful shutdown
        this.redis.disconnect();
      }
    } catch (error) {
      console.warn("Error disconnecting Redis:", error.message);
    }
  }
}

module.exports = GameData;
