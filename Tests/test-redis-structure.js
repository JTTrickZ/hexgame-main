// test-redis-structure.js
const GameData = require('./redis/GameData');

async function testRedisStructure() {
  const gameData = new GameData();
  
  try {
    console.log('🧪 Testing new Redis key structure...\n');
    
    // Test player creation
    console.log('1. Creating test player...');
    const playerId = await gameData.createPlayer('TestPlayer');
    console.log(`   ✅ Player created: ${playerId}`);
    
    // Test player retrieval
    console.log('\n2. Retrieving player data...');
    const player = await gameData.getPlayer(playerId);
    console.log(`   ✅ Player data:`, player);
    
    // Test lobby creation
    console.log('\n3. Creating test lobby...');
    const lobbyId = 'test-lobby-123';
    await gameData.createLobby(lobbyId);
    console.log(`   ✅ Lobby created: ${lobbyId}`);
    
    // Test adding player to lobby
    console.log('\n4. Adding player to lobby...');
    await gameData.addPlayerToLobby(lobbyId, playerId);
    const lobbyPlayers = await gameData.getLobbyPlayers(lobbyId);
    console.log(`   ✅ Lobby players:`, lobbyPlayers);
    
    // Test game creation
    console.log('\n5. Creating test game...');
    const gameId = 'test-game-456';
    await gameData.createGame(gameId, [{ playerId, username: 'TestPlayer', color: '#ff0000' }]);
    console.log(`   ✅ Game created: ${gameId}`);
    
    // Test adding player to game
    console.log('\n6. Adding player to game...');
    await gameData.addPlayerToGame(gameId, playerId);
    const gamePlayers = await gameData.getGamePlayers(gameId);
    console.log(`   ✅ Game players:`, gamePlayers);
    
    // Test hex operations
    console.log('\n7. Testing hex operations...');
    await gameData.setHex(gameId, 0, 0, playerId, '#ff0000', null, null, true);
    await gameData.setHex(gameId, 1, 0, playerId, '#ff0000');
    await gameData.setHex(gameId, 0, 1, null, '#8B4513', null, 'mountain');
    
    const hexes = await gameData.getAllHexes(gameId);
    console.log(`   ✅ Hexes created:`, hexes.length);
    console.log(`   ✅ Hex data:`, hexes[0]);
    
    // Test points operations
    console.log('\n8. Testing points operations...');
    await gameData.setPlayerPoints(gameId, playerId, 100, 150, 0, 0);
    const points = await gameData.getPlayerPoints(gameId, playerId);
    console.log(`   ✅ Points data:`, points);
    
    // Test game events
    console.log('\n9. Testing game events...');
    await gameData.saveGameEvent(gameId, playerId, '#ff0000', 0, 0, 'start');
    await gameData.saveGameEvent(gameId, playerId, '#ff0000', 1, 0, 'capture');
    
    const events = await gameData.getGameEvents(gameId);
    console.log(`   ✅ Events created:`, events.length);
    console.log(`   ✅ Event data:`, events[0]);
    
    // Test mountain generation
    console.log('\n10. Testing mountain generation...');
    await gameData.generateMountains(gameId);
    const allHexes = await gameData.getAllHexes(gameId);
    const mountains = allHexes.filter(h => h.terrain === 'mountain');
    console.log(`   ✅ Mountains generated:`, mountains.length);
    
    console.log('\n🎉 All Redis structure tests passed!');
    console.log('\n📊 Final Redis keys created:');
    console.log(`   - players:${playerId}:data`);
    console.log(`   - players:${playerId}:session`);
    console.log(`   - lobbies:${lobbyId}:data`);
    console.log(`   - lobbies:${lobbyId}:players`);
    console.log(`   - games:${gameId}:data`);
    console.log(`   - games:${gameId}:players`);
    console.log(`   - games:${gameId}:hexes`);
    console.log(`   - games:${gameId}:points`);
    console.log(`   - games:${gameId}:events`);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await gameData.disconnect();
  }
}

testRedisStructure();
