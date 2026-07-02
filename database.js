// database.js — Setup & helper fungsi SQLite untuk Websocket Game
"use strict";

const Database = require("better-sqlite3");
const path     = require("path");

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, "game.db");

const db = new Database(DB_PATH);

// ──────────────────────────────────────────────
//  PRAGMA — optimasi performa
// ──────────────────────────────────────────────
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ──────────────────────────────────────────────
//  CREATE TABLES
// ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

    total_games   INTEGER NOT NULL DEFAULT 0,
    total_wins    INTEGER NOT NULL DEFAULT 0,
    total_losses  INTEGER NOT NULL DEFAULT 0,
    total_draws   INTEGER NOT NULL DEFAULT 0,
    total_score   INTEGER NOT NULL DEFAULT 0,
    best_score    INTEGER NOT NULL DEFAULT 0,
    win_streak    INTEGER NOT NULL DEFAULT 0,
    best_streak   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS login_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    username    TEXT    NOT NULL,
    login_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    ip_address  TEXT,
    user_agent  TEXT
  );

  CREATE TABLE IF NOT EXISTS game_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code     TEXT    NOT NULL,
    difficulty    TEXT    NOT NULL DEFAULT 'easy',
    played_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    duration_sec  INTEGER,
    winner_name   TEXT,
    is_draw       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS game_players (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         INTEGER NOT NULL REFERENCES game_history(id) ON DELETE CASCADE,
    player_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
    username        TEXT    NOT NULL,
    score           INTEGER NOT NULL DEFAULT 0,
    matched_pairs   INTEGER NOT NULL DEFAULT 0,
    is_winner       INTEGER NOT NULL DEFAULT 0,
    disconnected    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_players_wins     ON players(total_wins DESC);
  CREATE INDEX IF NOT EXISTS idx_players_score    ON players(total_score DESC);
  CREATE INDEX IF NOT EXISTS idx_players_best     ON players(best_score DESC);
  CREATE INDEX IF NOT EXISTS idx_login_player     ON login_history(player_id);
  CREATE INDEX IF NOT EXISTS idx_game_players_pid ON game_players(player_id);
  CREATE INDEX IF NOT EXISTS idx_game_history_room ON game_history(room_code);
`);

console.log("✅ Database siap:", DB_PATH);

// ──────────────────────────────────────────────
//  PREPARED STATEMENTS (singleton, cache-friendly)
// ──────────────────────────────────────────────
const stmts = {
    getPlayer:          db.prepare("SELECT * FROM players WHERE username = ? COLLATE NOCASE"),
    insertPlayer:       db.prepare("INSERT INTO players (username) VALUES (?)"),
    insertPlayerWithPw: db.prepare("INSERT INTO players (username, password_hash) VALUES (?, ?)"),
    getPlayerById:      db.prepare("SELECT * FROM players WHERE id = ?"),
    updatePasswordHash: db.prepare("UPDATE players SET password_hash = ? WHERE username = ? COLLATE NOCASE"),

    insertLogin:  db.prepare(
        `INSERT INTO login_history (player_id, username, ip_address, user_agent)
         VALUES (?, ?, ?, ?)`
    ),

    insertGame: db.prepare(
        `INSERT INTO game_history (room_code, difficulty, duration_sec, winner_name, is_draw)
         VALUES (?, ?, ?, ?, ?)`
    ),
    insertGamePlayer: db.prepare(
        `INSERT INTO game_players (game_id, player_id, username, score, matched_pairs, is_winner, disconnected)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    updateStats: db.prepare(
        `UPDATE players SET
           total_games  = total_games  + 1,
           total_wins   = total_wins   + @win,
           total_losses = total_losses + @loss,
           total_draws  = total_draws  + @draw,
           total_score  = total_score  + @score,
           best_score   = MAX(best_score, @score),
           win_streak   = CASE WHEN @win = 1 THEN win_streak + 1 ELSE 0 END,
           best_streak  = MAX(best_streak, CASE WHEN @win = 1 THEN win_streak + 1 ELSE best_streak END)
         WHERE username = @username COLLATE NOCASE`
    ),
};

// ──────────────────────────────────────────────
//  HELPER FUNCTIONS
// ──────────────────────────────────────────────

/** Cari atau buat player baru. Return objek player. */
function upsertPlayer(username) {
    const row = stmts.getPlayer.get(username);
    if (row) return row;
    const info = stmts.insertPlayer.run(username);
    return stmts.getPlayerById.get(info.lastInsertRowid);
}

/**
 * Register player baru. Return { ok, error } 
 * Dipanggil dari POST /api/register
 */
function registerPlayer(username, passwordHash) {
    const existing = stmts.getPlayer.get(username);
    if (existing) return { ok: false, error: "Username sudah dipakai" };
    const info = stmts.insertPlayerWithPw.run(username, passwordHash);
    const player = stmts.getPlayerById.get(info.lastInsertRowid);
    return { ok: true, player };
}

/**
 * Ambil player by username untuk proses login (include password_hash).
 * Return row atau null.
 */
function getPlayerForAuth(username) {
    return stmts.getPlayer.get(username) ?? null;
}

/** Catat login pemain. */
function recordLogin(username, ipAddress = null, userAgent = null) {
    const player = upsertPlayer(username);
    stmts.insertLogin.run(player.id, username, ipAddress, userAgent);
    return player;
}

/**
 * Simpan hasil game setelah game_over.
 * @param {Object} opts
 * @param {string}      opts.roomCode
 * @param {string}      opts.difficulty
 * @param {number}      opts.durationSec
 * @param {string|null} opts.winnerName   — null jika draw
 * @param {boolean}     opts.isDraw
 * @param {Array}       opts.players — [{username, score, matchedPairs, isWinner, disconnected}]
 */
function saveGameResult({ roomCode, difficulty, durationSec, winnerName, isDraw, players }) {
    const transaction = db.transaction(() => {
        const gameInfo = stmts.insertGame.run(
            roomCode,
            difficulty,
            durationSec ?? null,
            isDraw ? null : winnerName,
            isDraw ? 1 : 0
        );
        const gameId = gameInfo.lastInsertRowid;

        for (const p of players) {
            const playerRow = upsertPlayer(p.username);

            stmts.insertGamePlayer.run(
                gameId,
                playerRow.id,
                p.username,
                p.score,
                p.matchedPairs ?? 0,
                p.isWinner ? 1 : 0,
                p.disconnected ? 1 : 0
            );

            const win  = (p.isWinner && !isDraw) ? 1 : 0;
            const loss = (!p.isWinner && !isDraw && !p.disconnected) ? 1 : 0;
            const draw = isDraw ? 1 : 0;

            stmts.updateStats.run({ win, loss, draw, score: p.score, username: p.username });
        }

        return gameId;
    });

    return transaction();
}

/** Leaderboard top-N. Mode: 'wins' | 'score' | 'best' */
function getLeaderboard(mode = "wins", limit = 10) {
    const orderMap = {
        wins:  "total_wins DESC, total_score DESC",
        score: "total_score DESC, total_wins DESC",
        best:  "best_score DESC, total_wins DESC",
    };
    const order = orderMap[mode] || orderMap.wins;
    return db.prepare(
        `SELECT username, total_games, total_wins, total_losses, total_draws,
                total_score, best_score, win_streak, best_streak
         FROM players
         ORDER BY ${order}
         LIMIT ?`
    ).all(limit);
}

/** Riwayat login pemain. */
function getLoginHistory(username, limit = 5) {
    return db.prepare(
        `SELECT lh.login_at, lh.ip_address
         FROM login_history lh
         JOIN players p ON lh.player_id = p.id
         WHERE p.username = ? COLLATE NOCASE
         ORDER BY lh.login_at DESC
         LIMIT ?`
    ).all(username, limit);
}

/** Riwayat game seorang pemain. */
function getPlayerGameHistory(username, limit = 10) {
    return db.prepare(
        `SELECT gh.room_code, gh.difficulty, gh.played_at, gh.is_draw,
                gh.winner_name, gp.score, gp.matched_pairs, gp.is_winner, gp.disconnected
         FROM game_players gp
         JOIN game_history gh ON gp.game_id = gh.id
         JOIN players p ON gp.player_id = p.id
         WHERE p.username = ? COLLATE NOCASE
         ORDER BY gh.played_at DESC
         LIMIT ?`
    ).all(username, limit);
}

/** Statistik satu pemain. */
function getPlayerStats(username) {
    return stmts.getPlayer.get(username);
}

module.exports = {
    db, upsertPlayer, recordLogin, saveGameResult,
    getLeaderboard, getLoginHistory, getPlayerGameHistory, getPlayerStats,
    registerPlayer, getPlayerForAuth,
};