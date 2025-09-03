// rooms/GameRoom.js
const colyseus = require("colyseus");
const HEX_DIRS = [
          {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
          {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1},
        ];

//Constant Variables - Do Not REMOVE -------------------------------------
const startdelay = 5000; // ms
//
const HEX_VALUE = 10;
const HEX_MAINTCOST = 3;

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

// Auto expansion params
const AUTO_CAPTURE_THRESHOLD = 3;    // need >= 4 same-owner neighbors to capture
const AUTO_EXPAND_INTERVAL = 10000;   // ms - how often expansion runs

// Mountain generation params
const MOUNTAIN_CHAINS = 3;           // number of mountain chains to generate
const MOUNTAIN_CHAIN_LENGTH = 8;     // length of each mountain chain
const MOUNTAIN_DENSITY = 0.15;       // density of mountain branching
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

    // Generate mountain chains for this game
    try {
      this.db.generateMountainChains(this.gameId, MOUNTAIN_CHAINS, MOUNTAIN_CHAIN_LENGTH, MOUNTAIN_DENSITY);
    } catch (e) {
      console.warn("Failed to generate mountains:", e);
    }

    this.playerTickInterval = null;
    this.lobbyStartTime = null;

    // Auto expand interval handle
    this.autoExpandInterval = null;

    this.onMessage("fillHex", (client, data) => this.handleFillHex(client, data));
    this.onMessage("chooseStart", (client, data) => this.handleChooseStart(client, data));
    this.onMessage("requestHoverCost", (client, data) => this.handleRequestHoverCost(client, data));
    this.onMessage("upgradeHex", (client, data) => this.handleUpgradeHex(client, data));
    this.onMessage("batchFillHex", (client, data) => this.handleBatchFillHex(client, data));
    this.onMessage("batchUpgradeHex", (client, data) => this.handleBatchUpgradeHex(client, data));
    this.onMessage("requestPointsUpdate", (client, data) => this.handleRequestPointsUpdate(client, data));
    this.onMessage("clickHex", (client, data) => this.handleClickHex(client, data));

    // start auto-expansion loop (runs regardless of players present; safe to run)
    try {
      this.startAutoExpand();
    } catch (e) {
      console.warn("Failed to start auto expand:", e);
    }

    console.log(`🎮 GameRoom created: ${this.gameId}`);
  }

  getNeighborCoords(q, r) {
      return HEX_DIRS.map(d => ({ q: q + d.q, r: r + d.r }));
  }

  // --- Auto-expansion: scans nearby candidate cells and captures them when a single player
  //     controls >= AUTO_CAPTURE_THRESHOLD of the 6 neighbors.
  startAutoExpand() {
    if (this.autoExpandInterval) clearInterval(this.autoExpandInterval);

    this.autoExpandInterval = setInterval(() => {
      try {
        // Load all known hexes (this is the authoritative set)
        const allHexes = this.db.getAllHexes(this.gameId) || [];

        // Build a set of candidate coords to check:
        // For each owned hex, consider its 6 neighbors as potential captures.
        const candidateSet = new Set();
        
        allHexes.forEach(h => {
          HEX_DIRS.forEach(d => {
            const nq = h.q + d.q;
            const nr = h.r + d.r;
            candidateSet.add(`${nq},${nr}`);
          });
        });

        // For performance: also consider hexes that are in DB but may be surrounded (so include allHexes)
        allHexes.forEach(h => candidateSet.add(`${h.q},${h.r}`));

        // evaluate each candidate
        const toCapture = []; // array of { q, r, newOwnerId }
        for (const key of candidateSet) {
          const [qStr, rStr] = key.split(",");
          const q = Number(qStr); const r = Number(rStr);

          // count neighbor ownerships
          const neighborOwners = {};
          const neighbors = HEX_DIRS.map(d => ({ q: q + d.q, r: r + d.r }));
          neighbors.forEach(n => {
            const ox = this.db.getHexOwner(this.gameId, n.q, n.r);
            if (ox && ox.playerId) {
              neighborOwners[ox.playerId] = (neighborOwners[ox.playerId] || 0) + 1;
            }
          });

          // find the player with the maximum neighbor count
          let maxPlayer = null;
          let maxCount = 0;
          let tie = false;
          Object.entries(neighborOwners).forEach(([pid, cnt]) => {
            if (cnt > maxCount) {
              maxCount = cnt;
              maxPlayer = pid;
              tie = false;
            } else if (cnt === maxCount && cnt > 0) {
              tie = true;
            }
          });

          // only capture if a single player strictly has the max and meets threshold and no forts on the land
          // only capture if a single player strictly has the max and meets threshold
          if (maxPlayer && !tie && maxCount >= AUTO_CAPTURE_THRESHOLD) {
            const occupied = this.db.getHexOwner(this.gameId, q, r);
            const currentOwner = occupied?.playerId || null;

            // 1. If tile already owned by maxPlayer, skip
            if (currentOwner === maxPlayer) continue;

                      // 2. If tile is unclaimed, allow normal auto-expansion
          let allowCapture = !currentOwner;

          // 3. If tile is owned by another player:
          if (currentOwner && currentOwner !== maxPlayer) {
            // only allow capture if *all 6 neighbors* are owned by maxPlayer
            const neighborsHexes = this.getNeighborCoords(q, r).map(n => this.db.getHexOwner(this.gameId, n.q, n.r));
            const fullyEnclosed = neighborsHexes.every(n => n && n.playerId === maxPlayer);

            if (fullyEnclosed) {
              allowCapture = true;
            } else {
              allowCapture = false;
            }
          }

          if (!allowCapture) continue;

          // 4. Fort protection check (unchanged except scoped to opposing forts)
          const neighborsHexes = this.getNeighborCoords(q, r).map(n => this.db.getHexOwner(this.gameId, n.q, n.r));

          const fortProtected =
            (occupied && occupied.upgrade === "fort" && currentOwner !== maxPlayer) ||
            neighborsHexes.some(n => n && n.upgrade === "fort" && n.playerId !== maxPlayer);

          if (fortProtected) continue;

          // 5. Mountain check - don't auto-expand into mountains
          if (!this.db.isHexPassable(this.gameId, q, r)) continue;

            // queue capture
            toCapture.push({ q, r, attackerId: maxPlayer, prevOwnerId: currentOwner });
          }
        }

        // apply captures
        for (const cap of toCapture) {
          const { q, r, attackerId, prevOwnerId } = cap;

          // fetch player color (if we don't have it, fall back to DB player record)
          // players map might not include someone (reconnects), so use DB stored color from any hex owned or players table
          let attackerColor = this.players[attackerId]?.color;
          if (!attackerColor) {
            // try to find a hex owned by attacker to get color, or default color
            const attackerHex = this.db.getAllHexes(this.gameId).find(h => h.playerId === attackerId);
            attackerColor = attackerHex?.color || "#5865f2";
          }

          // Take a snapshot of the existing hex (to preserve upgrade via setHex)
          const existingHex = this.db.getHexOwner(this.gameId, q, r);

          // Transfer ownership (preserve any existing upgrade by calling setHex without upgrade argument)
          this.db.setHex(this.gameId, q, r, attackerId, attackerColor);
          // Log as click/history for auditability
          this.db.saveClickToGame(this.gameId, attackerId, attackerColor, q, r);

          // new authoritative hex
          const newHex = this.db.getHexOwner(this.gameId, q, r);

          // Broadcast tile change
          this.broadcast("update", { q, r, color: attackerColor, upgrade: newHex.upgrade || null, terrain: newHex.terrain || null });

          // Recalculate maxPoints for previous owner (if they lost a bank)
          if (prevOwnerId && prevOwnerId !== attackerId) {
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
              // ignore per-player recalc errors
              console.warn("recalcMaxPoints failed for prevOwner:", prevOwnerId, e);
            }
          }

          // Recalculate maxPoints for attacker (they may have gained a bank)
          try {
            const attackerRec = this.db.recalcMaxPoints(this.gameId, attackerId);
            const attackerTiles = this.db.getHexCountForPlayer(this.gameId, attackerId);
            this.broadcast("pointsUpdate", {
              playerId: attackerId,
              points: attackerRec.points,
              tiles: attackerTiles,
              maxPoints: attackerRec.maxPoints
            });
          } catch (e) {
            // fallback: send current points row
            const pp = this.db.getPlayerPoints(this.gameId, attackerId);
            this.broadcast("pointsUpdate", {
              playerId: attackerId,
              points: pp.points,
              tiles: this.db.getHexCountForPlayer(this.gameId, attackerId),
              maxPoints: pp.maxPoints
            });
          }

          // Optionally log server-side
          console.log(`Auto-capture: ${attackerId} captured ${q},${r} (prevOwner=${prevOwnerId || 'none'})`);
        }
      } catch (err) {
        console.error("AutoExpand error:", err);
      }
    }, AUTO_EXPAND_INTERVAL);
  }

  // computeCost unchanged
  computeCost(gameId, attackerPlayerId, q, r) {
    const occupied = this.db.getHexOwner(gameId, q, r);
    const upgradeCounts = this.db.getPlayerUpgradeCounts(gameId);

    if (occupied && occupied.playerId === attackerPlayerId) return null;

    const attackerHexCount = this.db.getHexCountForPlayer(gameId, attackerPlayerId) || 0;
    const expansionCost = HEX_VALUE + Math.floor(EXP_GROWTH * Math.log2(attackerHexCount + 2));
    let cost = expansionCost;

    if (occupied && occupied.playerId && occupied.playerId !== attackerPlayerId) {
      const defPlayerId = occupied.playerId;
      const defenderHexCount = Math.max(1, this.db.getHexCountForPlayer(gameId, defPlayerId));
      const defenderPoints = (this.db.getPlayerPoints(gameId, defPlayerId)?.points) || 0;
      const defenderBanks = upgradeCounts[defPlayerId]?.banks || 0;

      let defenderStrength = (1 + defenderPoints / defenderHexCount) *
                            (defenderHexCount * (HEX_VALUE + 0.5 * (defenderBanks + 1)));

      // --- Fort defense buff ---
      const neighbors = this.getNeighborCoords(q, r);
      const neighborHexes = neighbors.map(n => this.db.getHexOwner(gameId, n.q, n.r));
      const touchingFort = (occupied.upgrade === "fort") ||
                          neighborHexes.some(n => n && n.upgrade === "fort" && n.playerId === defPlayerId);

      if (touchingFort) {
        defenderStrength *= 2; // fort aura buff
      }

      let attackCost = expansionCost + OCCUPIED_BASE + Math.floor(ATTACK_MULT * Math.sqrt(defenderStrength));

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
        upgrade: h.upgrade || null,
        terrain: h.terrain || null
      };
    });

    client.send("assignedColor", { color });
    client.send("history", historyWithCrowns);
    client.send("lobbyStartTime", { ts: this.lobbyStartTime });

    // Send this player's current points + maxPoints immediately
    try {
      const pr = this.db.getPlayerPoints(this.gameId, playerId);
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
      if (this.autoExpandInterval) {
        clearInterval(this.autoExpandInterval);
        this.autoExpandInterval = null;
      }
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

    // Check if hex is passable (not a mountain)
    if (!this.db.isHexPassable(this.gameId, q, r)) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

    this.db.initPlayerInGame(this.gameId, playerId, q, r);
    this.db.setHex(this.gameId, q, r, playerId, player.color);
    this.db.saveClickToGame(this.gameId, playerId, player.color, q, r);

    this.broadcast("update", { q, r, color: player.color, crown: true, terrain: this.db.getHexTerrain(this.gameId, q, r) || null });
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

    // Check if hex is passable (not a mountain)
    if (!this.db.isHexPassable(this.gameId, q, r)) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

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
    this.broadcast("update", { q, r, color: player.color, upgrade: hex.upgrade || null, terrain: hex.terrain || null });

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
    this.broadcast("update", { q, r, color: hex.color || this.players[playerId].color, upgrade: type, terrain: hex.terrain || null });

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
        points += tiles;
        const hexmaint = Math.floor(((tiles * HEX_MAINTCOST)/4));
        points -= hexmaint;

        // 3) Extra income from CITIES (moved here from banks)
        //    Keep your old +10 per (now tied to city), or tweak as you like.
        points += cities * 5;

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

  // Batch handlers for efficient client-server communication
  handleBatchFillHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    const player = this.players[playerId];
    if (!player || !player.started) return;

    const actions = data?.actions || [];
    const results = [];

    for (const action of actions) {
      const q = Math.floor(action?.q ?? 0);
      const r = Math.floor(action?.r ?? 0);

      try { this.db.createPlayersTable(this.gameId); } catch (e) {}

      // Check if hex is passable (not a mountain)
      if (!this.db.isHexPassable(this.gameId, q, r)) {
        results.push({ q, r, ok: false, reason: "impassable" });
        continue;
      }

      const occupied = this.db.getHexOwner(this.gameId, q, r);

      // If already owned by this player, skip (no action needed)
      if (occupied && occupied.playerId === playerId) {
        // Send openOwnedTileMenu for individual clicks (not batch)
        client.send("openOwnedTileMenu", { q, r, upgrade: occupied.upgrade || null });
        continue;
      }

      const currentPoints = this.db.getPlayerPoints(this.gameId, playerId).points;
      const cost = this.computeCost(this.gameId, playerId, q, r);

      if (cost === null || currentPoints < cost) {
        results.push({ q, r, ok: false, reason: "insufficient" });
        continue;
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
      this.broadcast("update", { q, r, color: player.color, upgrade: hex.upgrade || null, terrain: hex.terrain || null });

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

      results.push({ q, r, ok: true });
    }

    // Recalculate maxPoints for attacker (they may have gained a bank from captured tiles)
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

    // Send batch results back to client
    client.send("batchFillResult", { results });
  }

  handleBatchUpgradeHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;

    const actions = data?.actions || [];
    const results = [];

    for (const action of actions) {
      const type = typeof action?.type === "string" ? action.type : null;
      const q = Math.floor(action?.q ?? 0);
      const r = Math.floor(action?.r ?? 0);

      if (!type || (type !== "bank" && type !== "fort" && type !== "city")) {
        results.push({ q, r, ok: false, error: "invalid upgrade" });
        continue;
      }

      // confirm owner
      const hex = this.db.getHexOwner(this.gameId, q, r);
      if (!hex || hex.playerId !== playerId) {
        results.push({ q, r, ok: false, error: "not owner" });
        continue;
      }

      // cost check
      const row = this.db.getPlayerPoints(this.gameId, playerId);
      const currentPoints = row?.points ?? 0;
      let cost = 0;
      if (type === "bank") cost = UPGRADE_BANK_COST;
      else if (type === "fort") cost = UPGRADE_FORT_COST;
      else if (type === "city") cost = UPGRADE_CITY_COST;

      if (currentPoints < cost) {
        results.push({ q, r, ok: false, error: "insufficient" });
        continue;
      }

      // Deduct points and persist upgrade
      const newPoints = currentPoints - cost;
      this.db.updatePlayerPoints(this.gameId, playerId, newPoints);

      // Set the upgrade on the hex (this will record upgrade_ts)
      this.db.setHexUpgrade(this.gameId, q, r, type);

      // optionally log as a click/history event as well
      this.db.saveClickToGame(this.gameId, playerId, hex.color || this.players[playerId].color, q, r);

      // Broadcast hex update (clients will display emoji)
      this.broadcast("update", { q, r, color: hex.color || this.players[playerId].color, upgrade: type, terrain: hex.terrain || null });

      results.push({ q, r, ok: true, type });
    }

    // Recalculate maxPoints for this player (buying banks increases their cap)
    const rec = this.db.recalcMaxPoints(this.gameId, playerId);
    const tiles = this.db.getHexCountForPlayer(this.gameId, playerId);

    // Broadcast points update to everyone (with updated maxPoints)
    this.broadcast("pointsUpdate", { playerId, points: rec.points, tiles, maxPoints: rec.maxPoints });

    // Send batch results back to client
    client.send("batchUpgradeResult", { results });
  }

  handleRequestPointsUpdate(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;

    try {
      const pr = this.db.getPlayerPoints(this.gameId, playerId);
      client.send("pointsUpdate", {
        playerId,
        points: pr.points,
        tiles: this.db.getHexCountForPlayer(this.gameId, playerId),
        maxPoints: pr.maxPoints
      });
    } catch (e) {
      // ignore
    }
  }

  // Handle individual hex clicks (for modal opening)
  handleClickHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    const player = this.players[playerId];
    if (!player || !player.started) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    try { this.db.createPlayersTable(this.gameId); } catch (e) {}

    // Check if hex is passable (not a mountain)
    if (!this.db.isHexPassable(this.gameId, q, r)) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

    const occupied = this.db.getHexOwner(this.gameId, q, r);

    // If already owned by this player, open owner menu (client shows modal)
    if (occupied && occupied.playerId === playerId) {
      client.send("openOwnedTileMenu", { q, r, upgrade: occupied.upgrade || null });
      return;
    }

    // For non-owned tiles, proceed with normal fill logic
    const currentPoints = this.db.getPlayerPoints(this.gameId, playerId).points;
    const cost = this.computeCost(this.gameId, playerId, q, r);

    if (cost === null || currentPoints < cost) {
      client.send("fillResult", { q, r, ok: false, reason: "insufficient" });
      return;
    }

    // Adjacency check: don't allow painting if not adjacent and they already have tiles
    const ownedHexes = this.db.getAllHexes(this.gameId).filter(h => h.playerId === playerId);
    const isAdjacent = ownedHexes.length === 0 || ownedHexes.some(h => {
      const neighbors = this.getNeighborCoords(h.q, h.r);
      return neighbors.some(n => n.q === q && n.r === r);
    });

    if (!isAdjacent && ownedHexes.length > 0) {
      client.send("fillResult", { q, r, ok: false, reason: "not_adjacent" });
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
    this.broadcast("update", { q, r, color: player.color, upgrade: hex.upgrade || null, terrain: hex.terrain || null });

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
  }
}

module.exports = { GameRoom };
