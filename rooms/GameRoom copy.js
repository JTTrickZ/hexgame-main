// rooms/GameRoom.js
const colyseus = require("colyseus");

class GameRoom extends colyseus.Room {
  onCreate(options) {
    this.db = options.db;
    this.verifyPlayer = options.verifyPlayer;

    this.allowedPlayerIds = new Set(options.allowedPlayerIds || []);
    this.gameId = this.roomId;
    this.players = {}; // sessionId -> { playerId, username, color, started }

    this.setState({ cells: [] });
    this.db.createGame(this.gameId);
    try { this.db.createGameTable(this.gameId); } catch (e) {}
    this.playerTickInterval = null;

    this.lobbyStartTime = null;

    this.onMessage("fillHex", (client, data) => this.handleFillHex(client, data));
    this.onMessage("chooseStart", (client, data) => this.handleChooseStart(client, data));

    console.log(`🎮 GameRoom created: ${this.gameId}`);
  }

  async onJoin(client, options) {
    const { playerId, token } = options || {};
    if (!this.verifyPlayer(playerId, token) || !this.db.playerExists(playerId)) {
      client.leave(1000, "invalid or missing player");
      return;
    }

    if (this.allowedPlayerIds.size > 0 && !this.allowedPlayerIds.has(playerId)) {
      client.leave(1003, "not allowed in this lobby");
      return;
    }

    if (Object.values(this.players).some(p => p.playerId === playerId)) {
      client.leave(1004, "player already present");
      return;
    }

    const rec = this.db.getPlayer(playerId);
    const username = rec?.username || "Player";
    const color = rec?.color || "#5865f2";
    this.players[client.sessionId] = { playerId, username, color, started: false };

    this.db.updateSession(playerId, client.sessionId);
    this.db.addPlayerToLobby(this.gameId, playerId);

    // Init player row but with no starting coords yet
    this.db.initPlayerInGame(this.gameId, playerId, null, null);

    // First joiner defines lobby start timestamp
    if (!this.lobbyStartTime) {
      this.lobbyStartTime = Date.now();
    }

    // Broadcast lobby roster + start time
    client.send("assignedColor", { color });
    client.send("history", this.db.getClicksForGame(this.gameId).map(c => ({ q: c.x, r: c.y, color: c.color })));
    client.send("lobbyStartTime", { ts: this.lobbyStartTime });
    this.broadcast("lobbyRoster", Object.values(this.players));

    // Start ticking points after countdown
    if (!this.playerTickInterval) {
      setTimeout(() => this.startPointTick(), 5000);
    }

    console.log(`👤 Player ${playerId} joined GameRoom ${this.gameId} color=${color}`);
  }

  onLeave(client) {
    const info = this.players[client.sessionId];
    if (info) {
      this.db.removePlayerFromLobby(this.gameId, info.playerId);
      delete this.players[client.sessionId];
    }

    if (Object.keys(this.players).length === 0) {
      clearInterval(this.playerTickInterval);
      this.db.closeGame(this.gameId);
      console.log(`🏁 GameRoom ${this.gameId} closed`);
    } else {
      this.broadcast("lobbyRoster", Object.values(this.players));
    }
  }

  handleChooseStart(client, data) {
    const player = this.players[client.sessionId];
    if (!player || player.started) return;

    const now = Date.now();
    if (now > this.lobbyStartTime + 5000) {
      // too late, fallback to fillHex
      return;
    }

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    // Record starting hex
    this.db.initPlayerInGame(this.gameId, player.playerId, q, r);
    const startHex = { playerId: player.playerId, color: player.color, q, r, ts: now };
    this.state.cells.push(startHex);
    this.db.saveClickToGame(this.gameId, player.playerId, player.color, q, r);

    this.broadcast("update", { q, r, color: player.color });
    player.started = true;
  }

  handleFillHex(client, data) {
    const player = this.players[client.sessionId];
    if (!player) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    // Before start chosen, block fillHex
    if (!player.started) return;

    const currentPoints = this.db.getPlayerPoints(this.gameId, player.playerId).points;
    const occupiedHex = this.state.cells.find(c => c.q === q && c.r === r);

    let cost = 1;
    if (occupiedHex && occupiedHex.playerId !== player.playerId) {
      cost = Math.ceil(currentPoints / (this.state.cells.length || 1));
    }
    if (currentPoints < cost) return;

    this.db.updatePlayerPoints(this.gameId, player.playerId, currentPoints - cost);

    const record = { playerId: player.playerId, color: player.color, q, r, ts: Date.now() };
    this.state.cells.push(record);
    this.db.saveClickToGame(this.gameId, player.playerId, player.color, q, r);

    this.broadcast("update", { q, r, color: player.color });
  }

  startPointTick() {
    this.playerTickInterval = setInterval(() => {
      const allPlayers = this.db.getAllPlayersInGame(this.gameId);
      const hexesByPlayer = {};
      this.state.cells.forEach(c => {
        hexesByPlayer[c.playerId] = hexesByPlayer[c.playerId] || [];
        hexesByPlayer[c.playerId].push(c);
      });

      allPlayers.forEach(p => {
        const playerHexes = hexesByPlayer[p.playerId] || [];
        let points = p.points;
        points += playerHexes.length;
        const startHexOccupied = p.startQ != null && playerHexes.some(h => h.q === p.startQ && h.r === p.startR);
        if (!startHexOccupied) points = 0;

        this.db.updatePlayerPoints(this.gameId, p.playerId, points);
        this.broadcast("pointsUpdate", { playerId: p.playerId, points, tiles: playerHexes.length });
      });
    }, 1000);
  }
}

module.exports = { GameRoom };
