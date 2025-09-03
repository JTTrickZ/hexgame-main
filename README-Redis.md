# Redis-Based Web Game Server

This is a refactored version of the web game that uses Redis for data storage and Colyseus for real-time communication.

## Features

- **Redis Storage**: All game data is stored in Redis using JSON format
- **Colyseus Schema**: State synchronization using Colyseus schemas
- **Real-time Gameplay**: Hex-based territory capture game with upgrades
- **Auto-expansion**: Automatic territory capture based on neighbor ownership
- **Replay System**: Game replay functionality using stored events
- **Player Management**: User registration and color customization

## Prerequisites

- Node.js (v14 or higher)
- Redis server running locally or remotely

## Installation

1. Install dependencies:
```bash
npm install
```

2. Configure Redis connection in `config.js` or set environment variables:
```bash
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD=your_password_if_needed
export REDIS_DB=0
```

## Running the Server

Start the Redis-based server:
```bash
node redis-server.js
```

The server will start on port 3000 (or the port specified in config.js).

## Game Rooms

- **redisLobby**: Where players join and wait for games to start
- **redisGame**: The main game room where hex capture happens
- **redisReplay**: Replay room for watching past games

## API Endpoints

- `POST /api/register` - Register a new player or login existing player
- `POST /api/player/color` - Update player color
- `GET /api/history?lobbyId=<id>` - Get game history for replay

## Game Mechanics

### Hex Capture
- Players spend points to capture hexes
- Cost increases with territory size (logarithmic growth)
- Adjacent hexes can be captured more easily
- Non-adjacent hexes require higher costs

### Upgrades
- **Bank**: Increases maximum points (cost: 100)
- **Fort**: Provides defensive bonuses (cost: 300)
- **City**: Provides economic benefits (cost: 200)

### Auto-expansion
- When a player controls 4+ neighbors of an unclaimed hex, it's automatically captured
- Forts provide protection against auto-capture
- Mountains are impassable and cannot be captured

### Economy
- Players earn 2 points per second
- Banks increase maximum point capacity
- Points are spent on hex capture and upgrades

## Redis Data Structure

### Players
- `player:{playerId}` - Player information (hash)
- `players:active` - Set of active player IDs (sorted set)

### Games
- `game:{gameId}` - Game information (hash)
- `games:active` - Set of active game IDs (sorted set)
- `game:{gameId}:players` - Players in this game (set)
- `game:{gameId}:hexes` - Hexes in this game (set)

### Hexes
- `hex:{gameId}:{q}:{r}` - Hex information (hash)
- Contains: playerId, color, upgrade, terrain, captureTime

### Points
- `points:{gameId}:{playerId}` - Player points (hash)
- Contains: points, maxPoints, tiles, startQ, startR

### Events
- `game:{gameId}:events` - Game events for replay (list)
- Events include: playerId, color, q, r, eventType, timestamp

## Configuration

All game constants and settings are in `config.js`:

- Redis connection settings
- Game timing (start delay, auto-expansion interval)
- Hex values and costs
- Upgrade costs
- Mountain generation parameters
- Player colors

## Migration from SQL

This version does not migrate existing SQL data. All data is stored fresh in Redis with the same structure but in JSON format instead of relational tables.

## Performance Benefits

- **Faster Queries**: Redis in-memory operations are much faster than SQL queries
- **Reduced Latency**: No database round-trips for game state
- **Scalability**: Redis can handle high concurrent loads
- **State Synchronization**: Colyseus schemas optimize network traffic
- **JSON Storage**: More flexible data structure than rigid SQL schemas
