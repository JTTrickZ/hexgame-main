// rooms/LobbyRoom.js
const colyseus = require("colyseus");
const { matchMaker } = require("colyseus");

function randomColor() {
  const colors = ["#e74c3c","#3498db","#2ecc71","#f1c40f","#9b59b6","#e67e22","#1abc9c","#c0392b"];
  return colors[Math.floor(Math.random() * colors.length)];
}

class LobbyRoom extends colyseus.Room {
  onCreate(options) {
    this.players = new Map(); // sessionId -> { playerId, username, color, joined }
    this.countdown = 0;
    this.db = options.db;
    this.verifyPlayer = options.verifyPlayer;

    this.onMessage("joinGame", (client) => {
      const p = this.players.get(client.sessionId);
      if (!p) return;
      p.joined = true;
      this.sendLobbyUpdate();
      this.maybeStartCountdown();
      console.log(`🎮 Player ${p.playerId} clicked Join Game`);
    });

    this.onMessage("setColor", (client, color) => {
      const p = this.players.get(client.sessionId);
      if (!p) return;
      p.color = color;
      this.db.updatePlayerColor(p.playerId, color);
      this.sendLobbyUpdate();
    });

    this.onMessage("createReplay", async (client, data) => {
      try {
        const gameId = data?.gameId;
        if (!gameId) {
          client.send("replayError", { error: "gameId required" });
          return;
        }
        const room = await matchMaker.createRoom("replay", { gameId });
        client.send("replayCreated", { roomId: room.roomId });
        console.log("📦 ReplayRoom created for", gameId, "->", room.roomId);
      } catch (e) {
        console.error("Failed to create replay room:", e);
        client.send("replayError", { error: "failed to create replay room" });
      }
    });

    this.clock.setInterval(() => {
      if (this.countdown > 0) {
        this.countdown -= 1;
        this.broadcast("countdown", this.countdown);
        if (this.countdown === 0) this.startGame();
      }
    }, 1000);

    console.log("📦 LobbyRoom created");
  }

  async onJoin(client, options) {
    const { playerId, token } = options || {};

    // validate player
    if (!this.verifyPlayer(playerId, token) || !this.db.playerExists(playerId)) {
      client.leave(1000, "invalid or missing player");
      return;
    }

    // prevent duplicate presence
    for (const v of this.players.values()) {
      if (v.playerId === playerId) {
        client.leave(1000, "duplicate session");
        return;
      }
    }

    const rec = this.db.getPlayer(playerId);
    let color = rec?.color;
    const username = rec?.username || "Player";
    if (!color) {
      color = randomColor();
      this.db.updatePlayerColor(playerId, color);
    }

    this.players.set(client.sessionId, { playerId, username, color, joined: false });

    this.db.updateSession(playerId, client.sessionId);
    this.db.addPlayerToLobby(this.roomId, playerId);

    // send initial lobby info
    this.sendLobbyUpdate();
    client.send("countdown", this.countdown);
    client.send("assignedColor", { color });

    // send last 10 games for this player
    const lastGames = this.db.getLastGames(playerId);
    client.send("lastGames", lastGames);

    console.log(`👤 Player ${playerId} connected (session ${client.sessionId})`);
  }

  onLeave(client) {
    const p = this.players.get(client.sessionId);
    if (!p) return;

    this.db.clearSession(p.playerId);
    this.db.removePlayerFromLobby(this.roomId, p.playerId);
    this.players.delete(client.sessionId);

    console.log(`❌ Player ${p.playerId} disconnected (session ${client.sessionId})`);

    if (this.players.size === 0) {
      this.db.closeGame(this.roomId); // closes the lobby/game record when empty
    }

    this.sendLobbyUpdate();
  }

  sendLobbyUpdate() {
    const stats = this.computeStats();
    const players = [...this.players.values()].map(p => ({
      playerId: p.playerId,
      username: p.username,
      color: p.color,
      joined: !!p.joined
    }));
    this.broadcast("lobbyUpdate", { ...stats, players });
  }

  computeStats() {
    let total = 0, ready = 0;
    for (const v of this.players.values()) {
      total += 1;
      if (v.joined) ready += 1;
    }
    return { total, waiting: total - ready, ready };
  }

  maybeStartCountdown() {
    const MIN_READY = 2;
    const ready = [...this.players.values()].filter(p => p.joined).length;
    if (ready >= MIN_READY && this.countdown === 0) {
      this.countdown = 5;
      this.broadcast("countdown", this.countdown);
    }
  }

  async startGame() {
    const readyPlayers = [];
    for (const [sid, v] of this.players.entries()) {
      if (v.joined) readyPlayers.push({ sessionId: sid, playerId: v.playerId, username: v.username, color: v.color });
    }
    if (!readyPlayers.length) return;

    try {
      const room = await matchMaker.createRoom("game", {
        allowedPlayerIds: readyPlayers.map(p => p.playerId),
      });

      // Save start players/colors in games table
      const startPlayers = readyPlayers.map(p => ({ playerId: p.playerId, username: p.username, color: p.color }));
      this.db.createGame(room.roomId, startPlayers);

      for (const rp of readyPlayers) {
        const client = this.clients.find(c => c.sessionId === rp.sessionId);
        if (client) client.send("startGame", { roomId: room.roomId });
        this.db.removePlayerFromLobby(this.roomId, rp.playerId);
      }

      // clear local players who were moved
      for (const rp of readyPlayers) this.players.delete(rp.sessionId);

      this.sendLobbyUpdate();
      this.countdown = 0;
      this.broadcast("countdown", this.countdown);
      console.log("🚀 Started game:", room.roomId);
    } catch (e) {
      console.error("Failed to create game room:", e);
    }
  }
}

module.exports = { LobbyRoom };
