// test-redis.js
const GameData = require("./redis/GameData");
const config = require("./config");

async function testRedis() {
  console.log("🧪 Testing Redis connection...");
  
  const gameData = new GameData();
  
  try {
    // Test basic Redis connection
    await gameData.redis.ping();
    console.log("✅ Redis connection successful");
    
    // Test player creation
    const playerId = await gameData.createPlayer("testuser");
    console.log("✅ Player creation successful:", playerId);
    
    // Test player retrieval
    const player = await gameData.getPlayer(playerId);
    console.log("✅ Player retrieval successful:", player);
    
    // Test game creation
    const gameId = "test-game-" + Date.now();
    await gameData.createGame(gameId, [{ playerId, username: "testuser", color: "#ff0000" }]);
    console.log("✅ Game creation successful:", gameId);
    
    // Test hex operations
    await gameData.setHex(gameId, 0, 0, playerId, "#ff0000");
    const hex = await gameData.getHex(gameId, 0, 0);
    console.log("✅ Hex operations successful:", hex);
    
    // Test points operations
    await gameData.setPlayerPoints(gameId, playerId, 100, 200);
    const points = await gameData.getPlayerPoints(gameId, playerId);
    console.log("✅ Points operations successful:", points);
    
    // Test event storage
    await gameData.saveGameEvent(gameId, playerId, "#ff0000", 0, 0, "test");
    const events = await gameData.getGameEvents(gameId);
    console.log("✅ Event storage successful:", events.length, "events");
    
    console.log("🎉 All Redis tests passed!");
    
  } catch (error) {
    console.error("❌ Redis test failed:", error);
  } finally {
    await gameData.disconnect();
  }
}

testRedis();
