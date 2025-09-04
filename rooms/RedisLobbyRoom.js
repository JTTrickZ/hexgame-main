// rooms/RedisLobbyRoom.js
const { Room } = require("colyseus");
const { matchMaker } = require("colyseus");
const { GameState, Player } = require("../schemas/GameState");
const GameData = require("../redis/GameData");
const config = require("../config");

class RedisLobbyRoom extends Room {
  onCreate(options) {
    this.gameData = new GameData();
    this.verifyPlayer = options.verifyPlayer;
    
    // Initialize state
    this.setState(new GameState());
    this.state.gameId = this.roomId;
    this.state.lobbyStartTime = Date.now();
    this.state.countdown = 0;
    this.state.gameStarted = false;

    // Create game record in Redis
    this.gameData.createLobby(this.roomId);

    this.onMessage("joinGame", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      
      player.started = true;
      this.state.lastUpdateTime = Date.now();
      this.maybeStartCountdown();
      this.broadcastLobbyUpdate();
      console.log(`🎮 Player ${player.id} clicked Join Game`);
    });

    this.onMessage("setColor", async (client, color) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      
      player.color = color;
      await this.gameData.updatePlayerColor(player.id, color);
      this.state.lastUpdateTime = Date.now();
    });

    this.onMessage("createReplay", async (client, data) => {
      try {
        const gameId = data?.gameId;
        if (!gameId) {
          client.send("replayError", { error: "gameId required" });
          return;
        }
        const room = await matchMaker.createRoom("redisReplay", { gameId });
        client.send("replayCreated", { roomId: room.roomId });
        console.log("📦 RedisReplayRoom created for", gameId, "->", room.roomId);
      } catch (e) {
        console.error("Failed to create replay room:", e);
        client.send("replayError", { error: "failed to create replay room" });
      }
    });

    // Countdown timer
    this.clock.setInterval(() => {
      if (this.state.countdown > 0) {
        this.state.countdown -= 1;
        this.state.lastUpdateTime = Date.now();
        this.broadcastLobbyUpdate();
        if (this.state.countdown === 0) this.startGame();
      }
    }, 1000);

    console.log("📦 RedisLobbyRoom created");
  }

  async onJoin(client, options) {
    const { playerId, token } = options || {};

    // validate player
    if (!this.verifyPlayer(playerId, token) || !(await this.gameData.playerExists(playerId))) {
      client.leave(1000, "invalid or missing player");
      return;
    }

    // prevent duplicate presence
    for (const [sessionId, player] of this.state.players.entries()) {
      if (player.id === playerId && !player.disconnected) {
        client.leave(1000, "duplicate session");
        return;
      }
    }

    // Cancel cleanup timeout if someone is rejoining
    if (this.cleanupTimeout) {
      console.log(`⏸ RedisLobbyRoom ${this.roomId} cleanup cancelled - player ${playerId} rejoined`);
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }

    const playerData = await this.gameData.getPlayer(playerId);
    if (!playerData) {
      client.leave(1000, "player not found");
      return;
    }

    // Check if player is already in state (reconnection)
    let existingPlayer = null;
    for (const [sessionId, p] of this.state.players.entries()) {
      if (p.id === playerId) {
        existingPlayer = p;
        // Remove the old session entry
        this.state.players.delete(sessionId);
        break;
      }
    }

    // Create or update player in state
    const player = existingPlayer || new Player();
    player.id = playerId;
    player.username = playerData.username;
    player.color = playerData.color;
    player.points = config.game.startingPoints;
    player.maxPoints = config.game.startingMaxPoints;
    player.tiles = 0;
    player.started = false;
    player.lastSeen = Date.now();
    player.disconnected = false; // Mark as connected

    this.state.players.set(client.sessionId, player);
    this.state.lastUpdateTime = Date.now();

    // Update session
    await this.gameData.updatePlayerSession(playerId, client.sessionId);
    
    // Add player to lobby only if they're not already in it (for reconnections)
    if (!existingPlayer) {
      await this.gameData.addPlayerToLobby(this.roomId, playerId);
    }

    // Send initial data
    client.send("assignedColor", { color: player.color });
    client.send("countdown", this.state.countdown);

    // Send last 10 games for this player (placeholder for now)
    client.send("lastGames", []);

    // Broadcast lobby update to all clients
    this.broadcastLobbyUpdate();

    console.log(`👤 Player ${playerId} connected (session ${client.sessionId})`);
  }

  async onLeave(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Mark player as disconnected but keep them in state for reconnection
    player.disconnected = true;
    player.lastSeen = Date.now();

    console.log(`❌ Player ${player.id} disconnected (session ${client.sessionId})`);

    // Count only connected players
    const connectedPlayers = Array.from(this.state.players.values()).filter(p => !p.disconnected);

    // Broadcast lobby update to remaining clients
    this.broadcastLobbyUpdate();

    if (connectedPlayers.length === 0) {
      console.log(`⏳ RedisLobbyRoom ${this.roomId} is empty, starting 60-second cleanup buffer...`);

      // Clear existing cleanup timeout if it exists
      if (this.cleanupTimeout) {
        clearTimeout(this.cleanupTimeout);
      }

      // Set 60-second timeout before cleanup
      this.cleanupTimeout = setTimeout(async () => {
        // Count connected players again after timeout
        const stillConnectedPlayers = Array.from(this.state.players.values()).filter(p => !p.disconnected);
        
        if (stillConnectedPlayers.length === 0) { // Double-check room is still empty
          console.log(`📦 RedisLobbyRoom ${this.roomId} closed after 60s buffer - manually disposing room`);
          
          // Remove all players from lobby before closing
          for (const [sessionId, player] of this.state.players.entries()) {
            await this.gameData.removePlayerFromLobby(this.roomId, player.id);
          }
          
          await this.gameData.closeLobby(this.roomId);
          
          // Manually dispose the room after cleanup
          this.disconnect();
        } else {
          console.log(`⏸ RedisLobbyRoom ${this.roomId} cleanup cancelled - player(s) rejoined`);
        }
        this.cleanupTimeout = null;
      }, 60000); // 60 seconds
    }
  }

  maybeStartCountdown() {
    const MIN_READY = 2;
    let ready = 0;
    
    for (const [sessionId, player] of this.state.players.entries()) {
      if (player.disconnected) continue; // Skip disconnected players
      if (player.started) ready++;
    }
    
    if (ready >= MIN_READY && this.state.countdown === 0) {
      this.state.countdown = 5;
      this.state.lastUpdateTime = Date.now();
      this.broadcastLobbyUpdate();
    }
  }

  broadcastLobbyUpdate() {
    const total = this.state.players.size;
    let waiting = 0;
    let ready = 0;
    
    for (const [sessionId, player] of this.state.players.entries()) {
      if (player.disconnected) continue; // Skip disconnected players
      
      if (player.started) {
        ready++;
      } else {
        waiting++;
      }
    }
    
    const players = Array.from(this.state.players.values())
      .filter(p => !p.disconnected) // Only include connected players
      .map(p => ({
        id: p.id,
        username: p.username,
        color: p.color,
        started: p.started
      }));
    
    this.broadcast("lobbyUpdate", { total, waiting, ready, players });
  }

  async startGame() {
    const readyPlayers = [];
    for (const [sessionId, player] of this.state.players.entries()) {
      if (player.disconnected) continue; // Skip disconnected players
      if (player.started) {
        readyPlayers.push({
          sessionId,
          playerId: player.id,
          username: player.username,
          color: player.color
        });
      }
    }
    
    if (!readyPlayers.length) return;

    try {
      const room = await matchMaker.createRoom("redisGame", {
        allowedPlayerIds: readyPlayers.map(p => p.playerId),
      });

      // Update game status
      await this.gameData.updateGameStatus(room.roomId, 'active');

      for (const rp of readyPlayers) {
        const client = this.clients.find(c => c.sessionId === rp.sessionId);
        if (client) client.send("startGame", { roomId: room.roomId });
      }

      // Remove ready players from lobby
      for (const rp of readyPlayers) {
        this.state.players.delete(rp.sessionId);
        await this.gameData.removePlayerFromLobby(this.roomId, rp.playerId);
      }

      this.state.lastUpdateTime = Date.now();
      this.state.countdown = 0;
      console.log("🚀 Started game:", room.roomId);
    } catch (e) {
      console.error("Failed to create game room:", e);
    }
  }

  onDispose() {
    // Clear cleanup timeout if it exists
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }

    try {
      if (this.gameData) {
        // Use setTimeout to defer the disconnect and avoid blocking
        setTimeout(() => {
          this.gameData.disconnect().catch(err => {
            console.warn("Redis disconnect error (ignored):", err.message);
          });
        }, 0);
      }
    } catch (error) {
      console.warn("Error disposing RedisLobbyRoom:", error.message);
    }
    console.log("📦 RedisLobbyRoom disposed");
  }
}

module.exports = { RedisLobbyRoom };
