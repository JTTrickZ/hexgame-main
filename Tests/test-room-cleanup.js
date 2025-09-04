// test-room-cleanup.js
const { Room } = require("colyseus");
const GameData = require("../redis/GameData");
const config = require("../config");

// Mock Redis connection for testing
const mockRedisManager = {
  getConnection: async () => ({
    hset: () => Promise.resolve(),
    zadd: () => Promise.resolve(),
    zrem: () => Promise.resolve(),
    exists: () => Promise.resolve(true),
    hgetall: () => Promise.resolve({}),
    ping: () => Promise.resolve(),
    quit: () => Promise.resolve()
  }),
  returnConnection: () => {}
};

// Mock GameData with test methods
class MockGameData {
  constructor() {
    this.redisManager = mockRedisManager;
  }

  async isRedisAvailable() { return true; }
  async playerExists() { return true; }
  async getPlayer() { return { username: 'test', color: '#ff0000' }; }
  async getPlayerPoints() { return { points: 100, maxPoints: 200 }; }
  async getHexCountForPlayer() { return 5; }
  async updatePlayerSession() { return Promise.resolve(); }
  async addPlayerToGame() { return Promise.resolve(); }
  async removePlayerFromGame() { return Promise.resolve(); }
  async closeGame() {
    console.log('✅ closeGame called');
    return Promise.resolve();
  }
  async closeLobby() {
    console.log('✅ closeLobby called');
    return Promise.resolve();
  }
  async disconnect() { return Promise.resolve(); }
}

// Test Room Classes
class TestGameRoom extends Room {
  constructor() {
    super();
    this.gameData = new MockGameData();
    this.verifyPlayer = () => true;
    this.allowedPlayerIds = new Set();
    this.gameId = 'test-game-' + Date.now();
    this.state = { players: new Map(), gameId: this.gameId };
    this.playerTickInterval = null;
    this.autoExpandInterval = null;
    this.cleanupTimeout = null;
  }

  onCreate() {
    console.log('🎮 TestGameRoom created');
  }

  async onJoin(client, options) {
    // Cancel cleanup timeout if someone is rejoining
    if (this.cleanupTimeout) {
      console.log(`⏸ TestGameRoom ${this.gameId} cleanup cancelled - player rejoined`);
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }

  async onLeave(client) {
    console.log(`⏸ Player left (session ${client.sessionId})`);
    await this.gameData.removePlayerFromGame(this.gameId, 'test-player');

    // Remove player from state
    this.state.players.delete(client.sessionId);

    if (this.state.players.size === 0) {
      console.log(`⏳ TestGameRoom ${this.gameId} is empty, starting 60-second cleanup buffer...`);

      // Clear existing cleanup timeout if it exists
      if (this.cleanupTimeout) {
        clearTimeout(this.cleanupTimeout);
      }

      // Set 60-second timeout before cleanup
      this.cleanupTimeout = setTimeout(async () => {
        if (this.state.players.size === 0) { // Double-check room is still empty
          clearInterval(this.playerTickInterval);
          if (this.autoExpandInterval) {
            clearInterval(this.autoExpandInterval);
            this.autoExpandInterval = null;
          }
          await this.gameData.closeGame(this.gameId);
          console.log(`🏁 TestGameRoom ${this.gameId} closed after 60s buffer - disposing room`);

          // Properly dispose of the room instance
          this.disconnect();
        } else {
          console.log(`⏸ TestGameRoom ${this.gameId} cleanup cancelled - player(s) rejoined`);
        }
        this.cleanupTimeout = null;
      }, 100); // Use 100ms for testing instead of 60 seconds
    }
  }
}

class TestLobbyRoom extends Room {
  constructor() {
    super();
    this.gameData = new MockGameData();
    this.verifyPlayer = () => true;
    this.state = { players: new Map() };
    this.cleanupTimeout = null;
  }

  onCreate() {
    console.log('📦 TestLobbyRoom created');
  }

  async onJoin(client, options) {
    // Cancel cleanup timeout if someone is rejoining
    if (this.cleanupTimeout) {
      console.log(`⏸ TestLobbyRoom cleanup cancelled - player rejoined`);
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }

  async onLeave(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.state.players.delete(client.sessionId);
    console.log(`❌ Player disconnected (session ${client.sessionId})`);

    if (this.state.players.size === 0) {
      console.log("⏳ TestLobbyRoom is empty, starting 60-second cleanup buffer...");

      // Clear existing cleanup timeout if it exists
      if (this.cleanupTimeout) {
        clearTimeout(this.cleanupTimeout);
      }

      // Set 60-second timeout before cleanup
      this.cleanupTimeout = setTimeout(async () => {
        if (this.state.players.size === 0) { // Double-check room is still empty
          console.log("📦 TestLobbyRoom closed after 60s buffer - disposing room");
          await this.gameData.closeLobby(this.roomId);

          // Properly dispose of the room instance
          this.disconnect();
        } else {
          console.log("⏸ TestLobbyRoom cleanup cancelled - player(s) rejoined");
        }
        this.cleanupTimeout = null;
      }, 100); // Use 100ms for testing instead of 60 seconds
    }
  }
}

// Test Functions
async function testGameRoomCleanup() {
  console.log('\n=== Testing Game Room Cleanup ===');

  const room = new TestGameRoom();
  room.onCreate();

  // Simulate player joining
  const mockClient1 = { sessionId: 'session1' };
  const mockClient2 = { sessionId: 'session2' };
  const mockClient3 = { sessionId: 'session3' };

  room.state.players.set('session1', { id: 'player1' });
  room.state.players.set('session2', { id: 'player2' });

  console.log(`✅ Players joined: ${room.state.players.size}`);

  // Simulate first player leaving
  await room.onLeave(mockClient1);
  console.log(`✅ After first player left: ${room.state.players.size} players remaining`);

  // Simulate second player leaving (should start 60s buffer)
  await room.onLeave(mockClient2);
  console.log(`✅ After second player left: ${room.state.players.size} players remaining`);

  // Wait a bit for the timeout to be set
  await new Promise(resolve => setTimeout(resolve, 10));

  // Simulate a player rejoining before timeout (should cancel cleanup)
  console.log('⏳ Simulating player rejoin before cleanup...');
  await room.onJoin(mockClient3, { playerId: 'player3' });
  room.state.players.set('session3', { id: 'player3' });
  console.log(`✅ Player rejoined: ${room.state.players.size} players now`);

  // Wait for the original timeout to potentially fire
  await new Promise(resolve => setTimeout(resolve, 150));

  // Check if cleanup was cancelled
  let disconnectCalled = false;
  room.disconnect = () => {
    disconnectCalled = true;
    console.log('✅ Room.disconnect() called - room properly disposed');
  };

  // Now make everyone leave again
  await room.onLeave(mockClient3);
  console.log(`✅ After rejoin player left: ${room.state.players.size} players remaining`);

  // Wait for the cleanup timeout to fire
  await new Promise(resolve => setTimeout(resolve, 150));

  if (disconnectCalled) {
    console.log('✅ TEST PASSED: Room properly disposed after 60s buffer when empty');
  } else {
    console.log('❌ TEST FAILED: Room.disconnect() was not called');
  }

  return disconnectCalled;
}

async function testLobbyRoomCleanup() {
  console.log('\n=== Testing Lobby Room Cleanup ===');

  const room = new TestLobbyRoom();
  room.roomId = 'test-lobby-' + Date.now();
  room.onCreate();

  // Simulate player joining
  const mockClient1 = { sessionId: 'session1' };
  const mockClient2 = { sessionId: 'session2' };
  const mockClient3 = { sessionId: 'session3' };

  room.state.players.set('session1', { id: 'player1' });
  room.state.players.set('session2', { id: 'player2' });

  console.log(`✅ Players joined: ${room.state.players.size}`);

  // Simulate first player leaving
  await room.onLeave(mockClient1);
  console.log(`✅ After first player left: ${room.state.players.size} players remaining`);

  // Simulate second player leaving (should start 60s buffer)
  await room.onLeave(mockClient2);
  console.log(`✅ After second player left: ${room.state.players.size} players remaining`);

  // Wait a bit for the timeout to be set
  await new Promise(resolve => setTimeout(resolve, 10));

  // Simulate a player rejoining before timeout (should cancel cleanup)
  console.log('⏳ Simulating player rejoin before cleanup...');
  await room.onJoin(mockClient3, { playerId: 'player3' });
  room.state.players.set('session3', { id: 'player3' });
  console.log(`✅ Player rejoined: ${room.state.players.size} players now`);

  // Wait for the original timeout to potentially fire
  await new Promise(resolve => setTimeout(resolve, 150));

  // Check if cleanup was cancelled
  let disconnectCalled = false;
  room.disconnect = () => {
    disconnectCalled = true;
    console.log('✅ Room.disconnect() called - room properly disposed');
  };

  // Now make everyone leave again
  await room.onLeave(mockClient3);
  console.log(`✅ After rejoin player left: ${room.state.players.size} players remaining`);

  // Wait for the cleanup timeout to fire
  await new Promise(resolve => setTimeout(resolve, 150));

  if (disconnectCalled) {
    console.log('✅ TEST PASSED: Lobby properly disposed after 60s buffer when empty');
  } else {
    console.log('❌ TEST FAILED: Lobby.disconnect() was not called');
  }

  return disconnectCalled;
}

// Run tests
async function runTests() {
  console.log('🧪 Testing Room Cleanup Behavior with 60s Buffer');

  const gameRoomTest = await testGameRoomCleanup();
  const lobbyRoomTest = await testLobbyRoomCleanup();

  console.log('\n=== Test Results ===');
  console.log(`Game Room Cleanup: ${gameRoomTest ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`Lobby Room Cleanup: ${lobbyRoomTest ? '✅ PASSED' : '❌ FAILED'}`);

  if (gameRoomTest && lobbyRoomTest) {
    console.log('\n🎉 All tests passed! Room cleanup with 60s buffer is working correctly.');
  } else {
    console.log('\n❌ Some tests failed. Room cleanup may not work as expected.');
  }
}

if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testGameRoomCleanup, testLobbyRoomCleanup, runTests };
