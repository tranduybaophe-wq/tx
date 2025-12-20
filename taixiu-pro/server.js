import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(s);
  }
}

function nowMs() {
  return Date.now();
}

function randInt(min, max) {
  const range = max - min + 1;
  const bytes = crypto.randomBytes(4);
  const n = bytes.readUInt32BE(0);
  return min + (n % range);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function newRoundFair() {
  const serverSeed = crypto.randomBytes(16).toString("hex");
  const commit = sha256Hex(serverSeed);
  return { serverSeed, commit };
}

const rooms = new Map(); // roomId -> room

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      createdAt: nowMs(),
      players: new Map(), // id -> {id,name,ws,balance,statsKey}
      bets: new Map(),    // id -> {side, amount}
      state: "BETTING",   // BETTING | ROLLING | SETTLED
      countdownMs: 18000,
      bettingEndsAt: nowMs() + 18000,
      roundId: 1,
      fair: newRoundFair(),
      lastResult: null,
      history: [], // last 20 rounds
      leaderboard: new Map() // statsKey -> {name, wins, losses, net, played}
    });
    startRoomLoop(rooms.get(roomId));
  }
  return rooms.get(roomId);
}

function listRooms() {
  const out = [];
  for (const r of rooms.values()) {
    out.push({
      roomId: r.roomId,
      state: r.state,
      roundId: r.roundId,
      players: r.players.size,
      createdAt: r.createdAt
    });
  }
  // most active first, then newest
  out.sort((a, b) => (b.players - a.players) || (b.createdAt - a.createdAt));
  return out.slice(0, 50);
}

function leaderboardSnapshot(room) {
  const arr = [...room.leaderboard.values()].map(x => ({ ...x }));
  arr.sort((a, b) => (b.net - a.net) || (b.wins - a.wins) || (b.played - a.played));
  return arr.slice(0, 20);
}

function roomSnapshot(room) {
  return {
    roomId: room.roomId,
    state: room.state,
    countdownMs: Math.max(0, room.bettingEndsAt - nowMs()),
    roundId: room.roundId,
    commit: room.fair.commit,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, balance: p.balance })),
    bets: [...room.bets.entries()].map(([pid, b]) => ({ playerId: pid, side: b.side, amount: b.amount })),
    lastResult: room.lastResult,
    history: room.history,
    leaderboard: leaderboardSnapshot(room)
  };
}

function ensureStats(room, statsKey, name) {
  if (!room.leaderboard.has(statsKey)) {
    room.leaderboard.set(statsKey, { name, wins: 0, losses: 0, net: 0, played: 0 });
  } else {
    // keep latest name
    room.leaderboard.get(statsKey).name = name;
  }
  return room.leaderboard.get(statsKey);
}

function settleRoom(room) {
  const d1 = randInt(1, 6);
  const d2 = randInt(1, 6);
  const d3 = randInt(1, 6);
  const sum = d1 + d2 + d3;
  const side = sum >= 11 ? "TAI" : "XIU";

  for (const [pid, bet] of room.bets.entries()) {
    const player = room.players.get(pid);
    if (!player) continue;

    const st = ensureStats(room, player.statsKey, player.name);

    st.played += 1;
    if (bet.side === side) {
      player.balance += bet.amount;
      st.wins += 1;
      st.net += bet.amount;
    } else {
      player.balance -= bet.amount;
      st.losses += 1;
      st.net -= bet.amount;
    }
    if (player.balance < 0) player.balance = 0;
  }

  room.lastResult = {
    roundId: room.roundId,
    dice: [d1, d2, d3],
    sum,
    side,
    revealedServerSeed: room.fair.serverSeed,
    commit: room.fair.commit,
    ts: new Date().toISOString()
  };

  room.history.unshift(room.lastResult);
  room.history = room.history.slice(0, 20);

  room.bets.clear();
}

function startNextRound(room) {
  room.roundId += 1;
  room.state = "BETTING";
  room.countdownMs = 18000;
  room.bettingEndsAt = nowMs() + room.countdownMs;
  room.fair = newRoundFair();
  broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });
}

function startRoomLoop(room) {
  const tick = () => {
    const t = nowMs();

    if (room.state === "BETTING") {
      const remain = room.bettingEndsAt - t;
      if (remain <= 0) {
        room.state = "ROLLING";
        broadcast(room, { type: "STATE", payload: { state: "ROLLING" } });

        setTimeout(() => {
          room.state = "SETTLED";
          settleRoom(room);
          broadcast(room, { type: "RESULT", payload: room.lastResult });
          broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });

          setTimeout(() => startNextRound(room), 6000);
        }, 2500);
      } else {
        if (remain % 1000 < 60) {
          broadcast(room, { type: "COUNTDOWN", payload: { remainMs: Math.max(0, remain) } });
        }
      }
    }
  };

  setInterval(tick, 60);
}

function safeName(s) {
  const x = (s || "").trim().slice(0, 20);
  return x.length ? x.replace(/[^\p{L}\p{N}\s._-]/gu, "") : "Player";
}

function safeRoomId(s) {
  const x = (s || "").trim().slice(0, 24);
  return x.length ? x.replace(/[^\p{L}\p{N}._-]/gu, "") : "lobby";
}

/** ===== HTTP server: static + /api/rooms ===== */
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/api/rooms") {
    return json(res, 200, { rooms: listRooms() });
  }

  const filePath = url === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, url);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "application/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

/** ===== WS server ===== */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const playerId = crypto.randomBytes(8).toString("hex");
  let room = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === "LIST_ROOMS") {
      return send(ws, { type: "ROOMS", payload: { rooms: listRooms() } });
    }

    if (msg.type === "JOIN") {
      const roomId = safeRoomId(msg.roomId || "lobby");
      const name = safeName(msg.name || "Player");

      room = getRoom(roomId);

      // statsKey: room-local identity by name (demo). If you want stronger identity: add auth later.
      const statsKey = `${roomId}:${name.toLowerCase()}`;

      room.players.set(playerId, {
        id: playerId,
        name,
        ws,
        balance: 1000,
        statsKey
      });

      ensureStats(room, statsKey, name);

      send(ws, { type: "WELCOME", payload: { playerId } });
      send(ws, { type: "ROOM", payload: roomSnapshot(room) });
      broadcast(room, { type: "CHAT", payload: { system: true, text: `${name} đã vào phòng.` } });
      broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });
      return;
    }

    if (!room) return;

    if (msg.type === "BET") {
      const player = room.players.get(playerId);
      if (!player) return;

      if (room.state !== "BETTING") {
        return send(ws, { type: "ERR", payload: { message: "Hết thời gian cược." } });
      }

      const side = msg.side === "TAI" ? "TAI" : msg.side === "XIU" ? "XIU" : null;
      const amount = Number(msg.amount);

      if (!side || !Number.isFinite(amount) || amount <= 0) {
        return send(ws, { type: "ERR", payload: { message: "Cược không hợp lệ." } });
      }

      const maxBet = Math.min(5000, player.balance);
      if (amount > maxBet) {
        return send(ws, { type: "ERR", payload: { message: `Cược tối đa: ${maxBet}` } });
      }

      room.bets.set(playerId, { side, amount });
      broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });
      return;
    }

    if (msg.type === "CHAT") {
      const player = room.players.get(playerId);
      if (!player) return;
      const text = String(msg.text || "").trim().slice(0, 120);
      if (!text) return;
      broadcast(room, { type: "CHAT", payload: { from: player.name, text } });
      return;
    }

    if (msg.type === "RESET_BALANCE") {
      const player = room.players.get(playerId);
      if (!player) return;
      player.balance = 1000;
      broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });
      return;
    }
  });

  ws.on("close", () => {
    if (!room) return;
    const p = room.players.get(playerId);
    if (p) {
      room.players.delete(playerId);
      room.bets.delete(playerId);
      broadcast(room, { type: "CHAT", payload: { system: true, text: `${p.name} đã rời phòng.` } });
      broadcast(room, { type: "ROOM", payload: roomSnapshot(room) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
