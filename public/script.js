/* script.js — Memory Match Multiplayer Client */
"use strict";

// ──────────────────────────────────────────────
//  AUDIO MANAGER
// ──────────────────────────────────────────────
const Audio_lobby = new Audio("/lobby.mp3");
Audio_lobby.loop   = true;
Audio_lobby.volume = 0.5;

const Audio_game = new Audio("/game.mp3");
Audio_game.loop   = true;
Audio_game.volume = 0.5;

function playLobbyMusic() {
    Audio_game.pause();
    Audio_game.currentTime = 0;
    Audio_lobby.currentTime = 0;
    Audio_lobby.play().catch(() => {});
}

function playGameMusic() {
    Audio_lobby.pause();
    Audio_lobby.currentTime = 0;
    Audio_game.currentTime = 0;
    Audio_game.play().catch(() => {});
}

function stopAllMusic() {
    Audio_lobby.pause();
    Audio_game.pause();
}

// ──────────────────────────────────────────────
//  AUTO-DETECT WebSocket URL
//  - Pakai window.location → otomatis benar di mana pun server jalan
//  - Bisa di-override lewat meta tag <meta name="ws-host" content="wss://...">
// ──────────────────────────────────────────────
function getWsUrl() {
    const metaEl = document.querySelector('meta[name="ws-host"]');
    if (metaEl && metaEl.content) return metaEl.content;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}`;
}

// ──────────────────────────────────────────────
//  STATE
// ──────────────────────────────────────────────
let ws;
let totalPairs    = 0;
let matchedPairs  = 0;
let myPlayerIndex = -1;

// ── SOLO / VS COMPUTER STATE ─────────────────────────
const EMOJI_LIST = [
    "🍎", "🍌", "🍇", "🍊", "🍓", "🍒", "🍍", "🥝", "🍋", "🍉",
    "🍐", "🍑", "🌽", "🍄", "🍔", "🍕", "🍖", "🍦", "🍩", "🍭",
    "🏀", "⚽", "🎮", "🚗", "🚀", "🛸", "💎", "🌈",
];
let soloMode = false;
let solo     = null; // { rows, cols, deck, flipped, matched, scores, turn, timeLeft, timerId, memory, difficulty, busy }

// ── AUTH STATE ──────────────────────────────────────
let authToken    = localStorage.getItem("mm_token") || null;
let authUsername = localStorage.getItem("mm_username") || null;

function saveAuth(token, username) {
    authToken    = token;
    authUsername = username;
    localStorage.setItem("mm_token", token);
    localStorage.setItem("mm_username", username);
}

function clearAuth() {
    authToken    = null;
    authUsername = null;
    localStorage.removeItem("mm_token");
    localStorage.removeItem("mm_username");
}

// ──────────────────────────────────────────────
//  CONNECT & SETUP
// ──────────────────────────────────────────────
// ── REGISTER ────────────────────────────────────────
async function doRegister() {
    const username  = document.getElementById("reg-username").value.trim();
    const password  = document.getElementById("reg-password").value;
    const password2 = document.getElementById("reg-password2").value;
    const errEl     = document.getElementById("auth-error");
    const btn       = document.getElementById("btn-register");

    // Reset error
    errEl.innerText = "";
    errEl.classList.remove("show");

    // Validasi client-side
    if (!username || !password) {
        errEl.innerText = "Username dan password wajib diisi";
        errEl.classList.add("show");
        return;
    }
    if (password !== password2) {
        errEl.innerText = "Password tidak cocok";
        errEl.classList.add("show");
        return;
    }
    if (password.length < 6) {
        errEl.innerText = "Password minimal 6 karakter";
        errEl.classList.add("show");
        return;
    }

    // Loading state
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }

    try {
        const res  = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            // Register gagal — tampilkan error
            errEl.innerText = data.error || "Gagal register";
            errEl.classList.add("show");
            return;
        }

        // ✅ Register berhasil — tampilkan feedback sebelum masuk lobby
        showAuthSuccess(`Akun "${data.username}" berhasil dibuat! 🎉`);
        saveAuth(data.token, data.username);
        setTimeout(() => connectAndContinue(), 1500); // delay biar user sempat baca

    } catch {
        errEl.innerText = "Gagal konek ke server";
        errEl.classList.add("show");
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    }
}

// ── LOGIN ────────────────────────────────────────────
async function doLogin() {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl    = document.getElementById("auth-error");
    const btn      = document.getElementById("btn-login");

    // Reset error
    errEl.innerText = "";
    errEl.classList.remove("show");

    if (!username || !password) {
        errEl.innerText = "Isi username dan password";
        errEl.classList.add("show");
        return;
    }

    // Loading state
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }

    try {
        const res  = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            errEl.innerText = data.error || "Login gagal";
            errEl.classList.add("show");
            return;
        }

        saveAuth(data.token, data.username);
        connectAndContinue();

    } catch {
        errEl.innerText = "Gagal konek ke server";
        errEl.classList.add("show");
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    }
}

// ── CONNECT & AUTH via WS ────────────────────────────
function connectAndContinue() {
    if (!authToken) return showAuthScreen();

    const statusEl = document.getElementById("status");
    statusEl.innerText = "Connecting...";
    statusEl.className = "";

    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
        // Kirim token untuk verifikasi, bukan nama mentah
        ws.send(JSON.stringify({ type: "auth", token: authToken }));
    };

    ws.onerror = () => {
        statusEl.innerText = "Gagal konek ❌";
        statusEl.className = "off";
        stopAllMusic();
    };

    ws.onclose = () => {
        statusEl.innerText = "Koneksi terputus ❌";
        statusEl.className = "off";
        stopAllMusic();
    };

    ws.onmessage = (e) => {
        const d = JSON.parse(e.data);

        // Handle auth response dulu sebelum switch utama
        if (d.type === "auth_ok") {
            statusEl.innerText = "Connected ✅";
            statusEl.className = "on";
            ws.send(JSON.stringify({ type: "create" }));
            document.getElementById("lobby-p1-name").innerText = authUsername;
            document.getElementById("screen-login").classList.remove("active");
            document.getElementById("screen-lobby").classList.add("active");
            playLobbyMusic();
            return;
        }

        if (d.type === "auth_fail") {
            clearAuth();
            showAuthScreen();
            alert(d.message || "Sesi expired, silakan login ulang.");
            return;
        }

        switch (d.type) {
            // ... semua case yang sudah ada tetap sama persis

            case "room_created":
                document.getElementById("roomDisplay").innerText     = d.code;
                document.getElementById("game-room-code").innerText  = d.code;
                const roomMobile = document.getElementById("game-room-code-m");
                if (roomMobile) roomMobile.innerText = d.code;

                if (myPlayerIndex === 1) {
                    applyFriendUI();
                } else {
                    myPlayerIndex = 0;
                    document.getElementById("startBtn").disabled = true;
                }
                break;

            case "player_joined":
                updateScoreboard(d.names, d.scores);
                updateLobby(d.names);
                break;

            case "game_start":
                if (soloMode) break;
                document.getElementById("screen-lobby").classList.remove("active");
                document.getElementById("screen-game").classList.add("active");
                document.getElementById("overlay-gameover").classList.remove("active");
                document.getElementById("game-room-code").innerText =
                    document.getElementById("roomDisplay").innerText;

                // reset visual semua kartu — jalan di HOST maupun JOINER, tanpa pengecualian
                document.querySelectorAll("#board .card").forEach(card => {
                    card.classList.remove("open-self", "open-opponent", "matched");
                    card.innerText = "";
                });

                updateScoreboard(d.names, d.scores);
                updateTurn(d.turn, d.names);

                totalPairs   = Math.floor((d.rows * d.cols) / 2);
                matchedPairs = 0;
                updateProgress();
                setTimeout(() => renderBoard(d.rows, d.cols), 150);
                playGameMusic();
                break;

            case "timer": {
                if (soloMode) break;
                const t       = d.time;
                const timerEl = document.getElementById("timer");
                timerEl.innerText = `⏱ ${t}s`;
                timerEl.classList.toggle("urgent", t <= 5);
                break;
            }

            case "flip_self": {
                if (soloMode) break;
                const el = document.getElementById("c" + d.index);
                if (el) {
                    el.innerText = d.emoji;
                    el.classList.remove("open-opponent");
                    el.classList.add("open-self");
                }
                break;
            }

            case "flip_opponent": {
                if (soloMode) break;
                const el = document.getElementById("c" + d.index);
                if (el) {
                    el.classList.remove("open-self");
                    el.classList.add("open-opponent");
                }
                break;
            }

            case "update":
                if (soloMode) break;
                updateScoreboard(d.names, d.scores);
                updateTurn(d.turn, d.names);
                if (!d.match) {
                    setTimeout(() => {
                        d.flipped.forEach(idx => {
                            const card = document.getElementById("c" + idx);
                            if (card && !card.classList.contains("matched")) {
                                card.classList.remove("open-self", "open-opponent");
                                card.innerText = "";
                            }
                        });
                    }, 1000);
                } else {
                    d.flipped.forEach(idx => {
                        const card = document.getElementById("c" + idx);
                        if (card) {
                            card.classList.remove("open-self", "open-opponent");
                            card.classList.add("matched");
                        }
                    });
                    matchedPairs++;
                    updateProgress();
                }
                break;

            case "chat_broadcast": {
                const msg = document.createElement("p");
                msg.innerHTML = `<strong>${escapeHtml(d.sender)}:</strong> ${escapeHtml(d.text)}`;
                appendChat(msg);
                break;
            }

            case "error":
                document.getElementById("lobby-status").innerText = "❌ " + d.message;
                alert(d.message);
                break;

            case "game_over":
                if (soloMode) break;
                document.getElementById("timer").innerText = "⏱ -";
                document.getElementById("timer").classList.remove("urgent");
                if (d.disconnected) {
                    showToast(`💔 ${escapeHtml(d.disconnected)} keluar — kamu menang!`);
                }
                playLobbyMusic(); // 🎵 game selesai → switch ke lobby music
                showGameOver(d.winner, d.scores, d.names);
                // Refresh leaderboard setelah game selesai
                setTimeout(() => loadLeaderboard(currentLbMode), 800);
                break;

            case "restart_request":
                showRestartConfirm(d.requester);
                break;

            case "restart_waiting":
                showRestartWaiting(d.message);
                break;

            case "go_lobby":
                handleGoLobby(d.message);
                break;

            case "leaderboard_data":
                renderLeaderboard(d.rows, d.mode);
                break;

            case "room_list":
                renderRoomList(d.rooms);
                break;
        }
    };
}

// ──────────────────────────────────────────────
//  LOBBY HELPERS
// ──────────────────────────────────────────────
function handleGoLobby(message) {
    document.getElementById("overlay-gameover").classList.remove("active");
    hideRestartModal();
    if (message) showToast(message);
    // Kalau sudah di lobby, skip goToLobby tapi tetap toast
    const alreadyInLobby = document.getElementById("screen-lobby").classList.contains("active");
    if (!alreadyInLobby) {
        setTimeout(goToLobby, 1500);
    }
}

function goToLobby() {
    // Beritahu server bahwa player ini keluar dari room,
    // lalu buat room baru untuk dirinya sendiri
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "leave_room" }));
        // Setelah leave, langsung buat room baru sebagai host
        ws.send(JSON.stringify({ type: "create" }));
    }

    document.getElementById("screen-game").classList.remove("active");
    document.getElementById("screen-lobby").classList.add("active");
    document.getElementById("overlay-gameover").classList.remove("active");

    // Reset semua state client
    matchedPairs  = 0;
    totalPairs    = 0;
    myPlayerIndex = 0; // kembali jadi host di room baru
    updateProgress();

    document.getElementById("spts-0").innerText = "0";
    document.getElementById("spts-1").innerText = "0";

    const timerEl = document.getElementById("timer");
    timerEl.innerText = "⏱ 15s";
    timerEl.classList.remove("urgent");

    const slot2  = document.getElementById("slot-p2");
    const badge2 = document.getElementById("badge-p2");
    slot2.classList.remove("filled");
    document.getElementById("lobby-p2-name").innerText = "Menunggu...";
    if (badge2) badge2.style.display = "none";

    document.getElementById("startBtn").disabled = true;
    document.getElementById("lobby-status").innerText = "⏳ Menunggu player lain...";
}

function showRestartConfirm(requesterName) {
    const modal = document.getElementById("overlay-restart-confirm");
    const txt   = document.getElementById("restart-requester-name");
    if (txt)   txt.innerText = requesterName;
    if (modal) modal.classList.add("active");
}

function showRestartWaiting(message) {
    const btn = document.getElementById("btn-main-lagi");
    if (btn) { btn.disabled = true; btn.innerText = "⏳ Menunggu..."; }
    showToast(message);
}

function hideRestartModal() {
    const modal = document.getElementById("overlay-restart-confirm");
    if (modal) modal.classList.remove("active");
}

function answerRestartConfirm(accept) {
    hideRestartModal();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: accept ? "restart_accept" : "restart_decline" }));
}

function applyFriendUI() {
    const startBtn    = document.getElementById("startBtn");
    const diffBtns    = document.querySelectorAll(".diff-btn");
    const lobbyStatus = document.getElementById("lobby-status");

    startBtn.disabled     = true;
    startBtn.innerText    = "▶ Mulai Game";
    startBtn.style.opacity = "0.5";
    startBtn.style.cursor = "not-allowed";
    startBtn.style.filter = "grayscale(1)";

    diffBtns.forEach(btn => {
        btn.style.pointerEvents = "none";
        btn.style.opacity       = "0.5";
        btn.style.filter        = "grayscale(1)";
        btn.style.cursor        = "not-allowed";
    });

    if (lobbyStatus) {
        lobbyStatus.innerText   = "⏳ Menunggu host memulai permainan...";
        lobbyStatus.style.color = "#888";
    }
}

function updateLobby(names) {
    const p1Name    = document.getElementById("lobby-p1-name");
    const p2Name    = document.getElementById("lobby-p2-name");
    const p2Badge   = document.getElementById("badge-p2");
    const slotP1    = document.getElementById("slot-p1");
    const slotP2    = document.getElementById("slot-p2");
    const startBtn  = document.getElementById("startBtn");
    const diffBtns  = document.querySelectorAll(".diff-btn");
    const lobbyStatus = document.getElementById("lobby-status");

    p1Name.innerText = names[0] || "Host";
    p2Name.innerText = names[1] || "Menunggu...";

    if (names[0]) slotP1.classList.add("filled");
    if (names[1]) {
        slotP2.classList.add("filled");
        if (p2Badge) p2Badge.style.display = "inline-block";
    } else {
        slotP2.classList.remove("filled");
        if (p2Badge) p2Badge.style.display = "none";
    }

    if (myPlayerIndex === 1) {
        applyFriendUI();
    } else {
        startBtn.style.filter = "none";
        startBtn.innerText    = "▶ Mulai Game";
        diffBtns.forEach(btn => {
            btn.style.pointerEvents = "auto";
            btn.style.opacity       = "1";
            btn.style.filter        = "none";
            btn.style.cursor        = "pointer";
        });

        if (names.length >= 2) {
            startBtn.disabled     = false;
            startBtn.style.opacity = "1";
            startBtn.style.cursor = "pointer";
            if (lobbyStatus) { lobbyStatus.innerText = "✅ Player siap, bisa mulai!"; lobbyStatus.style.color = "#28a745"; }
        } else {
            startBtn.disabled     = true;
            startBtn.style.opacity = "0.7";
            if (lobbyStatus) { lobbyStatus.innerText = "⏳ Menunggu player lain..."; lobbyStatus.style.color = "#f39c12"; }
        }
    }
}

// ──────────────────────────────────────────────
//  CHAT
// ──────────────────────────────────────────────
function appendChat(elOrHtml) {
    const chatBox  = document.getElementById("chat-box");
    const chatBoxM = document.getElementById("chat-box-m");
    const el = typeof elOrHtml === "string" ? (() => { const p = document.createElement("p"); p.innerHTML = elOrHtml; return p; })() : elOrHtml;
    if (chatBox)  { chatBox.appendChild(el.cloneNode(true));  chatBox.scrollTop  = chatBox.scrollHeight;  }
    if (chatBoxM) { chatBoxM.appendChild(el.cloneNode(true)); chatBoxM.scrollTop = chatBoxM.scrollHeight; }
}

function sendChat() {
    const inputDesktop = document.getElementById("chatInput");
    const inputMobile  = document.getElementById("chatInputM");
    const activeInput  = (inputMobile && inputMobile.value.trim()) ? inputMobile : inputDesktop;
    const text = activeInput.value.trim();
    if (!ws || ws.readyState !== WebSocket.OPEN) return alert("Konek dulu!");
    if (!text) return;
    ws.send(JSON.stringify({ type: "chat", text }));
    if (inputDesktop) inputDesktop.value = "";
    if (inputMobile)  inputMobile.value  = "";
}

// ──────────────────────────────────────────────
//  ROOM & GAME CONTROLS
// ──────────────────────────────────────────────
function joinRoom() {
    const code = document.getElementById("roomInput").value.trim().toUpperCase();
    if (!code) return alert("Masukkan kode room!");
    joinRoomByCode(code);
    if (window.innerWidth < 768) {
        document.querySelector(".game-sidebar")?.classList.remove("open");
        document.getElementById("sidebar-overlay")?.classList.remove("active");
    }
}

function joinRoomByCode(code) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return alert("Belum konek ke server!");
    if (!code) return;
    myPlayerIndex = 1;
    ws.send(JSON.stringify({ type: "join", code }));
    document.getElementById("roomDisplay").innerText    = code;
    document.getElementById("game-room-code").innerText = code;
}

// ──────────────────────────────────────────────
//  DAFTAR ROOM TERBUKA
// ──────────────────────────────────────────────
function requestRoomList() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "list_rooms" }));
    }
}

function renderRoomList(roomsAvailable) {
    const listEl = document.getElementById("room-list");
    if (!listEl) return;

    if (!roomsAvailable || roomsAvailable.length === 0) {
        listEl.innerHTML = `<div class="lb-empty">Belum ada room terbuka, buat sendiri yuk! 🏠</div>`;
        return;
    }

    const diffIcon = { easy: "🟢", medium: "🟡", hard: "🔴" };

    listEl.innerHTML = roomsAvailable.map(r => `
        <div class="lb-row room-row">
            <span class="lb-name">🏠 ${escapeHtml(r.code)} — ${escapeHtml(r.host)}</span>
            <span class="diff-tag">${diffIcon[r.difficulty] || "🟢"}</span>
            <button class="btn btn-sm" onclick="joinRoomByCode('${escapeHtml(r.code)}')">Join</button>
        </div>`).join("");
}

let selectedDifficulty = "easy";
function selectDiff(el, diff) {
    document.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("active"));
    el.classList.add("active");
    selectedDifficulty = diff;
}
function startGame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "start", difficulty: selectedDifficulty }));
}

// ──────────────────────────────────────────────
//  BOARD
// ──────────────────────────────────────────────
let _boardRenderParams    = null;
let _boardResizeObserver  = null;

function renderBoard(rows, cols) {
    const board   = document.getElementById("board");
    const wrapper = document.getElementById("board-wrapper");
    if (!board || !wrapper) return;
    _boardRenderParams = { rows, cols };
    if (_boardResizeObserver) _boardResizeObserver.disconnect();

    function doRender() {
        const wrapW = wrapper.clientWidth;
        const wrapH = wrapper.clientHeight;
        if (wrapW < 10 || wrapH < 10) return;

        const gap      = 6;
        const cardByW  = Math.floor((wrapW - gap * (cols + 1)) / cols);
        const cardByH  = Math.floor((wrapH - gap * (rows + 1)) / rows);
        let cardSize   = Math.min(cardByW, cardByH);
        cardSize       = Math.max(32, Math.min(cardSize, 90));
        const fontSize = Math.floor(cardSize * 0.5);

        board.style.gridTemplateColumns = `repeat(${cols}, ${cardSize}px)`;
        board.style.gap = gap + "px";

        const totalCards = rows * cols;

        // Kalau board udah ada dengan jumlah kartu yang sama, tinggal resize —
        // JANGAN hapus & bikin ulang, biar status matched/flipped gak ke-reset
        // tiap ada resize (misal address bar mobile nyembul/ilang).
        if (board.children.length === totalCards) {
            for (let i = 0; i < totalCards; i++) {
                const div = board.children[i];
                div.style.width      = cardSize + "px";
                div.style.height     = cardSize + "px";
                div.style.fontSize   = fontSize + "px";
                div.style.lineHeight = cardSize + "px";
            }
            return;
        }

        // Belum ada / ganti rows-cols → build dari awal
        board.innerHTML = "";
        for (let i = 0; i < totalCards; i++) {
            const div = document.createElement("div");
            div.className  = "card";
            div.id         = "c" + i;
            div.style.width      = cardSize + "px";
            div.style.height     = cardSize + "px";
            div.style.fontSize   = fontSize + "px";
            div.style.lineHeight = cardSize + "px";
            div.addEventListener("click", () => {
                if (soloMode) {
                    soloHandleFlip(i);
                } else if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "flip", index: i }));
                }
            });
            board.appendChild(div);
        }
    }

    _boardResizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 10 && height > 10) doRender();
        }
    });
    _boardResizeObserver.observe(wrapper);
    doRender();
}

// ──────────────────────────────────────────────
//  SCOREBOARD & TURN & PROGRESS
// ──────────────────────────────────────────────
function updateScoreboard(names, scores) {
    if (!names || !scores) return;
    document.getElementById("sname-0").innerText = names[0]  || "-";
    document.getElementById("sname-1").innerText = names[1]  || "-";
    document.getElementById("spts-0").innerText  = scores[0] ?? 0;
    document.getElementById("spts-1").innerText  = scores[1] ?? 0;
}

function updateTurn(turnIdx, names) {
    if (!names) return;
    document.getElementById("turnIndicator").innerText = `Giliran: ${names[turnIdx] || "?"}`;
    document.getElementById("score-0").classList.toggle("active-turn", turnIdx === 0);
    document.getElementById("score-1").classList.toggle("active-turn", turnIdx === 1);
}

function updateProgress() {
    const pct = totalPairs > 0 ? (matchedPairs / totalPairs) * 100 : 0;
    const bar  = document.getElementById("progressBar");
    const txt  = document.getElementById("progressText");
    const bar2 = document.getElementById("progressBar2");
    const txt2 = document.getElementById("progressText2");
    const label = `${matchedPairs} / ${totalPairs} pasang`;
    if (bar)  bar.style.width  = pct + "%";
    if (bar2) bar2.style.width = pct + "%";
    if (txt)  txt.innerText    = label;
    if (txt2) txt2.innerText   = label;
}

// ──────────────────────────────────────────────
//  GAME OVER
// ──────────────────────────────────────────────
function showGameOver(winner, scores, names) {
    document.getElementById("overlay-gameover").classList.add("active");
    document.getElementById("winner-text").innerText = `🏆 Pemenang: ${winner}`;

    const btn = document.getElementById("btn-main-lagi");
    if (btn) { btn.disabled = false; btn.innerText = "🔄 Main Lagi"; }

    const fs = document.getElementById("final-scores");
    fs.innerHTML = "";
    const n = names || [
        document.getElementById("sname-0").innerText,
        document.getElementById("sname-1").innerText,
    ];
    (scores || []).forEach((s, i) => {
        fs.innerHTML += `
            <div class="gs-card">
                <div class="gs-name">${escapeHtml(n[i] || "P" + (i + 1))}</div>
                <div class="gs-pts">${s}</div>
            </div>`;
    });
}

function requestRestart() {
    if (soloMode) return restartSoloGame();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "restart" }));
}

function exitGame() {
    stopAllMusic();
    if (soloMode) return exitSolo();
    if (ws) { ws.onclose = null; ws.close(); }
    location.reload();
}

function logoutGame() {
    stopAllMusic();
    if (ws) { ws.onclose = null; ws.close(); }
    clearAuth();
    location.reload();
}

function showAuthScreen() {
    document.getElementById("screen-login").classList.add("active");
    document.getElementById("screen-lobby").classList.remove("active");
    document.getElementById("screen-game").classList.remove("active");
}

// ──────────────────────────────────────────────
//  SOLO / VS KOMPUTER
// ──────────────────────────────────────────────
const SOLO_NAMES = ["Kamu", "Komputer 🤖"];

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function generateSoloDeck(rows, cols) {
    const total = rows * cols;
    const pairs = Math.floor(total / 2);
    const deck  = [];
    for (let i = 0; i < pairs; i++) {
        const emoji = EMOJI_LIST[i % EMOJI_LIST.length];
        deck.push(emoji, emoji);
    }
    if (deck.length < total) deck.push("❓");
    return shuffleArray(deck);
}

function startSoloGame(difficulty) {
    const cfgMap = { easy: [3, 4], medium: [4, 5], hard: [5, 6] };
    const cfg    = cfgMap[difficulty] || cfgMap.easy;

    soloMode = true;
    document.body.classList.add("solo-mode");

    solo = {
        rows: cfg[0], cols: cfg[1],
        deck: generateSoloDeck(cfg[0], cfg[1]),
        flipped: [], matched: [],
        scores: [0, 0], turn: 0, timeLeft: 15,
        timerId: null, memory: {}, difficulty, busy: false,
    };

    totalPairs   = Math.floor((cfg[0] * cfg[1]) / 2);
    matchedPairs = 0;
    updateProgress();

    document.getElementById("screen-lobby").classList.remove("active");
    document.getElementById("screen-game").classList.add("active");
    document.getElementById("overlay-gameover").classList.remove("active");
    document.getElementById("game-room-code").innerText = "SOLO";
    const roomMobile = document.getElementById("game-room-code-m");
    if (roomMobile) roomMobile.innerText = "🤖 Solo";

    const avatar0 = document.querySelector("#score-0 .score-avatar");
    const avatar1 = document.querySelector("#score-1 .score-avatar");
    if (avatar0) avatar0.innerText = "👤";
    if (avatar1) avatar1.innerText = "🤖";

    updateScoreboard(SOLO_NAMES, solo.scores);
    updateTurn(solo.turn, SOLO_NAMES);
    setTimeout(() => renderBoard(cfg[0], cfg[1]), 150);
    playGameMusic();
    soloStartTimer();
    showToast("🤖 Mode latihan vs Komputer — skor tidak masuk leaderboard");
}

function soloRevealCard(idx, emoji) {
    const el = document.getElementById("c" + idx);
    if (el) {
        el.innerText = emoji;
        el.classList.remove("open-opponent");
        el.classList.add("open-self");
    }
}

function soloHideCard(idx) {
    const el = document.getElementById("c" + idx);
    if (el && !el.classList.contains("matched")) {
        el.classList.remove("open-self", "open-opponent");
        el.innerText = "";
    }
}

function soloHandleFlip(idx) {
    if (!solo || solo.busy) return;
    if (solo.turn !== 0) return; // cuma boleh giliran manusia
    if (solo.matched.includes(idx) || solo.flipped.includes(idx)) return;
    if (solo.flipped.length >= 2) return;

    soloRevealCard(idx, solo.deck[idx]);
    solo.memory[idx] = solo.deck[idx];
    solo.flipped.push(idx);

    if (solo.flipped.length === 2) {
        solo.busy = true;
        soloStopTimer();
        setTimeout(soloResolveFlip, 800);
    }
}

function soloResolveFlip() {
    if (!solo) return;
    const [a, b] = solo.flipped;
    const isMatch = solo.deck[a] === solo.deck[b];

    if (isMatch) {
        solo.scores[solo.turn] += 10;
        solo.matched.push(a, b);
        [a, b].forEach(idx => {
            const el = document.getElementById("c" + idx);
            if (el) el.classList.add("matched");
        });
        matchedPairs++;
        updateProgress();
    } else {
        [a, b].forEach(soloHideCard);
        solo.turn = solo.turn === 0 ? 1 : 0;
    }

    solo.flipped = [];
    solo.busy    = false;
    updateScoreboard(SOLO_NAMES, solo.scores);
    updateTurn(solo.turn, SOLO_NAMES);

    if (solo.matched.length >= solo.deck.length) {
        soloEndGame();
        return;
    }

    if (solo.turn === 1) {
        soloBotTurn();
    } else {
        soloStartTimer();
    }
}

function soloPickRandomTwo() {
    const available = [];
    for (let i = 0; i < solo.deck.length; i++) {
        if (!solo.matched.includes(i)) available.push(i);
    }
    shuffleArray(available);
    return available.slice(0, 2);
}

function soloFindKnownPair() {
    const seen = {};
    for (const key in solo.memory) {
        const idx = parseInt(key, 10);
        if (solo.matched.includes(idx)) continue;
        const emoji = solo.memory[idx];
        if (seen[emoji] !== undefined) return [seen[emoji], idx];
        seen[emoji] = idx;
    }
    return null;
}

function soloBotTurn() {
    if (!solo) return;
    solo.busy = true;
    soloStopTimer();
    const timerEl = document.getElementById("timer");
    if (timerEl) { timerEl.innerText = "⏱ 🤖 mikir..."; timerEl.classList.remove("urgent"); }

    const thinkTime = solo.difficulty === "hard" ? 650 : solo.difficulty === "medium" ? 950 : 1300;

    setTimeout(() => {
        if (!solo) return;
        const smartChance = solo.difficulty === "hard" ? 0.92 : solo.difficulty === "medium" ? 0.6 : 0.3;
        let pair = (Math.random() < smartChance) ? soloFindKnownPair() : null;
        if (!pair) pair = soloPickRandomTwo();
        soloBotFlipStep(pair, 0);
    }, thinkTime);
}

function soloBotFlipStep(pair, step) {
    if (!solo) return;
    if (step >= 2) {
        solo.flipped = pair;
        setTimeout(soloResolveFlip, 700);
        return;
    }
    const idx = pair[step];
    soloRevealCard(idx, solo.deck[idx]);
    solo.memory[idx] = solo.deck[idx];
    setTimeout(() => soloBotFlipStep(pair, step + 1), 550);
}

function soloUpdateTimerDisplay() {
    const t = document.getElementById("timer");
    if (!t || !solo) return;
    t.innerText = `⏱ ${solo.timeLeft}s`;
    t.classList.toggle("urgent", solo.timeLeft <= 5);
}

function soloStartTimer() {
    soloStopTimer();
    if (!solo) return;
    solo.timeLeft = 15;
    soloUpdateTimerDisplay();
    solo.timerId = setInterval(() => {
        if (!solo) return;
        solo.timeLeft--;
        soloUpdateTimerDisplay();
        if (solo.timeLeft <= 0) {
            soloStopTimer();
            solo.scores[solo.turn] = Math.max(0, solo.scores[solo.turn] - 5);
            solo.flipped.forEach(soloHideCard);
            solo.flipped = [];
            solo.turn = solo.turn === 0 ? 1 : 0;
            updateScoreboard(SOLO_NAMES, solo.scores);
            updateTurn(solo.turn, SOLO_NAMES);
            if (solo.turn === 1) soloBotTurn(); else soloStartTimer();
        }
    }, 1000);
}

function soloStopTimer() {
    if (solo && solo.timerId) clearInterval(solo.timerId);
    if (solo) solo.timerId = null;
}

function soloEndGame() {
    soloStopTimer();
    const timerEl = document.getElementById("timer");
    if (timerEl) { timerEl.innerText = "⏱ -"; timerEl.classList.remove("urgent"); }
    playLobbyMusic();

    const s0 = solo.scores[0], s1 = solo.scores[1];
    const winner = s0 === s1 ? "Seri!" : (s0 > s1 ? "Kamu 🎉" : "Komputer 🤖");
    showGameOver(winner, solo.scores, SOLO_NAMES);
}

function restartSoloGame() {
    const diff = solo ? solo.difficulty : "easy";
    document.getElementById("overlay-gameover").classList.remove("active");
    startSoloGame(diff);
}

function exitSolo() {
    soloStopTimer();
    soloMode = false;
    solo     = null;
    document.body.classList.remove("solo-mode");

    document.getElementById("overlay-gameover").classList.remove("active");
    document.getElementById("screen-game").classList.remove("active");
    document.getElementById("screen-lobby").classList.add("active");

    matchedPairs = 0;
    totalPairs   = 0;
    updateProgress();

    const avatar0 = document.querySelector("#score-0 .score-avatar");
    const avatar1 = document.querySelector("#score-1 .score-avatar");
    if (avatar0) avatar0.innerText = "👑";
    if (avatar1) avatar1.innerText = "🎮";

    playLobbyMusic();
    requestRoomList();
}

// ──────────────────────────────────────────────
//  LEADERBOARD
// ──────────────────────────────────────────────
let currentLbMode = "wins";

async function loadLeaderboard(mode = "wins", target = "game") {
    currentLbMode = mode;

    // target "game" = panel di game screen, "lobby" = panel di lobby
    const listEl = document.getElementById(
        target === "lobby" ? "lobby-lb-list" : "lb-list"
    );
    if (!listEl) return;

    listEl.innerHTML = `<div class="lb-empty">Memuat...</div>`;

    try {
        const res  = await fetch(`/api/leaderboard?mode=${mode}&limit=10`);
        const rows = await res.json();
        renderLeaderboard(rows, mode, target);
    } catch {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "get_leaderboard", mode, limit: 10 }));
        } else {
            listEl.innerHTML = `<div class="lb-empty">Belum tersambung</div>`;
        }
    }
}

function renderLeaderboard(rows, mode, target = "game") {
    const listEl = document.getElementById(
        target === "lobby" ? "lobby-lb-list" : "lb-list"
    );
    if (!listEl) return;

    // Update tab aktif sesuai container
    const tabContainer = target === "lobby"
        ? document.getElementById("lobby-lb-tabs")
        : document.querySelector(".game-right");
    if (tabContainer) {
        tabContainer.querySelectorAll(".lb-tab").forEach(t => {
            t.classList.toggle("active", t.dataset.mode === mode);
        });
    }

    if (!rows || rows.length === 0) {
        listEl.innerHTML = `<div class="lb-empty">Belum ada data</div>`;
        return;
    }

    const valueKey = mode === "wins" ? "total_wins" : mode === "score" ? "total_score" : "best_score";
    const suffix   = mode === "score" ? "pts" : mode === "best" ? "pts" : "W";

    listEl.innerHTML = rows.map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
        return `
        <div class="lb-row">
            <span class="lb-rank">${medal}</span>
            <span class="lb-name">${escapeHtml(r.username)}</span>
            <span class="lb-value">${r[valueKey]}${suffix}</span>
        </div>`;
    }).join("");
}

// Tab switcher khusus lobby
function switchLobbyLb(el, mode) {
    loadLeaderboard(mode, "lobby");
}

// ──────────────────────────────────────────────
//  TOAST
// ──────────────────────────────────────────────
function showToast(message) {
    let toast = document.getElementById("toast-notification");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "toast-notification";
        toast.style.cssText = `
            position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            background:rgba(0,0,0,0.82);color:white;padding:12px 22px;
            border-radius:20px;font-family:'Nunito',sans-serif;font-size:14px;
            font-weight:700;z-index:9999;text-align:center;max-width:80vw;
            box-shadow:0 4px 20px rgba(0,0,0,0.3);transition:opacity 0.4s;`;
        document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.style.opacity = "1";
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
}

function switchAuthTab(tab) {
    document.getElementById("form-login").style.display    = tab === "login"    ? "flex" : "none";
    document.getElementById("form-register").style.display = tab === "register" ? "flex" : "none";
    document.getElementById("tab-login").classList.toggle("active",    tab === "login");
    document.getElementById("tab-register").classList.toggle("active", tab === "register");
    // Geser slider
    const slider = document.getElementById("auth-tab-slider");
    if (slider) slider.classList.toggle("right", tab === "register");
    // Reset error
    const errEl = document.getElementById("auth-error");
    errEl.innerText = "";
    errEl.classList.remove("show");
}

function showAuthSuccess(message) {
    const errEl = document.getElementById("auth-error");
    errEl.innerText = message;
    errEl.classList.add("show", "success");
}

// ──────────────────────────────────────────────
//  SIDEBAR & CHAT OVERLAY
// ──────────────────────────────────────────────
function toggleSidebar() {
    const sidebar = document.querySelector(".game-sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (sidebar && overlay) {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("active");
    }
}

function openChatOverlay() {
    document.getElementById("chat-overlay").classList.add("open");
    document.getElementById("sidebar-overlay").classList.add("active");
}

function closeChatOverlay() {
    document.getElementById("chat-overlay").classList.remove("open");
    if (!document.querySelector(".game-sidebar.open")) {
        document.getElementById("sidebar-overlay").classList.remove("active");
    }
}

// ──────────────────────────────────────────────
//  UTILITIES
// ──────────────────────────────────────────────
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────────
//  DOM READY
// ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    // Auto-connect kalau sudah punya token tersimpan
    if (authToken && authUsername) {
        connectAndContinue();
    }

    // Sidebar overlay click
    document.getElementById("sidebar-overlay").addEventListener("click", () => {
        const sidebarOpen = document.querySelector(".game-sidebar.open");
        const chatOpen    = document.getElementById("chat-overlay").classList.contains("open");
        if (chatOpen)    closeChatOverlay();
        if (sidebarOpen) toggleSidebar();
    });

    // Leaderboard tabs
    document.querySelectorAll(".lb-tab").forEach(tab => {
        tab.addEventListener("click", () => loadLeaderboard(tab.dataset.mode));
    });

    // Load leaderboard saat game screen aktif
    const screenGame = document.getElementById("screen-game");
    new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.target.classList.contains("active")) loadLeaderboard(currentLbMode, "game");
        }
    }).observe(screenGame, { attributes: true, attributeFilter: ["class"] });

    // Load leaderboard & daftar room saat lobby screen aktif
    const screenLobby = document.getElementById("screen-lobby");
    new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.target.classList.contains("active")) {
                loadLeaderboard(currentLbMode, "lobby");
                requestRoomList();
            }
        }
    }).observe(screenLobby, { attributes: true, attributeFilter: ["class"] });
});

function togglePw(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.innerText = isHidden ? "🙈" : "👁";
}