// rooms/RedisGameRoom.js
const { Room } = require("colyseus");
const { GameState, Player, Hex } = require("../schemas/GameState");
const GameData = require("../redis/GameData");
const config = require("../config");

class RedisGameRoom extends Room {
  onCreate(options) {
    this.gameData = new GameData();
    this.verifyPlayer = options.verifyPlayer;
    this.allowedPlayerIds = new Set(options.allowedPlayerIds || []);
    this.gameId = this.roomId;
    this.autoDispose = false;

    // Initialize state
    this.setState(new GameState());
    this.state.gameId = this.gameId;
    this.state.lobbyStartTime = Date.now();
    this.state.gameStarted = true;
    this.state.lastUpdateTime = Date.now();

    // Generate mountains for this game
    this.gameData.generateMountains(this.gameId);

    // Generate rivers for this game
    this.gameData.generateRivers(this.gameId);

    // Auto-expansion interval
    this.autoExpandInterval = null;
    this.startAutoExpand();

    // Message handlers
    this.onMessage("fillHex", (client, data) => this.handleFillHex(client, data));
    this.onMessage("chooseStart", (client, data) => this.handleChooseStart(client, data));
    this.onMessage("requestHoverCost", (client, data) => this.handleRequestHoverCost(client, data));
    this.onMessage("upgradeHex", (client, data) => this.handleUpgradeHex(client, data));
    this.onMessage("batchFillHex", (client, data) => this.handleBatchFillHex(client, data));
    this.onMessage("batchUpgradeHex", (client, data) => this.handleBatchUpgradeHex(client, data));
    this.onMessage("requestPointsUpdate", (client, data) => this.handleRequestPointsUpdate(client, data));
    this.onMessage("clickHex", (client, data) => this.handleClickHex(client, data));

    console.log(`🎮 RedisGameRoom created: ${this.gameId}`);
  }

  getNeighborCoords(q, r) {
    return [
      {q: q + 1, r: r}, {q: q + 1, r: r - 1}, {q: q, r: r - 1},
      {q: q - 1, r: r}, {q: q - 1, r: r + 1}, {q: q, r: r + 1},
    ];
  }

  async startAutoExpand() {
    if (this.autoExpandInterval) clearInterval(this.autoExpandInterval);

    this.autoExpandInterval = setInterval(async () => {
      try {
        // Check if Redis is still available
        if (!this.gameData || !this.gameData.isRedisAvailable()) {
          console.warn("Redis not available, stopping auto-expansion");
          clearInterval(this.autoExpandInterval);
          return;
        }

        const allHexes = await this.gameData.getAllHexes(this.gameId);
        
        // Build candidate set
        const candidateSet = new Set();
        allHexes.forEach(h => {
          this.getNeighborCoords(parseInt(h.q), parseInt(h.r)).forEach(n => {
            candidateSet.add(`${n.q},${n.r}`);
          });
        });

        const toCapture = [];
        
        for (const key of candidateSet) {
          const [qStr, rStr] = key.split(",");
          const q = parseInt(qStr);
          const r = parseInt(rStr);

          const neighborOwners = await this.gameData.getNeighborOwners(this.gameId, q, r);
          
          // Find player with max neighbors
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

          if (maxPlayer && !tie && maxCount >= config.game.autoCaptureThreshold) {
            const occupied = await this.gameData.getHexOwner(this.gameId, q, r);
            const currentOwner = occupied?.playerId || null;

            if (currentOwner === maxPlayer) continue;

            let allowCapture = !currentOwner;

            if (currentOwner && currentOwner !== maxPlayer) {
              const neighborsHexes = await Promise.all(
                this.getNeighborCoords(q, r).map(n => this.gameData.getHexOwner(this.gameId, n.q, n.r))
              );
              const fullyEnclosed = neighborsHexes.every(n => n && n.playerId === maxPlayer);
              
              // Check for river exception: if hex is adjacent to river and player has river access
              const isAdjacentToRiver = await this.gameData.isAdjacentToRiver(this.gameId, q, r);
              const playerHasRiverAccess = await this.gameData.playerHasRiverAccess(this.gameId, maxPlayer);
              const riverException = isAdjacentToRiver && playerHasRiverAccess;
              
              allowCapture = fullyEnclosed || riverException;
            }

            if (!allowCapture) continue;

            // Fort protection check
            const neighborsHexes = await Promise.all(
              this.getNeighborCoords(q, r).map(n => this.gameData.getHexOwner(this.gameId, n.q, n.r))
            );

            const fortProtected =
              (occupied && occupied.upgrade === "fort" && currentOwner !== maxPlayer) ||
              neighborsHexes.some(n => n && n.upgrade === "fort" && n.playerId !== maxPlayer);

            if (fortProtected) continue;

            // Mountain check
            if (!(await this.gameData.isHexPassable(this.gameId, q, r))) continue;

            toCapture.push({ q, r, attackerId: maxPlayer, prevOwnerId: currentOwner });
          }
        }

        // Apply captures
        for (const cap of toCapture) {
          const { q, r, attackerId, prevOwnerId } = cap;

          let attackerColor = this.state.players.get(attackerId)?.color;
          if (!attackerColor) {
            const attackerHex = allHexes.find(h => h.playerId === attackerId);
            attackerColor = attackerHex?.color || "#5865f2";
          }

                     await this.gameData.setHex(this.gameId, q, r, attackerId, attackerColor);
           await this.gameData.saveGameEvent(this.gameId, attackerId, attackerColor, q, r, 'auto-capture');

           // Update state
           const hex = new Hex();
           hex.q = q.toString();
           hex.r = r.toString();
           hex.color = attackerColor;
           hex.playerId = attackerId;
           hex.captureTime = Date.now();
           this.state.hexes.set(`${q},${r}`, hex);

                       // Broadcast auto-capture to all clients
            this.broadcast("update", {
              q: q,
              r: r,
              color: attackerColor,
              crown: false,
              upgrade: hex.upgrade || null,
              terrain: hex.terrain || null
            });

           // Recalculate points for affected players
           if (prevOwnerId && prevOwnerId !== attackerId) {
             await this.recalculatePlayerPoints(prevOwnerId);
           }
           await this.recalculatePlayerPoints(attackerId, true); // Broadcast after auto-capture

           console.log(`Auto-capture: ${attackerId} captured ${q},${r} (prevOwner=${prevOwnerId || 'none'})`);
        }
      } catch (err) {
        console.error("AutoExpand error:", err);
        // If we get a connection error, stop the auto-expansion
        if (err.message && err.message.includes("Connection is closed")) {
          console.warn("Redis connection closed, stopping auto-expansion");
          clearInterval(this.autoExpandInterval);
        }
      }
    }, config.game.autoExpandInterval);
  }

  async computeCost(attackerPlayerId, q, r) {
    const occupied = await this.gameData.getHexOwner(this.gameId, q, r);
    
    if (occupied && occupied.playerId === attackerPlayerId) return null;

    const attackerHexCount = await this.gameData.getHexCountForPlayer(this.gameId, attackerPlayerId);
    const expansionCost = config.game.hexValue + Math.floor(config.game.expGrowth * Math.log2(attackerHexCount + 2));
    let cost = expansionCost;

    // Check if this hex is adjacent to a river
    const isAdjacentToRiver = await this.gameData.isAdjacentToRiver(this.gameId, q, r);
    const playerHasRiverAccess = await this.gameData.playerHasRiverAccess(this.gameId, attackerPlayerId);

    // River claiming rule: if hex is adjacent to river and player has river access, allow claiming
    if (isAdjacentToRiver && playerHasRiverAccess) {
      // Reduce cost for river-adjacent hexes
      cost = Math.max(1, Math.floor(cost * 0.7)); // 30% discount for river access
    }

    if (occupied && occupied.playerId && occupied.playerId !== attackerPlayerId) {
      const defPlayerId = occupied.playerId;
      const defenderHexCount = Math.max(1, await this.gameData.getHexCountForPlayer(this.gameId, defPlayerId));
      const defenderPoints = parseInt((await this.gameData.getPlayerPoints(this.gameId, defPlayerId))?.points || 0);

      let defenderStrength = (1 + defenderPoints / defenderHexCount) *
                            (defenderHexCount * (config.game.hexValue + 0.5));

      // Fort defense buff
      const neighbors = this.getNeighborCoords(q, r);
      const neighborHexes = await Promise.all(neighbors.map(n => this.gameData.getHexOwner(this.gameId, n.q, n.r)));
      const touchingFort = (occupied.upgrade === "fort") ||
                          neighborHexes.some(n => n && n.upgrade === "fort" && n.playerId === defPlayerId);

      if (touchingFort) {
        defenderStrength *= 2;
      }

      let attackCost = expansionCost + config.game.occupiedBase + Math.floor(config.game.attackMult * Math.sqrt(defenderStrength));
      cost = Math.max(cost, attackCost);
    }

    return cost;
  }

  async handleRequestHoverCost(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    
    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);
    const cost = await this.computeCost(playerId, q, r);
    client.send("hoverCost", { q, r, cost });
  }

  async onJoin(client, options) {
    const { playerId, token } = options || {};
    
    if (!this.verifyPlayer(playerId, token) || !(await this.gameData.playerExists(playerId))) {
      client.leave(1000, "invalid or missing player");
      return;
    }

    if (this.allowedPlayerIds.size > 0 && !this.allowedPlayerIds.has(playerId)) {
      client.leave(1003, "not allowed in this lobby");
      return;
    }

    // Cancel cleanup timeout if someone is rejoining
    if (this.cleanupTimeout) {
      console.log(`⏸ RedisGameRoom ${this.gameId} cleanup cancelled - player ${playerId} rejoined`);
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
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

    const playerData = await this.gameData.getPlayer(playerId);
    const playerPoints = await this.gameData.getPlayerPoints(this.gameId, playerId);

    // Create or update player in state
    const player = existingPlayer || new Player();
    player.id = playerId;
    player.username = playerData.username;
    player.color = playerData.color;
    player.points = parseInt(playerPoints.points);
    player.maxPoints = parseInt(playerPoints.maxPoints);
    player.tiles = parseInt(playerPoints.tiles);
    player.started = !!(playerPoints.startQ && playerPoints.startR);
    player.lastSeen = Date.now();
    player.disconnected = false; // Mark as connected

    this.state.players.set(client.sessionId, player);
    this.state.lastUpdateTime = Date.now();

    await this.gameData.updatePlayerSession(playerId, client.sessionId);
    
    // Only add player to game if they're not already in it (for reconnections)
    if (!existingPlayer) {
      await this.gameData.addPlayerToGame(this.gameId, playerId);
    }

    // Send initial data
    client.send("assignedColor", { color: player.color });
    client.send("lobbyStartTime", { ts: this.state.lobbyStartTime, startDelay: config.game.startDelay });

    // Send hex history - this is critical for syncing
    const hexes = await this.gameData.getAllHexes(this.gameId);
    const historyWithCrowns = hexes.map(h => ({
      q: parseInt(h.q),
      r: parseInt(h.r),
      color: h.color,
      crown: !!(h.isStart),
      upgrade: h.upgrade || null,
      terrain: h.terrain || null
    }));

    client.send("history", historyWithCrowns);

    // Send points update
    client.send("pointsUpdate", {
      playerId,
      points: player.points,
      tiles: player.tiles,
      maxPoints: player.maxPoints
    });

    // Start point tick if not already running
    if (!this.playerTickInterval) {
      setTimeout(() => this.startPointTick(), config.game.startDelay + 100);
    }

    console.log(`👤 Player ${playerId} joined RedisGameRoom ${this.gameId} color=${player.color}`);
  }

  async onLeave(client) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (playerId) {
      console.log(`⏸ Player ${playerId} left (session ${client.sessionId}) but kept in game for reconnect`);
      // Don't remove player from game - keep them for reconnection
    }

    // Mark player as disconnected but keep them in state for reconnection
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.disconnected = true;
      player.lastSeen = Date.now();
    }

    // Count only connected players
    const connectedPlayers = Array.from(this.state.players.values()).filter(p => !p.disconnected);

    if (connectedPlayers.length === 0) {
      console.log(`⏳ RedisGameRoom ${this.gameId} is empty, starting 60-second cleanup buffer...`);

      // Clear existing cleanup timeout if it exists
      if (this.cleanupTimeout) {
        clearTimeout(this.cleanupTimeout);
      }

      // Set 60-second timeout before cleanup
      this.cleanupTimeout = setTimeout(async () => {
        // Count connected players again after timeout
        const stillConnectedPlayers = Array.from(this.state.players.values()).filter(p => !p.disconnected);
        
        if (stillConnectedPlayers.length === 0) { // Double-check room is still empty
          console.log(`🏁 RedisGameRoom ${this.gameId} cleanup timeout reached - room will be disposed naturally`);
          
          // Clean up intervals
          if (this.playerTickInterval) {
            clearInterval(this.playerTickInterval);
            this.playerTickInterval = null;
          }
          if (this.autoExpandInterval) {
            clearInterval(this.autoExpandInterval);
            this.autoExpandInterval = null;
          }
          
          // Remove all players from game before closing
          for (const [sessionId, player] of this.state.players.entries()) {
            await this.gameData.removePlayerFromGame(this.gameId, player.id);
          }
          
          await this.gameData.closeGame(this.gameId);
          
          // Mark room as ready for disposal but don't force it
          // Colyseus will dispose the room naturally since no players are connected
          this.state.readyForDisposal = true;
          this.state.lastUpdateTime = Date.now();
          
          
          // Manually dispose the room after cleanup
          this.disconnect();
        } else {
          console.log(`⏸ RedisGameRoom ${this.gameId} cleanup cancelled - player(s) rejoined`);
        }
        this.cleanupTimeout = null;
      }, 60000); // 60 seconds
    }
  }

  getPlayerIdBySession(sessionId) {
    for (const [sid, player] of this.state.players.entries()) {
      if (sid === sessionId) return player.id;
    }
    return null;
  }

  async handleChooseStart(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    
    const player = this.state.players.get(client.sessionId);
    if (!player || player.started) return;

    const nowTs = Date.now();
    if (nowTs > this.state.lobbyStartTime + config.game.startDelay) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    // Check if hex is already occupied
    const occupied = await this.gameData.getHexOwner(this.gameId, q, r);
    if (occupied && occupied.playerId) {
      client.send("fillResult", { q, r, ok: false, reason: "occupied" });
      return;
    }

    if (!(await this.gameData.isHexPassable(this.gameId, q, r))) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

    // Set the starting hex
    await this.gameData.setHex(this.gameId, q, r, playerId, player.color, null, null, true);
    await this.gameData.saveGameEvent(this.gameId, playerId, player.color, q, r, 'start');

    // Set start coordinates for player
    const currentPoints = await this.gameData.getPlayerPoints(this.gameId, playerId);
    await this.gameData.setPlayerPoints(this.gameId, playerId, parseInt(currentPoints.points), parseInt(currentPoints.maxPoints), q, r);

    // Update state
    const hex = new Hex();
    hex.q = q.toString();
    hex.r = r.toString();
    hex.color = player.color;
    hex.playerId = playerId;
    hex.isCrown = true;
    hex.captureTime = Date.now();
    this.state.hexes.set(`${q},${r}`, hex);

    player.started = true;
    this.state.lastUpdateTime = Date.now();

    // Send success response to the client
    client.send("fillResult", { q, r, ok: true });

    // Broadcast hex update to all clients
    this.broadcast("update", {
      q: parseInt(hex.q),
      r: parseInt(hex.r),
      color: hex.color,
      crown: true,
      upgrade: hex.upgrade || null,
      terrain: hex.terrain || null
    });

    await this.recalculatePlayerPoints(playerId);
  }

  async handleFillHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.started) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    if (!(await this.gameData.isHexPassable(this.gameId, q, r))) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

    const occupied = await this.gameData.getHexOwner(this.gameId, q, r);

    if (occupied && occupied.playerId === playerId) {
      client.send("openOwnedTileMenu", { q, r, upgrade: occupied.upgrade || null });
      return;
    }

    const currentPoints = parseInt((await this.gameData.getPlayerPoints(this.gameId, playerId)).points);
    const cost = await this.computeCost(playerId, q, r);

    if (cost === null || currentPoints < cost) {
      client.send("fillResult", { q, r, ok: false, reason: "insufficient" });
      return;
    }

    await this.gameData.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);
    const prevOwnerId = occupied && occupied.playerId ? occupied.playerId : null;

    await this.gameData.setHex(this.gameId, q, r, playerId, player.color);
    await this.gameData.saveGameEvent(this.gameId, playerId, player.color, q, r, 'capture');

    // Update state
    const hex = new Hex();
    hex.q = q.toString();
    hex.r = r.toString();
    hex.color = player.color;
    hex.playerId = playerId;
    hex.upgrade = occupied?.upgrade || '';
    hex.terrain = occupied?.terrain || '';
    hex.captureTime = Date.now();
    this.state.hexes.set(`${q},${r}`, hex);

    console.log(`Player ${playerId} spent ${cost}, captured ${q},${r}`);

    // Send success response to the client
    client.send("fillResult", { q, r, ok: true });

    // Broadcast hex update to all clients
    this.broadcast("hexUpdate", {
      q: parseInt(hex.q),
      r: parseInt(hex.r),
      color: hex.color,
      crown: false,
      upgrade: hex.upgrade || null,
      terrain: hex.terrain || null
    });

    // Recalculate points for affected players
    if (prevOwnerId && prevOwnerId !== playerId) {
      await this.recalculatePlayerPoints(prevOwnerId);
    }
    await this.recalculatePlayerPoints(playerId, true); // Broadcast after hex capture
  }

  async handleUpgradeHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return client.send("upgradeResult", { ok: false, error: "no player" });

    const type = typeof data?.type === "string" ? data.type : null;
    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    if (!type || (type !== "bank" && type !== "fort" && type !== "city")) {
      return client.send("upgradeResult", { ok: false, error: "invalid upgrade" });
    }

    const hex = await this.gameData.getHexOwner(this.gameId, q, r);
    if (!hex || hex.playerId !== playerId) {
      return client.send("upgradeResult", { ok: false, error: "not owner" });
    }

    const row = await this.gameData.getPlayerPoints(this.gameId, playerId);
    const currentPoints = parseInt(row?.points ?? 0);
    let cost = 0;
    
    if (type === "bank") cost = config.game.upgradeBankCost;
    else if (type === "fort") cost = config.game.upgradeFortCost;
    else if (type === "city") cost = config.game.upgradeCityCost;

    if (currentPoints < cost) {
      return client.send("upgradeResult", { ok: false, error: "insufficient" });
    }

    await this.gameData.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);
    await this.gameData.setHexUpgrade(this.gameId, q, r, type);
    await this.gameData.saveGameEvent(this.gameId, playerId, hex.color, q, r, 'upgrade');

    // Update state
    const stateHex = this.state.hexes.get(`${q},${r}`);
    if (stateHex) {
      stateHex.upgrade = type;
    }

    // Broadcast upgrade to all clients
    this.broadcast("update", {
      q: q,
      r: r,
      color: hex.color,
      crown: false,
      upgrade: type,
      terrain: hex.terrain || null
    });

    await this.recalculatePlayerPoints(playerId, true); // Broadcast after upgrade
    client.send("upgradeResult", { ok: true, type });
  }

  async handleBatchFillHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.started) return;

    const hexes = data?.hexes || [];
    const results = [];

    for (const { q, r } of hexes) {
      const qInt = Math.floor(q);
      const rInt = Math.floor(r);

      if (!(await this.gameData.isHexPassable(this.gameId, qInt, rInt))) {
        results.push({ q: qInt, r: rInt, ok: false, reason: "impassable" });
        continue;
      }

      const occupied = await this.gameData.getHexOwner(this.gameId, qInt, rInt);
      if (occupied && occupied.playerId === playerId) {
        results.push({ q: qInt, r: rInt, ok: false, reason: "already_owned" });
        continue;
      }

      const currentPoints = parseInt((await this.gameData.getPlayerPoints(this.gameId, playerId)).points);
      const cost = await this.computeCost(playerId, qInt, rInt);

      if (cost === null || currentPoints < cost) {
        results.push({ q: qInt, r: rInt, ok: false, reason: "insufficient" });
        continue;
      }

      await this.gameData.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);
      await this.gameData.setHex(this.gameId, qInt, rInt, playerId, player.color);
      await this.gameData.saveGameEvent(this.gameId, playerId, player.color, qInt, rInt, 'capture');

      // Update state
      const hex = new Hex();
      hex.q = qInt.toString();
      hex.r = rInt.toString();
      hex.color = player.color;
      hex.playerId = playerId;
      hex.captureTime = Date.now();
      this.state.hexes.set(`${qInt},${rInt}`, hex);

      // Broadcast hex update to all clients
      this.broadcast("update", {
        q: qInt,
        r: rInt,
        color: player.color,
        crown: false,
        upgrade: null,
        terrain: null
      });

      results.push({ q: qInt, r: rInt, ok: true });
    }

    await this.recalculatePlayerPoints(playerId, true); // Broadcast after batch fill
    client.send("batchFillResult", { results });
  }

  async handleBatchUpgradeHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;

    const hexes = data?.hexes || [];
    const results = [];

    for (const { q, r, type } of hexes) {
      const qInt = Math.floor(q);
      const rInt = Math.floor(r);

      if (!type || (type !== "bank" && type !== "fort" && type !== "city")) {
        results.push({ q: qInt, r: rInt, ok: false, error: "invalid upgrade" });
        continue;
      }

      const hex = await this.gameData.getHexOwner(this.gameId, qInt, rInt);
      if (!hex || hex.playerId !== playerId) {
        results.push({ q: qInt, r: rInt, ok: false, error: "not owner" });
        continue;
      }

      const row = await this.gameData.getPlayerPoints(this.gameId, playerId);
      const currentPoints = parseInt(row?.points ?? 0);
      let cost = 0;
      
      if (type === "bank") cost = config.game.upgradeBankCost;
      else if (type === "fort") cost = config.game.upgradeFortCost;
      else if (type === "city") cost = config.game.upgradeCityCost;

      if (currentPoints < cost) {
        results.push({ q: qInt, r: rInt, ok: false, error: "insufficient" });
        continue;
      }

      await this.gameData.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);
      await this.gameData.setHexUpgrade(this.gameId, qInt, rInt, type);
      await this.gameData.saveGameEvent(this.gameId, playerId, hex.color, qInt, rInt, 'upgrade');

      // Broadcast upgrade to all clients
      this.broadcast("update", {
        q: qInt,
        r: rInt,
        color: hex.color,
        crown: false,
        upgrade: type,
        terrain: hex.terrain || null
      });

      results.push({ q: qInt, r: rInt, ok: true, type });
    }

    await this.recalculatePlayerPoints(playerId, true); // Broadcast after batch upgrade
    client.send("batchUpgradeResult", { results });
  }

  async handleRequestPointsUpdate(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;

    // Always get fresh data from Redis
    const points = await this.gameData.getPlayerPoints(this.gameId, playerId);
    const tiles = await this.gameData.getHexCountForPlayer(this.gameId, playerId);
    
    // Recalculate max points based on current state
    const hexes = await this.gameData.getAllHexes(this.gameId);
    const bankCount = hexes.filter(h => h.playerId === playerId && h.upgrade === 'bank').length;
    const tileCount = hexes.filter(h => h.playerId === playerId).length;
    const maxPoints = config.game.startingMaxPoints + (bankCount * 50) + (tileCount * 5);

    client.send("pointsUpdate", {
      playerId,
      points: parseInt(points.points),
      tiles: tiles,
      maxPoints: maxPoints
    });
  }

  async handleClickHex(client, data) {
    const playerId = this.getPlayerIdBySession(client.sessionId);
    if (!playerId) return;
    
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.started) return;

    const q = Math.floor(data?.q ?? 0);
    const r = Math.floor(data?.r ?? 0);

    if (!(await this.gameData.isHexPassable(this.gameId, q, r))) {
      client.send("fillResult", { q, r, ok: false, reason: "impassable" });
      return;
    }

    const occupied = await this.gameData.getHexOwner(this.gameId, q, r);

    if (occupied && occupied.playerId === playerId) {
      client.send("openOwnedTileMenu", { q, r, upgrade: occupied.upgrade || null });
      return;
    }

    const currentPoints = parseInt((await this.gameData.getPlayerPoints(this.gameId, playerId)).points);
    const cost = await this.computeCost(playerId, q, r);

    if (cost === null || currentPoints < cost) {
      client.send("fillResult", { q, r, ok: false, reason: "insufficient" });
      return;
    }

    // Adjacency check with river exception
    const ownedHexes = (await this.gameData.getAllHexes(this.gameId)).filter(h => h.playerId === playerId);
    const isAdjacent = ownedHexes.length === 0 || ownedHexes.some(h => {
      const neighbors = this.getNeighborCoords(parseInt(h.q), parseInt(h.r));
      return neighbors.some(n => n.q === q && n.r === r);
    });

    // Check if hex is adjacent to river and player has river access
    const isAdjacentToRiver = await this.gameData.isAdjacentToRiver(this.gameId, q, r);
    const playerHasRiverAccess = await this.gameData.playerHasRiverAccess(this.gameId, playerId);
    const riverException = isAdjacentToRiver && playerHasRiverAccess;

    if (!isAdjacent && !riverException && ownedHexes.length > 0) {
      client.send("fillResult", { q, r, ok: false, reason: "not_adjacent" });
      return;
    }

    await this.gameData.updatePlayerPoints(this.gameId, playerId, currentPoints - cost);
    const prevOwnerId = occupied && occupied.playerId ? occupied.playerId : null;

    await this.gameData.setHex(this.gameId, q, r, playerId, player.color);
    await this.gameData.saveGameEvent(this.gameId, playerId, player.color, q, r, 'capture');

    // Update state
    const hex = new Hex();
    hex.q = q.toString();
    hex.r = r.toString();
    hex.color = player.color;
    hex.playerId = playerId;
    hex.upgrade = occupied?.upgrade || '';
    hex.terrain = occupied?.terrain || '';
    hex.captureTime = Date.now();
    this.state.hexes.set(`${q},${r}`, hex);

    console.log(`Player ${playerId} spent ${cost}, captured ${q},${r}`);

    // Send success response to the client
    client.send("fillResult", { q, r, ok: true });

    // Broadcast hex update to all clients
    this.broadcast("update", {
      q: parseInt(hex.q),
      r: parseInt(hex.r),
      color: hex.color,
      crown: false,
      upgrade: hex.upgrade || null,
      terrain: hex.terrain || null
    });

    if (prevOwnerId && prevOwnerId !== playerId) {
      await this.recalculatePlayerPoints(prevOwnerId);
    }
    await this.recalculatePlayerPoints(playerId, true); // Broadcast after click hex
  }

  async recalculatePlayerPoints(playerId, shouldBroadcast = false) {
    try {
      const player = Array.from(this.state.players.values()).find(p => p.id === playerId && !p.disconnected);
      if (!player) return;

      const points = await this.gameData.getPlayerPoints(this.gameId, playerId);
      const tiles = await this.gameData.getHexCountForPlayer(this.gameId, playerId);

      // Calculate maxPoints based on banks and tiles
      const hexes = await this.gameData.getAllHexes(this.gameId);
      const bankCount = hexes.filter(h => h.playerId === playerId && h.upgrade === 'bank').length;
      const tileCount = hexes.filter(h => h.playerId === playerId).length;
      const maxPoints = config.game.startingMaxPoints + (bankCount * 50) + (tileCount * 5);

      player.points = parseInt(points.points);
      player.maxPoints = maxPoints;
      player.tiles = tiles;

      this.state.lastUpdateTime = Date.now();

      // Only broadcast if explicitly requested (for immediate UI updates after actions)
      if (shouldBroadcast) {
        this.broadcast("pointsUpdate", {
          playerId,
          points: player.points,
          tiles: player.tiles,
          maxPoints: player.maxPoints
        });
      }
    } catch (e) {
      console.error("Error recalculating points for player:", playerId, e);
    }
  }

  startPointTick() {
    this.playerTickInterval = setInterval(async () => {
      try {
        // Check if Redis is still available
        if (!this.gameData || !this.gameData.isRedisAvailable()) {
          console.warn("Redis not available, stopping point tick");
          clearInterval(this.playerTickInterval);
          return;
        }

        for (const [sessionId, player] of this.state.players.entries()) {
          // Only process connected players
          if (player.disconnected) continue;
          
          const currentPoints = parseInt((await this.gameData.getPlayerPoints(this.gameId, player.id)).points);
          const newPoints = currentPoints + config.game.baseIncome;
          await this.gameData.updatePlayerPoints(this.gameId, player.id, newPoints);
          
          player.points = newPoints;
          
          // Don't broadcast here - let the client request updates when needed
          // The point tick only updates the server state, client requests handle UI updates
        }
        this.state.lastUpdateTime = Date.now();
      } catch (e) {
        console.error("Point tick error:", e);
        // If we get a connection error, stop the tick
        if (e.message && e.message.includes("Connection is closed")) {
          console.warn("Redis connection closed, stopping point tick");
          clearInterval(this.playerTickInterval);
        }
      }
    }, 1000);
  }

  onDispose() {
    // Clear cleanup timeout if it exists
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }

    if (this.autoExpandInterval) {
      clearInterval(this.autoExpandInterval);
    }
    if (this.playerTickInterval) {
      clearInterval(this.playerTickInterval);
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
      console.warn("Error disposing RedisGameRoom:", error.message);
    }
    console.log(`🏁 RedisGameRoom ${this.gameId} disposed`);
  }
}

module.exports = { RedisGameRoom };
