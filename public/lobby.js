// public/lobby.js
const protocol = location.protocol === "https:" ? "wss" : "ws";
const client = new Colyseus.Client(`${protocol}://${location.hostname}:${location.port}`);

const el = id => document.getElementById(id);
const LS_PLAYER_ID = "playerId";
const LS_TOKEN = "playerToken";
const LS_USERNAME = "username";

let playerId = localStorage.getItem(LS_PLAYER_ID) || null;
let token = localStorage.getItem(LS_TOKEN) || null;
let username = localStorage.getItem(LS_USERNAME) || null;

const modal = el("firstTimeModal");
const usernameInput = el("usernameInput");
const errorMsg = el("errorMsg");
const saveUserBtn = el("saveUserBtn");
const joinBtn = el("joinBtn");
const colorPicker = el("colorPicker");
const colorSaved = el("colorSaved");

const replayInput = el("replayInput");
const replayBtn = el("replayCreateBtn");
const lastGamesDiv = el("lastGames");

function showModal(){ modal?.classList.remove("hidden"); }
function hideModal(){ modal?.classList.add("hidden"); }

function setIdentityUI(){
  el("usernameLabel").textContent = username || "Player";
  el("playerIdLabel").textContent = playerId || "—";
}

async function ensureIdentity(){
  // If identity missing, show modal and wait for register
  if(!playerId || !token || !username){
    showModal();
    return new Promise((resolve)=> {
      saveUserBtn.onclick = async () => {
        errorMsg.textContent = "";
        const name = (usernameInput.value || "").trim();
        if(name.length < 2){ errorMsg.textContent = "Name must be at least 2 characters."; return; }
        try{
          const res = await fetch("/api/register", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ username: name })
          });
          if(res.status === 409) {
            errorMsg.textContent = "Username already taken";
            return;
          }
          if(!res.ok) throw new Error("register failed");
          const data = await res.json();
          playerId = data.playerId; token = data.token; username = data.username;
          localStorage.setItem(LS_PLAYER_ID, playerId);
          localStorage.setItem(LS_TOKEN, token);
          localStorage.setItem(LS_USERNAME, username);
          setIdentityUI(); hideModal(); resolve();
        } catch(err){
          console.error(err);
          errorMsg.textContent = "Could not register. Try again.";
        }
      };
    });
  } else {
    setIdentityUI();
  }
}

async function clearLocalIdentityAndShowModal(reason) {
  console.warn("Clearing local identity because:", reason);
  localStorage.removeItem(LS_PLAYER_ID);
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USERNAME);
  playerId = token = username = null;
  window.location.reload();
  setIdentityUI();
  // Slight delay so UI updates before modal shows
  setTimeout(() => showModal(), 50);
}

async function saveColor(color){
  try{
    colorSaved.textContent = "Saving…";
    const res = await fetch("/api/player/color", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ playerId, token, color })
    });
    if(!res.ok) throw new Error("save failed");
    colorSaved.textContent = "Saved!";
    setTimeout(()=> colorSaved.textContent = "", 1000);
  } catch(e){
    colorSaved.textContent = "Save failed";
    setTimeout(()=> colorSaved.textContent = "", 1200);
  }
}

function renderLastGames(games){
  if(!lastGamesDiv) return;
  lastGamesDiv.innerHTML = "";
  (games || []).forEach(g => {
    const btn = document.createElement("button");
    btn.textContent = g.gameId;
    btn.style.backgroundColor = g.color || "#eee";
    btn.onclick = () => {
      // automatically request replay for that game
      lobbyRoom?.send("createReplay", { gameId: g.gameId });
    };
    lastGamesDiv.appendChild(btn);
  });
}

let lobbyRoom = null;

(async function bootstrap() {
  // Ensure local identity exists (or prompt to create it)
  await ensureIdentity();

  // Try to join the lobby. If the join fails (server rejects), handle gracefully.
  try {
    console.log('🔄 Attempting to connect to redisLobby...');
    lobbyRoom = await client.joinOrCreate("redisLobby", { playerId, token });

    // If we got here, join succeeded; attach handlers

    // If we got here, join succeeded; attach handlers

    // handle forced invalid player disconnect (server may kick later)
    lobbyRoom.onLeave((code, reason) => {
      // server uses 1000 + reason string "invalid or missing player" in your code
      if(code === 1000 && reason === "invalid or missing player"){
        console.warn("Player missing from DB, clearing localStorage");
        // Clear local data and prompt registration again
        clearLocalIdentityAndShowModal("invalid or missing player");
        return;
      }

      // Other leave handling (you may want to add more cases)
      if (code === 1004 || (reason && reason.includes("duplicate"))) {
        // duplicate session — ask user to re-register / rejoin
        clearLocalIdentityAndShowModal("duplicate session");
      }
    });

    lobbyRoom.onMessage("lobbyUpdate", ({ total, waiting, ready, players }) => {
      el("total").textContent = total;
      el("waiting").textContent = waiting;
      el("ready").textContent = ready;
    });

    lobbyRoom.onMessage("countdown", value => {
      el("countdown").textContent = value;
    });

    lobbyRoom.onMessage("assignedColor", ({ color }) => {
      colorPicker.value = color;
    });

    lobbyRoom.onMessage("lastGames", renderLastGames);

    lobbyRoom.onMessage("startGame", ({ roomId }) => {
      localStorage.setItem("currentRoomId", roomId);
      window.location.href = "game.html";
    });

    lobbyRoom.onMessage("replayCreated", ({ roomId }) => {
      localStorage.setItem("replayRoomId", roomId);
      window.location.href = "replay.html";
    });
    lobbyRoom.onMessage("replayError", ({ error }) => {
      alert("Could not create replay: " + (error || "unknown"));
    });

    joinBtn.onclick = () => lobbyRoom?.send("joinGame");

    colorPicker.addEventListener("input", (e) => {
      const color = e.target.value;
      if(/^#[0-9a-fA-F]{6}$/.test(color)) {
        saveColor(color);
        lobbyRoom?.send("setColor", color);
      }
    });

    if (replayBtn && replayInput) {
      replayBtn.addEventListener("click", () => {
        const gameId = (replayInput.value || "").trim();
        if (!gameId) { alert("Enter a game id to replay"); return; }
        lobbyRoom.send("createReplay", { gameId });
      });
    }

    // If we made it here, we successfully connected
    console.log("Connected to lobby as", username, playerId);
  } catch (e) {
    // Join failed. Could be server rejected the player or network error.
    console.error("Failed to connect to lobby:", e);

    // Heuristic: if the error message mentions invalid/missing/duplicate, clear local identity and prompt registration.
    const msg = (e && e.message) ? e.message.toLowerCase() : "";

    if (msg.includes("invalid") || msg.includes("missing") || msg.includes("duplicate") || msg.includes("player")) {
      // Clear local identity and prompt registration
      await clearLocalIdentityAndShowModal("server rejected join: " + (e.message || "unknown reason"));
    } else if (msg.includes("process") && msg.includes("not available")) {
      // Process not available - likely Redis/health check issue
      console.error("Server process health check failed - this may be a Redis connectivity issue");
      alert("Server is experiencing connectivity issues. Please try again in a few moments. If the problem persists, contact the administrator.");
    } else {
      // Non-auth related failure: show an alert but do not clear identity automatically
      alert("Could not connect to lobby. Is the server running? (open console for details)");
    }
  }
})();
