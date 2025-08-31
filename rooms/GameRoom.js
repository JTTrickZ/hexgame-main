// rooms/GameRoom.js
const colyseus = require("colyseus");

//Constant Variables - Do Not REMOVE -------------------------------------
const startdelay = 5000; // ms

//
const HEX_VALUE = 10;
const HEX_MAINTCOST = 8;

// Expansion          // baseline cost for first few tiles
const EXP_GROWTH = 5;          // how fast expansion escalates (logarithmic)

// Attacking
const OCCUPIED_BASE = 5;      // minimum extra cost when attacking another player
const ATTACK_MULT = 2.5;       // scales based on defender strength
          

// Economy
const BASE_INCOME = 2;        // per turn or per tick income

// Upgrades
const UPGRADE_BANK_COST = 100;
const UPGRADE_FORT_COST = 300;
const UPGRADE_CITY_COST = 200;
// ------------------------------------------------------------

class GameRoom extends colyseus.Room {
  onCreate(options) {
    this.db = options.db;
    this.verifyPlayer = options.verifyPlayer;

    this.allowedPlayerIds = new Set(options.allowedPlayerIds || []);
    this.gameId = this.roomId;

    // ensure per-game DB tables exist so subsequent calls won't fail
    try { this.db.createGameTable(this.gameId); } catch (e) {}
    try { this.db.createHexTable(this.gameId); } catch (e) {}
    try { this.db.createPlayersTable(this.gameId); } catch (e) {}

    this.players = {}; // playerId -> { sessionId, username, color, started }

    this.setState({ cells: [] });
    this.db.createGame(this.gameId);

    this.playerTickInterval = null;
    this.lobbyStartTime = null;

    this.onMessage("fillHex", (client, data) => this.handleFillHex(client, data));
    this.onMessage("chooseStart", (client, data) => this.handleChooseStart(client, data));
    this.onMessage("requestHoverCost", (client, data) => this.handleRequestHoverCost(client, data));
    this.onMessage("upgradeHex", (client, data) => this.handleUpgradeHex(client, data));

    console.log(`🎮 GameRoom created: ${this.gameId}`);
  }

  computeCost(gameId, attackerPlayerId, q, r) {
    const occupied = this.db.getHexOwner(gameId, q, r);
    const upgradeCounts = this.db.getPlayerUpgradeCounts(gameId);

    if (occupied && occupied.playerId === attackerPlayerId) {
      return null; // cannot attack own hex
    }

    const attackerHexCount = this.db.getHexCountForPlayer(gameId, attackerPlayerId) || 0;
    const expansionCost = HEX_VALUE + Math.floor(EXP_GROWTH * Math.log2(attackerHexCount + 2));
    let cost = expansionCost;

    if (occupied && occupied.playerId && occupied.playerId !== attackerPlayerId) {
      const defPlayerId = occupied.playerId;
      const defenderHexCount = Math.max(1, this.db.getHexCountForPlayer(gameId, defPlayerId));
      const defenderPoints = (this.db.getPlayerPoints(gameId, defPlayerId)?.points) || 0;
      const defenderForts = upgradeCounts[defPlayerId]?.forts || 0;
      const attackerForts = upgradeCounts[attackerPlayerId]?.forts || 0;
      const defenderBanks = upgradeCounts[defPlayerId]?.banks || 0;

      // Basic defender strength
      let defenderStrength = (1 + (defenderPoints / defenderHexCount)) * (defenderHexCount * (HEX_VALUE + (0.5 * (defenderBanks + 1)))); 

      // Multiply by defender's forts count (1+ to avoid zero)
      defenderStrength *= ( 0.5 * (1 + defenderForts));

      // Attack cost scales with strength
      let attackCost = expansionCost + OCCUPIED_BASE + Math.floor(ATTACK_MULT * Math.sqrt(defenderStrength));

      // If the targeted hex has a fort, multiply by 5
      if (occupied.upgrade === "fort") {
        attackCost *= 2;
      }

      // Always pick the higher cost
      cost = Math.max(cost, attackCost);
    }

    return cost;
  }


  handleRequestHoverCost(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);
    try { this.db.createPlayersTable(this.gameId); } catch (e) {}
    const cost = this.computeCost(this.gameId, playerId, q, r);
    client.send("hoverCost", { q, r, cost });
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

    // Look up player info from DB
    const rec = this.db.getPlayer(playerId);
    const username = rec?.username || "Player";
    const color = rec?.color || "#5865f2";

    try { this.db.createPlayersTable(this.gameId); } catch (e) {}

    const playerRow = this.db.getPlayerPoints(this.gameId, playerId);
    const alreadyStarted = playerRow && (playerRow.startQ != null || playerRow.startR != null);

    if (this.players[playerId]) {
      this.players[playerId].sessionId = client.sessionId;
      this.players[playerId].started = this.players[playerId].started || alreadyStarted;
      console.log(`🔄 Player ${playerId} reconnected with new sessionId`);
    } else {
      this.players[playerId] = {
        sessionId: client.sessionId,
        username,
        color,
        started: !!alreadyStarted
      };
      this.db.addPlayerToLobby(this.gameId, playerId);
    }

    this.db.updateSession(playerId, client.sessionId);

    if (!this.lobbyStartTime) {
      this.lobbyStartTime = Date.now();
    }

    const hexes = this.db.getAllHexes(this.gameId) || [];
    const playersInGame = this.db.getAllPlayersInGame(this.gameId) || [];
    const startCoords = new Set();
    playersInGame.forEach(p => {
      if (p.startQ != null && p.startR != null) {
        startCoords.add(`${p.startQ},${p.startR}`);
      }
    });

    const historyWithCrowns = hexes.map(h => {
      const key = `${h.q},${h.r}`;
      return {
        q: h.q,
        r: h.r,
        color: h.color,
        crown: startCoords.has(key),
        upgrade: h.upgrade || null
      };
    });

    client.send("assignedColor", { color });
    client.send("history", historyWithCrowns);
    client.send("lobbyStartTime", { ts: this.lobbyStartTime });

    // Send this player's current points + maxPoints immediately
    try {
      const pr = this.db.getPlayerPoints(this.gameId, playerId);
      console.log(`DEBUG: ${playerId} pointsUpdate:`, pr);
      client.send("pointsUpdate", {
        playerId,
        points: pr.points,
        tiles: this.db.getHexCountForPlayer(this.gameId, playerId),
        maxPoints: pr.maxPoints
      });
    } catch (e) {
      // ignore
    }

    const rosterArray = Object.entries(this.players).map(([pid, p]) => ({
      playerId: pid,
      username: p.username,
      color: p.color,
      started: p.started
    }));
    this.broadcast("lobbyRoster", rosterArray);

    if (!this.playerTickInterval) {
      setTimeout(() => this.startPointTick(), startdelay + 100);
    }

    console.log(`👤 Player ${playerId} joined GameRoom ${this.gameId} color=${color}`);
  }

  onLeave(client) {
    const playerId = Object.keys(this.players).find(
      pid => this.players[pid].sessionId === client.sessionId
    );
    if (playerId) {
      console.log(`⏸ Player ${playerId} left (session ${client.sessionId}) but kept in lobby for reconnect`);
    }

    if (Object.keys(this.players).length === 0) {
      clearInterval(this.playerTickInterval);
      this.db.closeGame(this.gameId);
      console.log(`🏁 GameRoom ${this.gameId} closed`);
    } else {
      this.broadcast("lobbyRoster", Object.entries(this.players).map(([pid, p]) => ({
        playerId: pid,
        username: p.username,
        color: p.color,
        started: p.started
      })));
    }
  }

  handleChooseStart(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    const player = this.players[playerId];
    if (!player || player.started) return;

    const nowTs = Date.now();
    if (nowTs > this.lobbyStartTime + startdelay) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    this.db.initPlayerInGame(this.gameId, playerId, q, r);
    this.db.setHex(this.gameId, q, r, playerId, player.color);
    this.db.saveClickToGame(this.gameId, playerId, player.color, q, r);

    this.broadcast("update", { q, r, color: player.color, crown: true });
    player.started = true;

    // send pointsUpdate including maxPoints
    const pp = this.db.getPlayerPoints(this.gameId, playerId);
    this.broadcast("pointsUpdate", {
      playerId,
      points: pp.points,
      tiles: this.db.getHexCountForPlayer(this.gameId, playerId),
      maxPoints: pp.maxPoints
    });
  }

  handleFillHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    const player = this.players[playerId];
    if (!player || !player.started) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    try { this.db.createPlayersTable(this.gameId); } catch (e) {}

    const occupied = this.db.getHexOwner(this.gameId, q, r);

    // If already owned by this player, open owner menu (client shows modal)
    if (occupied && occupied.playerId === playerId) {
      client.send("openOwnedTileMenu", { q, r, upgrade: occupied.upgrade || null });
      return;
    }

    const currentPoints = this.db.getPlayerPoints(this.gameId, playerId).points;
    const cost = this.computeCost(this.gameId, playerId, q, r);

    if (cost === null || currentPoints < cost) {
      client.send("fillResult", { q, r, ok: false, reason: "insufficient" });
      return;
    }

    // Deduct points (this will clamp to current maxPoints)
    this.db.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);

    // Remember previous owner for max recalculation after capture
    const prevOwnerId = occupied && occupied.playerId ? occupied.playerId : null;

    // Transfer ownership (preserve existing upgrade column)
    this.db.setHex(this.gameId, q, r, playerId, player.color);
    this.db.saveClickToGame(this.gameId, playerId, player.color, q, r);
    
    console.log(`Player ${playerId} spent ${cost}, attempted capture at ${q},${r}`);

    // Server authoritative hex state after change
    const hex = this.db.getHexOwner(this.gameId, q, r);

    // Broadcast tile change
    this.broadcast("update", { q, r, color: player.color, upgrade: hex.upgrade || null });

    // Recalculate maxPoints for previous owner (they may have lost a bank)
    if (prevOwnerId && prevOwnerId !== playerId) {
      try {
        const defenderRec = this.db.recalcMaxPoints(this.gameId, prevOwnerId);
        const defenderTiles = this.db.getHexCountForPlayer(this.gameId, prevOwnerId);
        this.broadcast("pointsUpdate", {
          playerId: prevOwnerId,
          points: defenderRec.points,
          tiles: defenderTiles,
          maxPoints: defenderRec.maxPoints
        });
      } catch (e) {
        // ignore
      }
    }

    // Recalculate maxPoints for attacker (they may have gained a bank from the captured tile)
    try {
      const attackerRec = this.db.recalcMaxPoints(this.gameId, playerId);
      const tiles = this.db.getHexCountForPlayer(this.gameId, playerId);
      this.broadcast("pointsUpdate", {
        playerId,
        points: attackerRec.points,
        tiles,
        maxPoints: attackerRec.maxPoints
      });
    } catch (e) {
      // fallback: broadcast current points
      const pp = this.db.getPlayerPoints(this.gameId, playerId);
      this.broadcast("pointsUpdate", {
        playerId,
        points: pp.points,
        tiles: this.db.getHexCountForPlayer(this.gameId, playerId),
        maxPoints: pp.maxPoints
      });
    }

    // Notify success to caller (optional). We only send failures earlier.
  }

  // NEW: handle upgrade requests from client
  handleUpgradeHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return client.send("upgradeResult", { ok: false, error: "no player" });

    const type = typeof data?.type === "string" ? data.type : null; // 'bank' or 'fort' or city
    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    if (!type || (type !== "bank" && type !== "fort" && type !== "city")) {
      return client.send("upgradeResult", { ok: false, error: "invalid upgrade" });
    }

    // confirm owner
    const hex = this.db.getHexOwner(this.gameId, q, r);
    if (!hex || hex.playerId !== playerId) {
      return client.send("upgradeResult", { ok: false, error: "not owner" });
    }

   // cost check
    const row = this.db.getPlayerPoints(this.gameId, playerId);
    const currentPoints = row?.points ?? 0;
    let cost = 0;
    if (type === "bank") cost = UPGRADE_BANK_COST;
    else if (type === "fort") cost = UPGRADE_FORT_COST;
    else if (type === "city") cost = UPGRADE_CITY_COST;

    if (currentPoints < cost) {
      return client.send("upgradeResult", { ok: false, error: "insufficient" });
    }

    // Deduct points and persist upgrade
    const newPoints = currentPoints - cost;
    // update points (this will clamp to current maxPoints before bank effect)
    this.db.updatePlayerPoints(this.gameId, playerId, newPoints);

    // Set the upgrade on the hex (this will record upgrade_ts)
    this.db.setHexUpgrade(this.gameId, q, r, type);

    // optionally log as a click/history event as well
    this.db.saveClickToGame(this.gameId, playerId, hex.color || this.players[playerId].color, q, r);

    // Broadcast hex update (clients will display emoji)
    this.broadcast("update", { q, r, color: hex.color || this.players[playerId].color, upgrade: type });

    // Recalculate maxPoints for this player (buying a bank increases their cap)
    const rec = this.db.recalcMaxPoints(this.gameId, playerId);
    const tiles = this.db.getHexCountForPlayer(this.gameId, playerId);

    // Broadcast points update to everyone (with updated maxPoints)
    this.broadcast("pointsUpdate", { playerId, points: rec.points, tiles, maxPoints: rec.maxPoints });

    client.send("upgradeResult", { ok: true, type, points: rec.points, maxPoints: rec.maxPoints });
    console.log(`Player ${playerId} purchased ${type} for ${cost} (left ${rec.points}) at ${q},${r}`);
  }

  startPointTick() {
    if (this.playerTickInterval) clearInterval(this.playerTickInterval);

    this.playerTickInterval = setInterval(() => {
      const allPlayers = this.db.getAllPlayersInGame(this.gameId);
      const upgradeCounts = this.db.getPlayerUpgradeCounts(this.gameId);

      allPlayers.forEach(p => {
        // fetch latest row (contains points/maxPoints)
        let row = this.db.getPlayerPoints(this.gameId, p.playerId);
        let points = row.points || 0;
        const tiles = this.db.getHexCountForPlayer(this.gameId, p.playerId) || 0;

        // Make sure your DB returns 0 when undefined
        const banks  = upgradeCounts[p.playerId]?.banks  || 0;
        const forts  = upgradeCounts[p.playerId]?.forts  || 0;
        const cities = upgradeCounts[p.playerId]?.cities || 0;

        // 1) Base income
        points += BASE_INCOME;

        // 2) Income from owned hexes (value - maintenance)
        const hexIncome = tiles * (HEX_VALUE - HEX_MAINTCOST);
        points += hexIncome;

        // 3) Extra income from CITIES (moved here from banks)
        //    Keep your old +10 per (now tied to city), or tweak as you like.
        points += cities * 10;

        // Banks DO NOT add income anymore; they only raise max points (via recalcMaxPoints)

        // Ensure points never go negative
        if (points < 0) points = 0;

        // Persist (clamped to current maxPoints)
        this.db.updatePlayerPoints(this.gameId, p.playerId, points);

        const updated = this.db.getPlayerPoints(this.gameId, p.playerId);

        // include cities in broadcast (optional but handy for HUD/debug)
        this.broadcast("pointsUpdate", {
          playerId: p.playerId,
          points: updated.points,
          tiles,
          forts,
          banks,
          cities,
          maxPoints: updated.maxPoints
        });
      });
    }, 2000); // every 2 seconds
  }

  getPlayerIdBySession(sessionId) {
    return Object.keys(this.players).find(pid => this.players[pid].sessionId === sessionId);
  }
}

module.exports = { GameRoom };
