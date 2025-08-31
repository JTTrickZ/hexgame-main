// Connect to the server
const socket = io();

// Wait until DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const joinBtn = document.getElementById("joinBtn");

  // Attach click handler
  joinBtn.addEventListener("click", () => {
    console.log("Join button clicked!");   // <-- should show in browser console
    socket.emit("joinLobby");
  });

  // Handle when server says the game is starting
  socket.on("gameStarted", (data) => {
    console.log("Game starting with ID:", data.gameId);
    window.location.href = "game.html";
  });
});
