// test_mountains.js - Simple test for mountain generation
const Database = require("better-sqlite3");
const path = require("path");

// Import the database functions
const db = require("./database.js");

// Test mountain generation
function testMountainGeneration() {
  console.log("🧪 Testing mountain generation...");
  
  const testGameId = "test_mountain_game";
  
  try {
    // Create test game tables
    db.createGameTables(testGameId);
    
    // Generate mountains
    const mountains = db.generateMountainChains(testGameId, 2, 5, 0.2);
    console.log(`✅ Generated ${mountains.length} mountain hexes`);
    
    // Verify mountains are in database
    const storedMountains = db.getMountainHexes(testGameId);
    console.log(`✅ Found ${storedMountains.length} mountains in database`);
    
    // Test passability
    if (mountains.length > 0) {
      const firstMountain = mountains[0];
      const isPassable = db.isHexPassable(testGameId, firstMountain.q, firstMountain.r);
      console.log(`✅ Mountain at ${firstMountain.q},${firstMountain.r} is passable: ${isPassable} (should be false)`);
      
      // Test non-mountain hex
      const isPassableNormal = db.isHexPassable(testGameId, 0, 0);
      console.log(`✅ Normal hex at 0,0 is passable: ${isPassableNormal} (should be true)`);
    }
    
    // Test terrain retrieval
    if (mountains.length > 0) {
      const firstMountain = mountains[0];
      const terrain = db.getHexTerrain(testGameId, firstMountain.q, firstMountain.r);
      console.log(`✅ Terrain at ${firstMountain.q},${firstMountain.r}: ${terrain} (should be "mountain")`);
    }
    
    console.log("🎉 Mountain generation test completed successfully!");
    
  } catch (error) {
    console.error("❌ Mountain generation test failed:", error);
  }
}

// Run the test
testMountainGeneration();
