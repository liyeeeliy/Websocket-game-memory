// server.js — Memory Match Multiplayer WebSocket Server
"use strict";

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const {
  recordLogin,
  saveGameResult,
  getLeaderboard,
  getPlayerGameHistory,
  getPlayerStats,
  registerPlayer,
  getPlayerForAuth,
} = require("./database");

const JWT_SECRET = process.env.JWT_SECRET || "ganti-ini-dengan-secret-panjang-di-env";
const BCRYPT_ROUNDS = 10;

// ──────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ──────────────────────────────────────────────
//  STATIC & REST API
// ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── REGISTER ──────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || typeof username !== "string" || !password || typeof password !== "string") {
    return res.status(400).json({ error: "Username dan password wajib diisi" });
  }
  const name = username.trim().slice(0, 16);
  if (name.length < 3) return res.status(400).json({ error: "Username minimal 3 karakter" });
  if (password.length < 6) return res.status(400).json({ error: "Password minimal 6 karakter" });

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = registerPlayer(name, hash);
    if (!result.ok) return res.status(409).json({ error: result.error });

    const token = jwt.sign(
      { id: result.player.id, username: result.player.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    console.log(`✅ Register: ${name}`);
    res.json({ token, username: result.player.username });
  } catch (e) {
    console.error("register error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── LOGIN ─────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username dan password wajib diisi" });
  }

  try {
    const player = getPlayerForAuth(username.trim());
    if (!player) return res.status(401).json({ error: "Username atau password salah" });

    // Player lama tanpa password_hash — suruh set password
    if (!player.password_hash) {
      return res.status(401).json({ error: "Akun ini belum punya password. Silakan register ulang." });
    }

    const match = await bcrypt.compare(password, player.password_hash);
    if (!match) return res.status(401).json({ error: "Username atau password salah" });

    const token = jwt.sign(
      { id: player.id, username: player.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    try { recordLogin(player.username, req.ip); } catch (_) { }
    console.log(`🔑 Login: ${player.username}`);
    res.json({ token, username: player.username });
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// REST: leaderboard
app.get("/api/leaderboard", (req, res) => {
  const mode = ["wins", "score", "best"].includes(req.query.mode) ? req.query.mode : "wins";
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
  try {
    res.json(getLeaderboard(mode, limit));
  } catch (e) {
    console.error("leaderboard error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

// REST: profil + riwayat game pemain
// GET /api/player/:username
app.get("/api/player/:username", (req, res) => {
  const { username } = req.params;
  try {
    const stats = getPlayerStats(username);
    if (!stats) return res.status(404).json({ error: "Player tidak ditemukan" });
    const history = getPlayerGameHistory(username, 10);
    res.json({ stats, history });
  } catch (e) {
    console.error("player profile error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

// Catch-all → index.html (SPA fallback)
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ──────────────────────────────────────────────
//  GAME DATA
// ──────────────────────────────────────────────
const EMOJI_LIST = [
  "🍎", "🍌", "🍇", "🍊", "🍓", "🍒", "🍍", "🥝", "🍋", "🍉",
  "🍐", "🍑", "🌽", "🍄", "🍔", "🍕", "🍖", "🍦", "🍩", "🍭",
  "🏀", "⚽", "🎮", "🚗", "🚀", "🛸", "💎", "🌈",
];

const rooms = {};

// ──────────────────────────────────────────────
//  ROOM CLEANUP — hapus room kosong / stale
//  Jalan setiap 5 menit, hapus room yang:
//    - sudah tidak ada player, ATAU
//    - sudah tidak active lebih dari 2 jam
// ──────────────────────────────────────────────
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 jam
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    const stale = room.players.length === 0 || (now - room.lastActivity > ROOM_TTL_MS);
    if (stale) {
      clearInterval(room.timerInterval);
      delete rooms[code];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} stale room(s). Active: ${Object.keys(rooms).length}`);
    broadcastRoomList();
  }
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────
//  GAME HELPERS
// ──────────────────────────────────────────────
function generateDeck(rows, cols) {
  const total = rows * cols;
  const pairs = Math.floor(total / 2);
  const deck = [];
  for (let i = 0; i < pairs; i++) {
    const emoji = EMOJI_LIST[i % EMOJI_LIST.length];
    deck.push(emoji, emoji);
  }
  if (deck.length < total) deck.push("❓");
  return deck.sort(() => Math.random() - 0.5);
}

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  room.players.forEach(p => {
    if (p && p.readyState === WebSocket.OPEN) p.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ──────────────────────────────────────────────
//  PUBLIC ROOM LIST — room yang masih 1 player & belum mulai
// ──────────────────────────────────────────────
function getPublicRoomList() {
  return Object.values(rooms)
    .filter(r => !r.started && r.players.length === 1)
    .map(r => ({ code: r.code, host: r.names[0] || "Anonim", difficulty: r.lastDifficulty || "easy" }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function broadcastRoomList() {
  const msg = JSON.stringify({ type: "room_list", rooms: getPublicRoomList() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.authed) c.send(msg);
  });
}

function startTimer(room) {
  if (!room || room.players.length === 0) return;
  clearInterval(room.timerInterval);
  room.timeLeft = 15;

  room.timerInterval = setInterval(() => {
    if (!room || room.players.length === 0) {
      clearInterval(room.timerInterval);
      return;
    }
    room.timeLeft--;
    broadcast(room, { type: "timer", time: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      if (!room.started) return; // guard: game sudah selesai saat tick terakhir masuk
      room.scores[room.turn] = Math.max(0, room.scores[room.turn] - 5);
      const temp = [...room.flipped];
      room.flipped = [];
      room.turn = (room.turn + 1) % room.players.length;
      broadcast(room, {
        type: "update", scores: room.scores, turn: room.turn,
        match: false, flipped: temp, names: room.names,
      });
      startTimer(room);
    }
  }, 1000);
}

function resetRoomToLobby(room) {
  clearInterval(room.timerInterval);
  room.started = false;
  room.flipped = [];
  room.matched = [];
  room.scores = room.scores.map(() => 0);
  room.deck = [];
  room.restartPending = false;
  room.gameStartedAt = null;
  room.lastActivity = Date.now();
  room.gameJustEnded = true; // ← flag: game baru selesai, belum ada yang restart/lobby
}

/**
 * Simpan hasil game ke DB lalu broadcast game_over.
 * Dipanggil dari dua tempat: flip (semua kartu habis) & close (disconnect).
 */
function finishGame(room, winnerName, isDraw, disconnectedName = null) {
  clearInterval(room.timerInterval);

  const durationSec = room.gameStartedAt
    ? Math.round((Date.now() - room.gameStartedAt) / 1000)
    : null;

  // Bangun data pemain untuk DB
  const playersData = room.names.map((name, idx) => ({
    username: name,
    score: room.scores[idx] ?? 0,
    matchedPairs: Math.floor((room.matched.length / 2) * (room.scores[idx] > 0 ? 1 : 0)), // estimasi
    isWinner: !isDraw && name === winnerName,
    disconnected: name === disconnectedName,
  }));

  try {
    saveGameResult({
      roomCode: room.code,
      difficulty: room.lastDifficulty || "easy",
      durationSec,
      winnerName: isDraw ? null : winnerName,
      isDraw,
      players: playersData,
    });
    console.log(`💾 Game saved: room ${room.code}, winner: ${isDraw ? "draw" : winnerName}`);
  } catch (e) {
    console.error("⚠️  saveGameResult error:", e.message);
  }

  const payload = {
    type: "game_over", winner: isDraw ? "Seri!" : winnerName,
    scores: room.scores, names: room.names,
  };
  if (disconnectedName) payload.disconnected = disconnectedName;

  broadcast(room, payload);
  resetRoomToLobby(room);
}

// ──────────────────────────────────────────────
//  WEBSOCKET
// ──────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket.remoteAddress
    || null;
  ws._ip = ip;
  console.log("🟢 Player Connected from", ip);

  ws.on("message", (msg) => {
    let d;
    try { d = JSON.parse(msg); }
    catch { console.error("Invalid JSON"); return; }

    // Update lastActivity pada room yang bersangkutan
    if (ws.room && rooms[ws.room]) rooms[ws.room].lastActivity = Date.now();

    // ── AUTH — verifikasi JWT sebelum bisa berbuat apapun ──
    if (d.type === "auth") {
      try {
        const payload = jwt.verify(d.token, JWT_SECRET);
        ws.userName = payload.username;
        ws.userId = payload.id;
        ws.authed = true;
        sendTo(ws, { type: "auth_ok", username: payload.username });
        sendTo(ws, { type: "room_list", rooms: getPublicRoomList() });
        console.log(`🔑 WS Auth OK: ${ws.userName}`);
      } catch (e) {
        sendTo(ws, { type: "auth_fail", message: "Token tidak valid atau expired. Silakan login ulang." });
        ws.close();
      }
      return;
    }

    // Semua message setelah ini wajib sudah auth
    if (!ws.authed) {
      sendTo(ws, { type: "auth_fail", message: "Belum login." });
      ws.close();
      return;
    }

    // ── LOGIN (deprecated — diganti auth, tapi dipertahankan agar tidak error) ──
    if (d.type === "login") {
      // Nama sudah di-set dari token saat auth, ignore d.name dari client
      return;
    }

    // ── CREATE ROOM ───────────────────────────────────
    if (d.type === "create") {
      if (ws.room) {
        sendTo(ws, { type: "room_created", code: ws.room });
        return;
      }
      let code;
      do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
      } while (rooms[code]);

      rooms[code] = {
        code,
        players: [ws],
        names: [ws.userName || "Anonim"],
        scores: [0],
        turn: 0,
        deck: [],
        flipped: [],
        matched: [],
        started: false,
        host: ws,
        lastDifficulty: "easy",
        restartPending: false,
        gameStartedAt: null,
        gameJustEnded: false,
        lastActivity: Date.now(),
      };
      ws.room = code;
      ws.id = 0;
      console.log(`🏠 Room dibuat: ${code} oleh ${ws.userName}`);
      sendTo(ws, { type: "room_created", code });
      broadcastRoomList();
    }

    // ── JOIN ROOM ─────────────────────────────────────
    if (d.type === "join") {
      const code = d.code?.toUpperCase();
      const room = rooms[code];
      if (!room) return sendTo(ws, { type: "error", message: "❌ Room tidak ditemukan: " + code });
      if (room.players.length >= 2) return sendTo(ws, { type: "error", message: "❌ Room sudah penuh!" });
      if (room.started) return sendTo(ws, { type: "error", message: "❌ Game sudah berjalan!" });
      if (ws.room === code) return sendTo(ws, { type: "error", message: "❌ Kamu sudah ada di room ini!" });

      room.players.push(ws);
      room.names.push(ws.userName || "Anonim");
      room.scores.push(0);
      ws.room = code;
      ws.id = room.players.length - 1;
      room.lastActivity = Date.now();

      console.log(`👥 ${ws.userName} join room: ${code}`);
      broadcast(room, { type: "player_joined", names: room.names, scores: room.scores });
      sendTo(ws, { type: "room_created", code });
      broadcastRoomList();
    }

    // ── START GAME ────────────────────────────────────
    if (d.type === "start") {
      const room = rooms[ws.room];
      if (!room) return sendTo(ws, { type: "error", message: "Room tidak ditemukan" });
      if (ws !== room.host) return sendTo(ws, { type: "error", message: "Hanya host yang bisa mulai!" });
      if (room.players.length < 2) return sendTo(ws, { type: "error", message: "Butuh 2 player untuk mulai!" });

      const cfgMap = { easy: [3, 4], medium: [4, 5], hard: [5, 6] };
      const cfg = cfgMap[d.difficulty] || cfgMap["easy"];

      room.rows = cfg[0];
      room.cols = cfg[1];
      room.deck = generateDeck(cfg[0], cfg[1]);
      room.started = true;
      room.turn = 0;
      room.flipped = [];
      room.matched = [];
      room.scores = room.scores.map(() => 0);
      room.lastDifficulty = d.difficulty || "easy";
      room.restartPending = false;
      room.gameStartedAt = Date.now();
      room.lastActivity = Date.now();
      room.gameJustEnded = false;

      console.log(`🎮 Game start: room ${room.code}, ${cfg[0]}x${cfg[1]}, players: ${room.names.join(", ")}`);

      broadcast(room, {
        type: "game_start", rows: room.rows, cols: room.cols,
        names: room.names, scores: room.scores, turn: room.turn,
      });
      setTimeout(() => { if (room.started) startTimer(room); }, 500);
      broadcastRoomList();
    }

    // ── FLIP ──────────────────────────────────────────
    if (d.type === "flip") {
      const room = rooms[ws.room];
      if (!room || !room.started) return;
      if (ws.id !== room.turn) return;
      if (room.flipped.length >= 2) return;

      // Validasi index: harus number, dalam range deck, bukan NaN
      const flipIdx = parseInt(d.index, 10);
      if (isNaN(flipIdx) || flipIdx < 0 || flipIdx >= room.deck.length) return;

      if (room.matched.includes(flipIdx)) return;
      if (room.flipped.includes(flipIdx)) return;

      room.flipped.push(flipIdx);
      room.lastActivity = Date.now();

      sendTo(ws, { type: "flip_self", index: flipIdx, emoji: room.deck[flipIdx] });
      room.players.forEach(p => {
        if (p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ type: "flip_opponent", index: flipIdx }));
        }
      });

      if (room.flipped.length === 2) {
        clearInterval(room.timerInterval);
        const [a, b] = room.flipped;
        const isMatch = room.deck[a] === room.deck[b];

        setTimeout(() => {
          if (!room.started) return; // guard: game sudah berakhir saat timeout
          if (!room.players.includes(ws)) return; // guard: player DC dalam window 800ms

          if (isMatch) {
            room.scores[ws.id] += 10;
            room.matched.push(a, b);
          } else {
            room.turn = (room.turn + 1) % room.players.length;
          }

          broadcast(room, {
            type: "update", scores: room.scores, turn: room.turn,
            match: isMatch, flipped: [a, b], names: room.names,
          });
          room.flipped = [];

          // Cek game selesai
          if (room.matched.length >= room.deck.length) {
            const s0 = room.scores[0], s1 = room.scores[1];
            const isDraw = s0 === s1;
            const winnerIdx = s1 > s0 ? 1 : 0;
            const winnerName = isDraw ? "Seri!" : room.names[winnerIdx];
            console.log(`🏆 Game over room ${room.code}: ${winnerName}`);
            finishGame(room, isDraw ? null : winnerName, isDraw);
          } else {
            startTimer(room);
          }
        }, 800);
      }
    }

    // ── RESTART REQUEST ──────────────────────────────
    if (d.type === "restart") {
      const room = rooms[ws.room];
      if (!room) return;
      if (room.started) return;
      if (room.restartPending) return; // already pending, ignore duplicate
      if (room.players.length < 2) return sendTo(ws, { type: "error", message: "Butuh 2 player!" });

      const requesterIdx = room.players.indexOf(ws);
      const opponentIdx = requesterIdx === 0 ? 1 : 0;
      room.restartPending = true;
      room.lastActivity = Date.now();

      sendTo(room.players[opponentIdx], {
        type: "restart_request", requester: room.names[requesterIdx],
      });
      sendTo(ws, {
        type: "restart_waiting",
        message: `Menunggu konfirmasi dari ${room.names[opponentIdx]}...`,
      });
      console.log(`🔄 Restart request: room ${room.code} dari ${ws.userName}`);
    }

    // ── RESTART ACCEPT ───────────────────────────────
    if (d.type === "restart_accept") {
      const room = rooms[ws.room];
      if (!room || !room.restartPending) return;
      clearInterval(room.timerInterval);

      const cfgMap = { easy: [3, 4], medium: [4, 5], hard: [5, 6] };
      const cfg = cfgMap[room.lastDifficulty] || cfgMap["easy"];

      room.rows = cfg[0];
      room.cols = cfg[1];
      room.deck = generateDeck(cfg[0], cfg[1]);
      room.started = true;
      room.turn = 0;
      room.flipped = [];
      room.matched = [];
      room.scores = room.scores.map(() => 0);
      room.restartPending = false;
      room.gameStartedAt = Date.now();
      room.lastActivity = Date.now();
      room.gameJustEnded = false; // ← tambah ini

      console.log(`✅ Restart accepted: room ${room.code}`);
      broadcast(room, {
        type: "game_start", rows: room.rows, cols: room.cols,
        names: room.names, scores: room.scores, turn: room.turn,
      });
      setTimeout(() => { if (room.started) startTimer(room); }, 500);
    }

    // ── RESTART DECLINE ──────────────────────────────
    if (d.type === "restart_decline") {
      const room = rooms[ws.room];
      if (!room) return;
      const declinerIdx = room.players.indexOf(ws);
      const declinerName = room.names[declinerIdx] || ws.userName;
      resetRoomToLobby(room);
      room.gameJustEnded = false;
      console.log(`❌ Restart declined: room ${room.code} oleh ${declinerName}`);
      broadcast(room, {
        type: "go_lobby",
        message: `${declinerName} menolak main ulang. Kembali ke lobby.`,
      });
    }

    // ── LEAVE ROOM ────────────────────────────────────
        if (d.type === "leave_room") {
            if (!ws.room || !rooms[ws.room]) return;
            const room = rooms[ws.room];
            const leaverName = ws.userName || "Player";

            room.players = room.players.filter(p => p !== ws);
            ws.room = null;

            if (room.players.length === 0) {
                clearInterval(room.timerInterval);
                delete rooms[room.code];
                console.log(`🗑️  Room ${room.code} dihapus (kosong setelah leave)`);
            } else {
                // Beritahu player yang tersisa
                room.names  = room.players.map(p => p.userName || "Anonim");
                room.scores = [0];
                room.gameJustEnded = false;
                room.players[0].id = 0;
                room.host = room.players[0];
                broadcast(room, {
                    type: "chat_broadcast", sender: "System",
                    text: `${leaverName} keluar dari lobby`,
                });
                broadcast(room, { type: "player_joined", names: room.names, scores: room.scores });
            }
            broadcastRoomList();
        }

        // ── CHAT ─────────────────────────────────────────
        if (d.type === "chat") {
      const room = rooms[ws.room];
      if (!room) return;
      const text = String(d.text || "").trim().slice(0, 200);
      if (!text) return;
      broadcast(room, {
        type: "chat_broadcast",
        sender: ws.userName || "Anonim",
        text,
      });
    }

    // ── LIST ROOMS (via WS) ──────────────────────────
    if (d.type === "list_rooms") {
      sendTo(ws, { type: "room_list", rooms: getPublicRoomList() });
    }

    // ── REQUEST LEADERBOARD (via WS) ─────────────────
    if (d.type === "get_leaderboard") {
      const mode = ["wins", "score", "best"].includes(d.mode) ? d.mode : "wins";
      const limit = Math.min(parseInt(d.limit || 10, 10), 50);
      try {
        sendTo(ws, { type: "leaderboard_data", mode, rows: getLeaderboard(mode, limit) });
      } catch (e) {
        console.error("leaderboard WS error:", e.message);
      }
    }
  });

  // ── DISCONNECT ────────────────────────────────────────
  ws.on("close", () => {
    console.log(`🔴 Disconnect: ${ws.userName || "unknown"} (${ws._ip})`);
    if (!ws.room || !rooms[ws.room]) return;

    const room = rooms[ws.room];
    const wasInGame = room.started;
    const disconnectedName = ws.userName || "Player";

    clearInterval(room.timerInterval);
    room.players = room.players.filter(p => p !== ws);

    if (room.players.length === 0) {
      const deletedCode = ws.room; // simpan dulu sebelum null
      delete rooms[ws.room];
      ws.room = null;
      console.log(`🗑️  Room ${deletedCode} dihapus (kosong)`);
    } else {
      const remaining = room.players[0];
      if (wasInGame) {
        const winnerName = remaining.userName || "Anonim";
        console.log(`🏆 ${winnerName} menang karena ${disconnectedName} disconnect`);

        // Simpan skor sebelum reset
        const scoresSnapshot = [...room.scores];
        const namesSnapshot = [...room.names];

        // finishGame mengirim game_over ke semua player yang masih ada
        // Kita kirim manual karena broadcast hanya ke room.players (sudah difilter)
        try {
          const durationSec = room.gameStartedAt
            ? Math.round((Date.now() - room.gameStartedAt) / 1000)
            : null;
          saveGameResult({
            roomCode: room.code,
            difficulty: room.lastDifficulty || "easy",
            durationSec,
            winnerName,
            isDraw: false,
            players: namesSnapshot.map((name, idx) => ({
              username: name,
              score: scoresSnapshot[idx] ?? 0,
              matchedPairs: 0,
              isWinner: name === winnerName,
              disconnected: name === disconnectedName,
            })),
          });
          console.log(`💾 Disconnect game saved: room ${room.code}`);
        } catch (e) {
          console.error("saveGameResult (disconnect) error:", e.message);
        }

        sendTo(remaining, {
          type: "game_over",
          winner: winnerName,
          scores: scoresSnapshot,
          names: namesSnapshot,
          disconnected: disconnectedName,
        });

        resetRoomToLobby(room);
        room.names = [remaining.userName || "Anonim"];
        room.scores = [0];
        room.players = [remaining]; // pastikan array bersih, sync dengan names & scores
        remaining.id = 0;
        room.host = remaining;

      } else {
        if (room.gameJustEnded) {
          // Player exit dari overlay game over setelah game selesai normal
          room.names = [remaining.userName || "Anonim"];
          room.scores = [0];
          room.players = [remaining];
          room.gameJustEnded = false;
          remaining.id = 0;
          room.host = remaining;
          sendTo(remaining, {
            type: "go_lobby",
            message: `${disconnectedName} keluar dari room.`,
          });
        } else {
          // Murni disconnect di lobby sebelum game pernah dimulai
          room.names = room.players.map(p => p.userName || "Anonim");
          room.scores = room.scores.slice(0, room.players.length);
          broadcast(room, {
            type: "chat_broadcast", sender: "System",
            text: `${disconnectedName} keluar dari lobby`,
          });
          broadcast(room, { type: "player_joined", names: room.names, scores: room.scores });
        }
        ws.room = null; // ← clear di semua non-delete path
      }
    }
    broadcastRoomList();
  });
});

// ──────────────────────────────────────────────
//  START
// ──────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  // Cari semua IP lokal untuk info logging
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  const locals = [];
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) locals.push(iface.address);
    }
  }
  console.log("================================");
  console.log("🚀 SERVER READY");
  console.log(`🌐 http://localhost:${PORT}`);
  locals.forEach(ip => console.log(`🌐 http://${ip}:${PORT}  ← share ke teman`));
  console.log("================================");
});