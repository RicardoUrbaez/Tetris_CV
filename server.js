/**
 * Tetris Hands — Node/Express + Socket.IO
 * Serves /public, multiplayer rooms (create/join), state broadcast.
 * Listen on 0.0.0.0 so LAN clients can connect; log LAN URL.
 */
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/node_modules", express.static(path.join(__dirname, "node_modules")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/** Get first non-internal IPv4 for LAN URL */
function getLanUrl(port) {
  const portNum = port || 3000;
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return `http://${iface.address}:${portNum}`;
        }
      }
    }
  } catch (e) {}
  return `http://localhost:${portNum}`;
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const rooms = new Map(); // roomCode -> { hostId, players: Set(socketId) }

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function getRoomBySocket(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (room.players.has(socketId)) return { code, room };
  }
  return null;
}

function getOtherPlayer(room, excludeSocketId) {
  for (const id of room.players) {
    if (id !== excludeSocketId) return id;
  }
  return null;
}

function emitToOpponent(socket, eventName, payload) {
  const ref = getRoomBySocket(socket.id);
  if (!ref) return false;
  const otherId = getOtherPlayer(ref.room, socket.id);
  if (!otherId) return false;
  io.to(otherId).emit(eventName, payload || {});
  return true;
}

function leaveRoom(socket) {
  const ref = getRoomBySocket(socket.id);
  if (!ref) return;

  ref.room.players.delete(socket.id);
  socket.leave(ref.code);
  socket.roomCode = null;
  socket.isHost = false;

  if (ref.room.players.size === 0) {
    rooms.delete(ref.code);
    return;
  }

  io.to(ref.code).emit("players-update", {
    roomCode: ref.code,
    playerCount: ref.room.players.size,
    hostId: ref.room.hostId
  });
  io.to(ref.code).emit("player-left", { socketId: socket.id });
}

io.on("connection", (socket) => {
  socket.on("create-room", () => {
    const existing = getRoomBySocket(socket.id);
    if (existing) {
      socket.emit("room-error", { message: "Already in a room" });
      return;
    }
    const roomCode = generateRoomCode();
    const room = { hostId: socket.id, players: new Set([socket.id]) };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    const lanUrl = getLanUrl(PORT);
    socket.emit("room-created", { roomCode, lanUrl, hostId: socket.id });
  });

  socket.on("join-room", (code) => {
    const existing = getRoomBySocket(socket.id);
    if (existing) {
      socket.emit("room-error", { message: "Already in a room" });
      return;
    }

    const roomCode = String(code || "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("room-error", { message: "Room not found" });
      return;
    }
    if (room.players.size >= 2) {
      socket.emit("room-error", { message: "Room full" });
      return;
    }
    room.players.add(socket.id);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = room.hostId === socket.id;
    socket.emit("room-joined", { roomCode, playerCount: room.players.size });
    io.to(roomCode).emit("players-update", {
      roomCode,
      playerCount: room.players.size,
      hostId: room.hostId
    });
  });

  socket.on("start-game", () => {
    const ref = getRoomBySocket(socket.id);
    if (!ref || !ref.room.players.has(socket.id) || ref.room.hostId !== socket.id) return;
    if (ref.room.players.size < 2) {
      socket.emit("room-error", { message: "Need 2 players" });
      return;
    }
    io.to(ref.code).emit("game-started", { roomCode: ref.code });
  });

  socket.on("start-play", () => {
    const ref = getRoomBySocket(socket.id);
    if (!ref || ref.room.hostId !== socket.id) return;
    io.to(ref.code).emit("play-started", {});
  });

  socket.on("state", (payload) => {
    const ref = getRoomBySocket(socket.id);
    if (!ref) return;
    const otherId = getOtherPlayer(ref.room, socket.id);
    if (otherId) io.to(otherId).emit("opponent-state", payload);
  });

  socket.on("send-garbage", (payload) => {
    const lines = Math.max(0, Math.min(4, Math.floor(Number(payload && payload.lines) || 0)));
    if (!lines) return;
    emitToOpponent(socket, "receive-garbage", { lines });
  });

  socket.on("player-lost", (payload) => {
    emitToOpponent(socket, "player-won", {
      reason: payload && payload.reason ? String(payload.reason) : "opponent-lost"
    });
  });

  socket.on("rematch-request", () => {
    emitToOpponent(socket, "rematch-request", {});
  });

  socket.on("rematch-accepted", () => {
    const ref = getRoomBySocket(socket.id);
    if (!ref) return;
    io.to(ref.code).emit("rematch-accepted", {});
  });

  socket.on("leave-room", () => {
    leaveRoom(socket);
  });

  socket.on("cv-action", (payload) => {
    const action = typeof payload === "string" ? payload : payload && payload.action;
    if (!action) return;

    const message = {
      action: String(action).toUpperCase(),
      ts: payload && payload.ts ? payload.ts : Date.now(),
      sourceId: socket.id
    };

    if (socket.roomCode) {
      socket.to(socket.roomCode).emit("cv-action", message);
      socket.emit("cv-action", message);
      return;
    }

    socket.broadcast.emit("cv-action", message);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const lan = getLanUrl(PORT);
  console.log("Tetris Hands server");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("  LAN:     " + lan);
  console.log("  Same Wi-Fi: open " + lan + " and enter room code.");
});
