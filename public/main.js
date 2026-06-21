/**
 * Tetris Hands — menu first, single + multiplayer, MediaPipe CV in-browser.
 *
 * FIXES + FEATURES:
 * - CV: requestAnimationFrame loop only (no camera_utils). Robust auto-retry start.
 * - CV: Hands instance persists across menu/restart (only closed if stopStreamTracks === true).
 * - Movement: position zones w/ hysteresis. Toggle inversion in ONE place only.
 * - Rotate: wrist twist (palm roll) using landmarks 0,5,17. CW/CCW by twist direction.
 * - Wave down: dy threshold in short window triggers soft drop burst.
 * - Debug/Logs: shows if onResults is firing + how many hands.
 */
(function () {
  "use strict";
  console.log("main.js loaded ✅");

  // ===================== GAME CONSTANTS =====================
  var BOARD_W = 10, BOARD_H = 20, BLOCK_PX = 28;
  var SCORE_TABLE = { 1: 100, 2: 300, 3: 500, 4: 800 };
  var LINES_PER_LEVEL = 10, GRAVITY_BASE_MS = 1000, GRAVITY_MIN_MS = 80;
  var GARBAGE_BLOCK_ID = 7;

  // ===================== CV / GESTURE TUNING =====================
  function mergeGestureConfig(base, override) {
    var result = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        result[key] = base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
          ? mergeGestureConfig(base[key], {})
          : base[key];
      }
    }
    for (key in override) {
      if (Object.prototype.hasOwnProperty.call(override, key)) {
        if (override[key] && typeof override[key] === "object" && !Array.isArray(override[key])) {
          result[key] = mergeGestureConfig(result[key] || {}, override[key]);
        } else {
          result[key] = override[key];
        }
      }
    }
    return result;
  }

  var GESTURE_CONFIG = mergeGestureConfig(
    window.TETRIS_HANDS_GESTURES || {},
    window.TETRIS_HANDS_GESTURE_TRAINING || {}
  );
  var MOVEMENT_CONFIG = GESTURE_CONFIG.movement || {};
  var ROTATION_CONFIG = GESTURE_CONFIG.rotation || {};
  var SOFTDROP_CONFIG = GESTURE_CONFIG.softDrop || {};
  var OPTIONAL_CONFIG = GESTURE_CONFIG.optional || {};
  var CAMERA_CONFIG = GESTURE_CONFIG.camera || {};

  function configNumber(section, key, fallback) {
    var value = section && section[key];
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function configBool(section, key, fallback) {
    var value = section && section[key];
    return typeof value === "boolean" ? value : fallback;
  }

  var EMA_ALPHA = configNumber(MOVEMENT_CONFIG, "emaAlpha", 0.28);

  /**
   * IMPORTANT:
   * - false => Hand LEFT moves piece LEFT, Hand RIGHT moves piece RIGHT (normal)
   * - true  => INVERTED mapping (Hand LEFT moves piece RIGHT, Hand RIGHT moves piece LEFT)
   *
   * You asked to invert the controls, so this is TRUE.
   */
  var INVERT_LEFT_RIGHT = configBool(MOVEMENT_CONFIG, "invertLeftRight", true);

  // Position-based move with hysteresis (normalized x in [0..1])
  var LEFT_ENTER = configNumber(MOVEMENT_CONFIG, "leftEnter", 0.45);
  var LEFT_EXIT = configNumber(MOVEMENT_CONFIG, "leftExit", 0.52);
  var RIGHT_ENTER = configNumber(MOVEMENT_CONFIG, "rightEnter", 0.55);
  var RIGHT_EXIT = configNumber(MOVEMENT_CONFIG, "rightExit", 0.48);
  var MOVE_REPEAT_MS = configNumber(MOVEMENT_CONFIG, "repeatMs", 160);

  // Wave down -> soft drop boost
  var DROP_DY_THRESHOLD = configNumber(SOFTDROP_CONFIG, "waveDownThreshold", 0.10);
  var DROP_TIME_MS = configNumber(SOFTDROP_CONFIG, "waveWindowMs", 180);
  var SOFTDROP_REPEAT_MS = configNumber(SOFTDROP_CONFIG, "repeatMs", 80);
  var SOFTDROP_HOLD_MS = configNumber(SOFTDROP_CONFIG, "holdMs", 650);
  var REQUIRE_OPEN_PALM_SOFTDROP = configBool(SOFTDROP_CONFIG, "requireOpenPalm", true);

  // Rotation
  var ROTATION_GESTURE = ROTATION_CONFIG.gesture || "pinch";
  var PINCH_ENTER_RATIO = configNumber(ROTATION_CONFIG, "pinchEnterRatio", 0.34);
  var PINCH_EXIT_RATIO = configNumber(ROTATION_CONFIG, "pinchExitRatio", 0.48);
  var TWIST_TRIGGER_DEG = configNumber(ROTATION_CONFIG, "triggerDeg", 25);
  var TWIST_RELEASE_DEG = configNumber(ROTATION_CONFIG, "releaseDeg", 12);
  var ROTATE_DEBOUNCE_MS = configNumber(ROTATION_CONFIG, "debounceMs", 280);
  var ROTATE_CW_DIRECTION = configNumber(ROTATION_CONFIG, "cwDirection", 1);
  var CLASSIFIER_CONFIDENCE = configNumber(ROTATION_CONFIG, "classifierConfidence", 0.78);

  // Optional gestures
  var OPEN_PALM_TIP_MCP_MIN = configNumber(OPTIONAL_CONFIG, "openPalmTipMcpMin", 0.12);
  var V_SIGN_HOLD_MS = configNumber(OPTIONAL_CONFIG, "vSignHoldMs", 400);
  var PAUSE_DEBOUNCE_MS = configNumber(OPTIONAL_CONFIG, "pauseDebounceMs", 800);
  var CLAP_DISTANCE_RATIO = configNumber(OPTIONAL_CONFIG, "clapDistanceRatio", 2.35);
  var CLAP_REARM_DISTANCE_RATIO = configNumber(OPTIONAL_CONFIG, "clapRearmDistanceRatio", 3.4);
  var CLAP_MIN_CLOSING_RATIO = configNumber(OPTIONAL_CONFIG, "clapMinClosingRatio", 0.75);
  var CLAP_MAX_VERTICAL_RATIO = configNumber(OPTIONAL_CONFIG, "clapMaxVerticalRatio", 1.35);
  var CLAP_WINDOW_MS = configNumber(OPTIONAL_CONFIG, "clapWindowMs", 260);
  var CLAP_COOLDOWN_MS = configNumber(OPTIONAL_CONFIG, "clapCooldownMs", 1400);
  var CV_FRAME_MS = configNumber(CAMERA_CONFIG, "frameMs", 33);

  // ===================== PIECES =====================
  var PIECES = {
    I: { id: 1, color: 0x00ffff, cells: [[0,1],[1,1],[2,1],[3,1]] },
    O: { id: 2, color: 0xffff00, cells: [[0,0],[1,0],[0,1],[1,1]] },
    T: { id: 3, color: 0xaa00ff, cells: [[1,0],[0,1],[1,1],[2,1]] },
    S: { id: 4, color: 0x00ff00, cells: [[1,0],[2,0],[0,1],[1,1]] },
    Z: { id: 5, color: 0xff0000, cells: [[0,0],[1,0],[1,1],[2,1]] },
    J: { id: 6, color: 0x0000ff, cells: [[0,0],[0,1],[1,1],[2,1]] },
    L: { id: 7, color: 0xff8800, cells: [[2,0],[0,1],[1,1],[2,1]] }
  };
  var PIECE_NAMES = ["I","O","T","S","Z","J","L"];

  function createEmptyBoard() {
    return Array.from({ length: BOARD_H }, function () { return Array(BOARD_W).fill(0); });
  }

  function makeBag() {
    var arr = PIECE_NAMES.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function getPiece(name) { return PIECES[name] || PIECES.I; }

  // ===================== ROTATION =====================
  function rotateCells(cells, cw) {
    var rot = cw
      ? function(c){ return [c[1], -c[0]]; }
      : function(c){ return [-c[1], c[0]]; };

    var out = cells.map(function(c){ return rot(c); });
    var minX = Math.min.apply(null, out.map(function(c){return c[0];}));
    var minY = Math.min.apply(null, out.map(function(c){return c[1];}));
    return out.map(function(c){ return [c[0]-minX, c[1]-minY]; });
  }

  function collides(board, piece, px, py) {
    for (var i = 0; i < piece.cells.length; i++) {
      var x = piece.cells[i][0], y = piece.cells[i][1];
      var nx = px + x, ny = py + y;
      if (nx < 0 || nx >= BOARD_W || ny >= BOARD_H) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
    return false;
  }

  function merge(board, piece, px, py, id) {
    var b = board.map(function(r){ return r.slice(); });
    for (var i = 0; i < piece.cells.length; i++) {
      var y = py + piece.cells[i][1];
      if (y >= 0 && y < BOARD_H) b[y][px + piece.cells[i][0]] = id;
    }
    return b;
  }

  function clearLines(board) {
    var cleared = 0, b = board;
    for (var row = BOARD_H - 1; row >= 0; row--) {
      if (b[row].every(function(v){ return v > 0; })) {
        cleared++;
        b = b.slice(0, row).concat(b.slice(row + 1));
        b.unshift(Array(BOARD_W).fill(0));
        row++;
      }
    }
    return { board: b, cleared: cleared };
  }

  function spawnX(name) {
    var piece = getPiece(name);
    var w = Math.max.apply(null, piece.cells.map(function(c){ return c[0]; })) + 1;
    return Math.floor((BOARD_W - w) / 2);
  }

  // ===================== GAME STATE =====================
  var board = createEmptyBoard(), current = null, currentPx = 0, currentPy = 0, currentRot = 0;
  var bag = [], nextPieceName = null, score = 0, lines = 0, level = 1, gameOver = false, paused = false;
  var gravityAcc = 0, lastGravityMs = GRAVITY_BASE_MS;
  var opponentState = null;
  var hasReportedLoss = false, hasRequestedRematch = false, pendingRematchIncoming = false;

  /** menu | ready | playing | paused | gameover */
  var gamePhase = "menu";

  function gravityMs() { return Math.max(GRAVITY_MIN_MS, GRAVITY_BASE_MS - (level - 1) * 80); }
  function refillBag() { if (bag.length === 0) bag = makeBag(); }

  function spawn() {
    refillBag();
    var name = nextPieceName || bag.shift();
    nextPieceName = bag.shift();
    var piece = getPiece(name);
    var px = spawnX(name), py = 0;
    if (collides(board, piece, px, py)) { reportLoss("topout"); return; }
    current = { name: name, cells: piece.cells.map(function(c){ return c.slice(); }) };
    currentPx = px; currentPy = py; currentRot = 0;
  }

  function lock() {
    if (!current) return;
    var id = getPiece(current.name).id;
    board = merge(board, current, currentPx, currentPy, id);
    var result = clearLines(board);
    board = result.board;
    if (result.cleared > 0) {
      score += (SCORE_TABLE[result.cleared] || 800) * level;
      lines += result.cleared;
      level = Math.floor(lines / LINES_PER_LEVEL) + 1;
      lastGravityMs = gravityMs();
      sendGarbageForClear(result.cleared);
    }
    current = null;
    spawn();
  }

  function moveLeft() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    if (!collides(board, current, currentPx - 1, currentPy)) currentPx--;
  }

  function moveRight() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    if (!collides(board, current, currentPx + 1, currentPy)) currentPx++;
  }

  function rotateCW() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    if (current.name === "O") return;
    var nextCells = rotateCells(current.cells, true);
    var kicks = [0, -1, 1, -2, 2];
    for (var k = 0; k < kicks.length; k++) {
      if (!collides(board, { cells: nextCells }, currentPx + kicks[k], currentPy)) {
        current.cells = nextCells; currentPx += kicks[k]; currentRot = (currentRot + 1) % 4;
        return;
      }
    }
  }

  function rotateCCW() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    if (current.name === "O") return;
    var nextCells = rotateCells(current.cells, false);
    var kicks = [0, -1, 1, -2, 2];
    for (var k = 0; k < kicks.length; k++) {
      if (!collides(board, { cells: nextCells }, currentPx + kicks[k], currentPy)) {
        current.cells = nextCells; currentPx += kicks[k]; currentRot = (currentRot + 3) % 4;
        return;
      }
    }
  }

  function softDrop() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    if (!collides(board, current, currentPx, currentPy + 1)) { currentPy++; score += 1; return; }
    lock();
  }

  function hardDrop() {
    if (gamePhase !== "playing" || gameOver || paused || !current) return;
    while (!collides(board, current, currentPx, currentPy + 1)) { currentPy++; score += 2; }
    lock();
  }

  function togglePause() {
    if (gameOver) return;
    paused = !paused;
    gamePhase = paused ? "paused" : "playing";
    showPause(paused);
    setPauseLabel();
  }

  function applyCvAction(action) {
    var normalized = String(action || "").trim().toUpperCase();
    if (!normalized) return;

    switch (normalized) {
      case "LEFT":
      case "MOVE_LEFT":
        moveLeft();
        break;
      case "RIGHT":
      case "MOVE_RIGHT":
        moveRight();
        break;
      case "ROTATE":
      case "ROTATE_CW":
      case "CW":
        rotateCW();
        break;
      case "ROTATE_CCW":
      case "CCW":
        rotateCCW();
        break;
      case "DOWN":
      case "SOFT_DROP":
        softDrop();
        break;
      case "DROP":
      case "HARD_DROP":
        hardDrop();
        break;
      case "PAUSE":
        togglePause();
        break;
    }
  }

  function attackLinesForClear(cleared) {
    if (cleared === 2) return 1;
    if (cleared === 3) return 2;
    if (cleared >= 4) return 4;
    return 0;
  }

  function sendGarbageForClear(cleared) {
    var attackLines = attackLinesForClear(cleared);
    if (!attackLines || screen !== "multi_game" || !roomCode) return;
    socket.emit("send-garbage", { lines: attackLines });
    showCvStatus("Sent " + attackLines + " garbage " + (attackLines === 1 ? "line" : "lines"));
  }

  function makeGarbageRow() {
    var row = Array(BOARD_W).fill(GARBAGE_BLOCK_ID);
    row[Math.floor(Math.random() * BOARD_W)] = 0;
    return row;
  }

  function applyGarbage(linesToAdd) {
    if (screen !== "multi_game" || gamePhase !== "playing" || gameOver) return;

    var count = Math.max(0, Math.min(4, Math.floor(Number(linesToAdd) || 0)));
    if (!count) return;

    var pushedOutRows = board.slice(0, count);
    var overflow = pushedOutRows.some(function(row) {
      return row.some(function(cell) { return cell > 0; });
    });

    board = board.slice(count);
    for (var i = 0; i < count; i++) board.push(makeGarbageRow());

    showCvStatus("Incoming " + count + " garbage " + (count === 1 ? "line" : "lines"));

    if (overflow || (current && collides(board, current, currentPx, currentPy))) {
      reportLoss("garbage");
    }
  }

  function reportLoss(reason) {
    if (hasReportedLoss) return;

    gameOver = true;
    gamePhase = "gameover";
    paused = false;
    showPause(false);
    setPauseLabel();

    if (screen === "multi_game") {
      hasReportedLoss = true;
      if (roomCode) socket.emit("player-lost", { reason: reason || "topout" });
      showMatchResult("DEFEAT", "Your board topped out. Request a rematch or exit to the menu.", true);
      return;
    }

    showGameOver(true);
  }

  function showMatchResult(title, message, canRematch) {
    var overlay = document.getElementById("matchResultOverlay");
    var titleEl = document.getElementById("matchResultTitle");
    var messageEl = document.getElementById("matchResultMessage");
    var rematchBtn = document.getElementById("btnRematch");
    if (titleEl) titleEl.textContent = title || "MATCH COMPLETE";
    if (messageEl) messageEl.textContent = message || "";
    if (rematchBtn) {
      rematchBtn.disabled = false;
      rematchBtn.textContent = pendingRematchIncoming ? "ACCEPT REMATCH" : "REMATCH";
      if (canRematch && roomCode) rematchBtn.classList.remove("hidden");
      else rematchBtn.classList.add("hidden");
    }
    if (overlay) overlay.classList.remove("hidden");
  }

  function hideMatchResult() {
    var overlay = document.getElementById("matchResultOverlay");
    if (overlay) overlay.classList.add("hidden");
    hasRequestedRematch = false;
    pendingRematchIncoming = false;
  }

  function showWinState() {
    if (gameOver && gamePhase === "gameover") return;
    gameOver = true;
    gamePhase = "gameover";
    paused = false;
    showPause(false);
    setPauseLabel();
    showMatchResult("VICTORY", "Opponent topped out. Request a rematch or exit to the menu.", true);
  }

  function requestRematch() {
    var rematchBtn = document.getElementById("btnRematch");
    var messageEl = document.getElementById("matchResultMessage");
    if (!roomCode) return;

    if (pendingRematchIncoming) {
      socket.emit("rematch-accepted");
      return;
    }

    hasRequestedRematch = true;
    socket.emit("rematch-request");
    if (rematchBtn) {
      rematchBtn.disabled = true;
      rematchBtn.textContent = "WAITING...";
    }
    if (messageEl) messageEl.textContent = "Rematch requested. Waiting for opponent...";
  }

  function resetGame() {
    board = createEmptyBoard();
    current = null; bag = []; nextPieceName = null;
    score = 0; lines = 0; level = 1; gameOver = false; paused = false;
    gravityAcc = 0; lastGravityMs = GRAVITY_BASE_MS;
    hasReportedLoss = false;
    hideMatchResult();
  }

  function showPause(show) {
    var el = document.getElementById("pauseOverlay");
    if (el) { if (show) el.classList.remove("hidden"); else el.classList.add("hidden"); }
  }

  function showGameOver(show) {
    var el = document.getElementById("gameOverOverlay");
    if (el) { if (show) el.classList.remove("hidden"); else el.classList.add("hidden"); }
  }

  function showCvStatus(message) {
    var id = screen === "multi_game" ? "cvStatusMulti" : "cvStatusSingle";
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || "";
    if (message) {
      el.classList.remove("hidden");
      window.clearTimeout(showCvStatus._timer);
      showCvStatus._timer = window.setTimeout(function() {
        el.classList.add("hidden");
      }, 1600);
    } else {
      el.classList.add("hidden");
    }
  }

  function setPauseLabel() {
    var btn = document.getElementById("btnPause") || document.getElementById("btnPauseMulti");
    if (btn) btn.textContent = paused ? "RESUME" : "PAUSE";
  }

  function updateHud() {
    var a = document.getElementById("scoreEl"), b = document.getElementById("linesEl"), c = document.getElementById("levelEl");
    if (a) a.textContent = score; if (b) b.textContent = lines; if (c) c.textContent = level;

    var s1 = document.getElementById("mpScore1"), s2 = document.getElementById("mpLines1");
    if (s1) s1.textContent = score; if (s2) s2.textContent = lines;

    var o1 = document.getElementById("mpScore2"), o2 = document.getElementById("mpLines2");
    if (o1 && opponentState) o1.textContent = opponentState.score || 0;
    if (o2 && opponentState) o2.textContent = opponentState.lines || 0;
  }

  function drawNextPiece() {
    var canvas = document.getElementById("nextCanvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!nextPieceName) return;
    var piece = getPiece(nextPieceName);
    var cells = piece.cells;

    var minX = Math.min.apply(null, cells.map(function(c){return c[0];}));
    var minY = Math.min.apply(null, cells.map(function(c){return c[1];}));
    var maxX = Math.max.apply(null, cells.map(function(c){return c[0];}));
    var maxY = Math.max.apply(null, cells.map(function(c){return c[1];}));
    var cw = maxX - minX + 1, ch = maxY - minY + 1;

    var block = Math.min(80 / (cw + 1), 80 / (ch + 1), 18);
    var offX = (80 - cw * block) / 2, offY = (80 - ch * block) / 2;

    var hex = piece.color, r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, bb = hex & 0xff;
    ctx.fillStyle = "rgb(" + r + "," + g + "," + bb + ")";
    cells.forEach(function(cell) {
      ctx.fillRect(offX + (cell[0] - minX) * block, offY + (cell[1] - minY) * block, block - 1, block - 1);
    });
  }

  function tickUi() {
    updateHud();
    drawNextPiece();
    showGameOver(gameOver && screen !== "multi_game");
  }

  function goToReadyState() {
    resetGame();
    gamePhase = "ready";
    showGameOver(false);
    showPause(false);
    setPauseLabel();
    var startOl = document.getElementById("startOverlaySingle");
    if (startOl) startOl.classList.remove("hidden");
    tickUi();
  }

  function startGame() {
    if (gamePhase === "gameover") return;
    gamePhase = "playing";
    spawn();
    var startOl = document.getElementById("startOverlaySingle");
    if (startOl) startOl.classList.add("hidden");
    var multiOl = document.getElementById("multiReadyOverlay");
    if (multiOl) multiOl.classList.add("hidden");
    var btnStartMulti = document.getElementById("btnStartMultiGame");
    if (btnStartMulti) btnStartMulti.classList.add("hidden");
    tickUi();
  }

  function goToReadyStateMulti() {
    resetGame();
    gamePhase = "ready";
    showGameOver(false);
    showPause(false);
    setPauseLabel();
    var multiOl = document.getElementById("multiReadyOverlay");
    if (multiOl) { multiOl.classList.remove("hidden"); }
    var label = document.getElementById("multiReadyLabel");
    if (label) label.textContent = isHost ? "Clap or click START to begin" : "Waiting for host to start";
    var btnStartMulti = document.getElementById("btnStartMultiGame");
    if (btnStartMulti) {
      if (isHost) btnStartMulti.classList.remove("hidden");
      else btnStartMulti.classList.add("hidden");
    }
    tickUi();
  }

  // ===================== SCREEN / MULTI =====================
  var screen = "menu"; // menu | single | multi_lobby | multi_game
  var socket = io();
  var roomCode = null, isHost = false, playerCount = 0;
  var stateBroadcastInterval = null;

  function startReadyGameFromInput() {
    if (gamePhase !== "ready") return false;
    if (screen === "multi_game") {
      if (!isHost) return false;
      socket.emit("start-play");
      return true;
    }
    startGame();
    return true;
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach(function(s) {
      s.classList.add("hidden");
    });
    var el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
    if (id === "screen-menu") screen = "menu";
    else if (id === "screen-single") screen = "single";
    else if (id === "screen-multi-lobby") screen = "multi_lobby";
    else if (id === "screen-multi-game") screen = "multi_game";
  }

  function setScreen(s) {
    screen = s;
    var showId = s === "menu" ? "screen-menu"
      : s === "single" ? "screen-single"
      : s === "multi_lobby" ? "screen-multi-lobby"
      : "screen-multi-game";
    showScreen(showId);
  }

  // ===================== PHASER DRAW =====================
  var game = null;
  var BOARD_PX_W = BOARD_W * BLOCK_PX, BOARD_PX_H = BOARD_H * BLOCK_PX;

  function getBoardSlotRect(selector) {
    var el = document.querySelector(selector);
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var block = Math.floor(Math.min(rect.width / BOARD_W, rect.height / BOARD_H));
    block = Math.max(12, block);
    var boardW = block * BOARD_W;
    var boardH = block * BOARD_H;
    return {
      x: rect.left + (rect.width - boardW) / 2,
      y: rect.top + (rect.height - boardH) / 2,
      block: block
    };
  }

  function drawOneBoard(gfx, b, cur, cx, cy, ox, oy, blockPx) {
    var px = blockPx || BLOCK_PX;
    var boardPxW = BOARD_W * px;
    var boardPxH = BOARD_H * px;
    gfx.lineStyle(2, 0x00ffff, 0.9);
    gfx.strokeRect(ox, oy, boardPxW, boardPxH);

    for (var row = 0; row < BOARD_H; row++) {
      for (var col = 0; col < BOARD_W; col++) {
        var id = b[row][col];
        if (id) {
          var color = (PIECES[PIECE_NAMES[id - 1]] || PIECES.I).color;
          var x = ox + col * px, y = oy + row * px;
          gfx.fillStyle(color, 1);
          gfx.fillRect(x + 1, y + 1, px - 2, px - 2);
          gfx.lineStyle(1, 0xffffff, 0.3);
          gfx.strokeRect(x, y, px, px);
        }
      }
    }

    if (cur && cur.cells) {
      var piece = getPiece(cur.name);
      if (piece) {
        var color2 = piece.color;
        for (var i = 0; i < cur.cells.length; i++) {
          var xx = ox + (cx + cur.cells[i][0]) * px, yy = oy + (cy + cur.cells[i][1]) * px;
          gfx.fillStyle(color2, 1);
          gfx.fillRect(xx + 1, yy + 1, px - 2, px - 2);
          gfx.lineStyle(1, 0xffffff, 0.5);
          gfx.strokeRect(xx, yy, px, px);
        }
      }
    }
  }

  function drawBoardPhaser(gfx) {
    if (!gfx) return;
    gfx.clear();
    var w = window.innerWidth, h = window.innerHeight;

    if (screen === "single") {
      var slot = getBoardSlotRect(".board-frame");
      var ox = slot ? slot.x : (w - BOARD_PX_W) / 2;
      var oy = slot ? slot.y : (h - BOARD_PX_H) / 2;
      drawOneBoard(gfx, board, current, currentPx, currentPy, ox, oy, slot ? slot.block : BLOCK_PX);
    } else if (screen === "multi_game") {
      var gap = 40;
      var totalW = BOARD_PX_W * 2 + gap;
      var startX = (w - totalW) / 2;
      var oy2 = (h - BOARD_PX_H) / 2;

      drawOneBoard(gfx, board, current, currentPx, currentPy, startX, oy2);

      var oppBoard = opponentState && opponentState.board ? opponentState.board : createEmptyBoard();
      var oppCur = null, oppPx = 0, oppPy = 0;
      if (opponentState) {
        oppPx = opponentState.currentPx != null ? opponentState.currentPx : 0;
        oppPy = opponentState.currentPy != null ? opponentState.currentPy : 0;
        if (opponentState.current && opponentState.current.name)
          oppCur = { name: opponentState.current.name, cells: opponentState.current.cells || [] };
      }
      drawOneBoard(gfx, oppBoard, oppCur, oppPx, oppPy, startX + BOARD_PX_W + gap, oy2);
    }
  }

  var config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    parent: "gameContainer",
    backgroundColor: "rgba(0,0,0,0)",
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: {
      create: function() {
        this.gfx = this.add.graphics();
        drawBoardPhaser(this.gfx);
        this.scale.on("resize", function() { drawBoardPhaser(this.gfx); }, this);
      },
      update: function(time, delta) {
        if (screen !== "single" && screen !== "multi_game") return;
        drawBoardPhaser(this.gfx);

        if (gamePhase !== "playing" || paused || gameOver) return;
        if (!current) return;

        gravityAcc += delta;
        if (gravityAcc >= lastGravityMs) {
          gravityAcc = 0;
          if (collides(board, current, currentPx, currentPy + 1)) lock();
          else currentPy++;
        }
      }
    }
  };

  function initPhaser() {
    if (game) return;
    if (typeof Phaser === "undefined") return;
    game = new Phaser.Game(config);
  }

  // ===================== SOCKET EVENTS =====================
  socket.on("room-created", function(data) {
    roomCode = data.roomCode;
    isHost = true;
    playerCount = 1;
    var lanEl = document.getElementById("lobbyLanUrl");
    var codeEl = document.getElementById("lobbyRoomCode");
    var statusEl = document.getElementById("lobbyStatus");
    if (lanEl) { lanEl.textContent = "On the other device, open: " + (data.lanUrl || "") + " and enter room code:"; lanEl.classList.remove("hidden"); }
    if (codeEl) { codeEl.textContent = data.roomCode; codeEl.classList.remove("hidden"); }
    if (statusEl) statusEl.textContent = "Room created. Waiting for player 2...";
    var btn = document.getElementById("btnStartMulti");
    if (btn) btn.classList.add("hidden");
  });

  socket.on("room-joined", function(data) {
    roomCode = data.roomCode;
    playerCount = data.playerCount || 2;
    var statusEl = document.getElementById("lobbyStatus");
    if (statusEl) statusEl.textContent = "Joined room. " + playerCount + "/2 players.";
  });

  socket.on("room-error", function(data) {
    var statusEl = document.getElementById("lobbyStatus");
    if (statusEl) statusEl.textContent = data.message || "Error";
  });

  socket.on("players-update", function(data) {
    playerCount = data.playerCount || 0;
    var statusEl = document.getElementById("lobbyStatus");
    if (statusEl) statusEl.textContent = playerCount + "/2 players.";
    var btn = document.getElementById("btnStartMulti");
    if (btn && isHost && playerCount >= 2) btn.classList.remove("hidden");
    else if (btn && (!isHost || playerCount < 2)) btn.classList.add("hidden");
  });

  socket.on("game-started", function() {
    document.body.classList.add("in-game");
    initPhaser();
    setScreen("multi_game");
    opponentState = null;
    goToReadyStateMulti();
    startWebcamLazy();

    if (stateBroadcastInterval) clearInterval(stateBroadcastInterval);
    stateBroadcastInterval = setInterval(function() {
      if (screen !== "multi_game" || !roomCode) return;
      socket.emit("state", {
        board: board,
        current: current ? { name: current.name, cells: current.cells } : null,
        currentPx: currentPx, currentPy: currentPy,
        score: score, lines: lines, level: level, gameOver: gameOver
      });
    }, 100);
  });

  socket.on("play-started", function() {
    startGame();
  });

  socket.on("opponent-state", function(payload) {
    opponentState = payload;
  });

  socket.on("receive-garbage", function(payload) {
    applyGarbage(payload && payload.lines);
  });

  socket.on("player-won", function() {
    showWinState();
  });

  socket.on("player-left", function() {
    playerCount = Math.max(0, playerCount - 1);
    gameOver = true;
    gamePhase = "gameover";
    showPause(false);
    showMatchResult("OPPONENT LEFT", "The other player disconnected. Exit to the menu and create a new room to play again.", false);
  });

  socket.on("rematch-request", function() {
    pendingRematchIncoming = true;
    showMatchResult("REMATCH?", "Opponent wants another round.", true);
  });

  socket.on("rematch-accepted", function() {
    hasRequestedRematch = false;
    pendingRematchIncoming = false;
    goToReadyStateMulti();
  });

  socket.on("cv-action", function(payload) {
    if (!payload) return;
    applyCvAction(payload.action || payload);
  });

  // ===================== MENU FLOW =====================
  function goMenu() {
    if (roomCode) socket.emit("leave-room");
    document.body.classList.remove("in-game");
    gamePhase = "menu";
    setScreen("menu");

    // CRITICAL: don’t kill stream tracks when going back to menu.
    // CV loop can stop, but keep stream alive.
    stopCameraAndCV(false);

    if (stateBroadcastInterval) { clearInterval(stateBroadcastInterval); stateBroadcastInterval = null; }
    roomCode = null; isHost = false; playerCount = 0;
    opponentState = null;
    hideMatchResult();
  }

  function startSingle() {
    showScreen("screen-single");
    document.body.classList.add("in-game");
    initPhaser();
    goToReadyState();
    startWebcamLazy();
  }

  function goMultiLobby() {
    showScreen("screen-multi-lobby");
    var st = document.getElementById("lobbyStatus");
    if (st) st.textContent = "";
    var lan = document.getElementById("lobbyLanUrl");
    if (lan) lan.classList.add("hidden");
    var code = document.getElementById("lobbyRoomCode");
    if (code) code.classList.add("hidden");
    var btn = document.getElementById("btnStartMulti");
    if (btn) btn.classList.add("hidden");
  }

  function setupMenuButtons() {
    var btnSingle = document.getElementById("btnSingle");
    var btnMulti = document.getElementById("btnMulti");
    var btnHow = document.getElementById("btnHowToPlay");
    var btnHowClose = document.getElementById("btnHowToPlayClose");
    if (btnSingle) btnSingle.onclick = startSingle;
    if (btnMulti) btnMulti.onclick = goMultiLobby;
    if (btnHow) btnHow.onclick = function() {
      var h = document.getElementById("howToPlayOverlay");
      if (h) h.classList.remove("hidden");
    };
    if (btnHowClose) btnHowClose.onclick = function() {
      var h = document.getElementById("howToPlayOverlay");
      if (h) h.classList.add("hidden");
    };
  }

  function setupSingleButtons() {
    var btnStart = document.getElementById("btnStartSingle");
    var btnPause = document.getElementById("btnPause");
    var btnRestart = document.getElementById("btnRestart");
    var btnExit = document.getElementById("btnExitSingle");
    if (btnStart) btnStart.onclick = startGame;
    if (btnPause) btnPause.onclick = function() {
      togglePause();
    };
    if (btnRestart) btnRestart.onclick = goToReadyState;
    if (btnExit) btnExit.onclick = goMenu;
  }

  function setupLobbyButtons() {
    var btnHost = document.getElementById("btnHost");
    var btnJoin = document.getElementById("btnJoin");
    var btnBack = document.getElementById("btnBackLobby");
    var btnStartMulti = document.getElementById("btnStartMulti");
    if (btnHost) btnHost.onclick = function() { socket.emit("create-room"); };
    if (btnJoin) btnJoin.onclick = function() {
      var input = document.getElementById("roomCodeInput");
      var code = input ? input.value.trim().toUpperCase() : "";
      if (code.length >= 4) socket.emit("join-room", code);
      else {
        var st = document.getElementById("lobbyStatus");
        if (st) st.textContent = "Enter a valid room code (4–6 chars).";
      }
    };
    if (btnBack) btnBack.onclick = goMenu;
    if (btnStartMulti) btnStartMulti.onclick = function() { socket.emit("start-game"); };
  }

  function setupMultiGameButtons() {
    var btnStartMulti = document.getElementById("btnStartMultiGame");
    var btnPause = document.getElementById("btnPauseMulti");
    var btnExit = document.getElementById("btnExitMulti");
    if (btnStartMulti) btnStartMulti.onclick = function() {
      if (isHost) socket.emit("start-play");
    };
    if (btnPause) btnPause.onclick = function() {
      togglePause();
    };
    if (btnExit) btnExit.onclick = function() {
      if (stateBroadcastInterval) { clearInterval(stateBroadcastInterval); stateBroadcastInterval = null; }
      goMenu();
    };
  }

  var btnResume = document.getElementById("btnResume");
  var btnRestartOverlay = document.getElementById("btnRestartOverlay");
  var btnExitOverlay = document.getElementById("btnExitOverlay");
  var btnRematch = document.getElementById("btnRematch");
  var btnExitMatch = document.getElementById("btnExitMatch");

  if (btnResume) btnResume.onclick = function() {
    paused = false;
    gamePhase = "playing";
    showPause(false);
    setPauseLabel();
  };
  if (btnRestartOverlay) btnRestartOverlay.onclick = function() {
    if (screen === "multi_game") goToReadyStateMulti();
    else goToReadyState();
  };
  if (btnExitOverlay) btnExitOverlay.onclick = goMenu;
  if (btnRematch) btnRematch.onclick = requestRematch;
  if (btnExitMatch) btnExitMatch.onclick = goMenu;

  // ===================== KEYBOARD =====================
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
      var how = document.getElementById("howToPlayOverlay");
      if (how && !how.classList.contains("hidden")) {
        how.classList.add("hidden");
      } else if (screen === "single" || screen === "multi_game") {
        goMenu();
      }
      e.preventDefault();
      return;
    }

    if (screen !== "single" && screen !== "multi_game") return;

    if (e.key === "Enter") {
      if (gamePhase === "ready") {
        startReadyGameFromInput();
        e.preventDefault();
      }
      return;
    }

    if (e.key === "p" || e.key === "P") {
      togglePause();
      e.preventDefault();
      return;
    }

    if (e.key === "r" || e.key === "R") {
      if (screen === "multi_game") goToReadyStateMulti();
      else goToReadyState();
      e.preventDefault();
      return;
    }

    if (gamePhase !== "playing" || paused || gameOver) return;

    switch (e.key) {
      case "ArrowLeft": moveLeft(); e.preventDefault(); break;
      case "ArrowRight": moveRight(); e.preventDefault(); break;
      case "ArrowUp": rotateCW(); e.preventDefault(); break;
      case "ArrowDown": softDrop(); e.preventDefault(); break;
      case " ": hardDrop(); e.preventDefault(); break;
    }
  });

  // ===================== CAMERA / CV =====================
  var cvInputVideo = document.getElementById("cvInput");
  var bgVideo = document.getElementById("webcamBg");
  var videoPreview = document.getElementById("webcamPreview");
  var videoPreviewMulti = document.getElementById("webcamPreviewMulti");
  var menuCameraBlocked = document.getElementById("menuCameraBlocked");
  var webcamPanelStatus = document.getElementById("webcamPanelStatus");
  var webcamPanelStatusMulti = document.getElementById("webcamPanelStatusMulti");

  var webcamOk = false;
  var cameraStatus = "unknown";

  var cvManager = {
    stream: null,
    hands: null,
    isRunning: false,
    lastHandSeenMs: 0,
    videoEl: null,
    rafId: 0,
    _tick: null,
    _lastResultsLog: 0
  };

  function getActiveVideoEl() {
    return cvInputVideo || videoPreview || videoPreviewMulti;
  }

  function attachStreamToVideo(videoEl, stream) {
    if (!videoEl) return;
    if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
    videoEl.play().catch(function(){});
  }

  function attachCameraStream(stream) {
    attachStreamToVideo(cvInputVideo, stream);
    attachStreamToVideo(videoPreview, stream);
    attachStreamToVideo(videoPreviewMulti, stream);
    attachStreamToVideo(bgVideo, stream);
  }

  function updateCameraStatusUI() {
    if (menuCameraBlocked) {
      if (cameraStatus === "blocked") menuCameraBlocked.classList.remove("hidden");
      else menuCameraBlocked.classList.add("hidden");
    }
    if (webcamPanelStatus) {
      if (cameraStatus === "blocked") webcamPanelStatus.classList.remove("hidden");
      else webcamPanelStatus.classList.add("hidden");
    }
    if (webcamPanelStatusMulti) {
      if (cameraStatus === "blocked") webcamPanelStatusMulti.classList.remove("hidden");
      else webcamPanelStatusMulti.classList.add("hidden");
    }
  }

  function updateCvStatus(text) {
    var el = screen === "multi_game" ? document.getElementById("cvStatusMulti") : document.getElementById("cvStatusSingle");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function tryCameraConstraints(constraintsList) {
    if (!constraintsList.length) return Promise.reject(new Error("No camera constraints available"));

    var attempt = constraintsList[0];
    return navigator.mediaDevices.getUserMedia(attempt).catch(function(err) {
      if (constraintsList.length === 1) throw err;
      return tryCameraConstraints(constraintsList.slice(1));
    });
  }

  function requestCamera() {
    if (cvManager.stream && cvManager.stream.active) {
      attachCameraStream(cvManager.stream);
      webcamOk = true;
      cameraStatus = "ready";
      updateCameraStatusUI();
      return Promise.resolve(true);
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraStatus = "blocked";
      webcamOk = false;
      updateCameraStatusUI();
      return Promise.resolve(false);
    }

    var desiredWidth = configNumber(CAMERA_CONFIG, "width", 640);
    var desiredHeight = configNumber(CAMERA_CONFIG, "height", 480);
    var cameraAttempts = [
      { video: { facingMode: { ideal: "user" }, width: { ideal: desiredWidth }, height: { ideal: desiredHeight } }, audio: false },
      { video: { width: { ideal: desiredWidth }, height: { ideal: desiredHeight } }, audio: false },
      { video: true, audio: false }
    ];

    return tryCameraConstraints(cameraAttempts).then(function(stream) {
      cvManager.stream = stream;
      attachCameraStream(stream);

      webcamOk = true;
      cameraStatus = "ready";
      updateCameraStatusUI();
      return true;
    }).catch(function(err) {
      console.warn("Camera blocked:", err);
      webcamOk = false;
      cameraStatus = (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) ? "blocked" : "unavailable";
      updateCameraStatusUI();
      return false;
    });
  }

  function stopCameraAndCV(stopStreamTracks) {
    if (cvManager.rafId) {
      cancelAnimationFrame(cvManager.rafId);
      cvManager.rafId = 0;
    }
    cvManager._tick = null;
    cvManager.isRunning = false;
    cvManager.videoEl = null;

    // ✅ Only close Hands if we are fully stopping tracks
    if (stopStreamTracks && cvManager.hands && typeof cvManager.hands.close === "function") {
      try { cvManager.hands.close(); } catch (e) {}
      cvManager.hands = null;
    }

    if (stopStreamTracks && cvManager.stream) {
      cvManager.stream.getTracks().forEach(function(t){ t.stop(); });
      cvManager.stream = null;

      if (videoPreview) videoPreview.srcObject = null;
      if (videoPreviewMulti) videoPreviewMulti.srcObject = null;
      if (cvInputVideo) cvInputVideo.srcObject = null;
      if (bgVideo) bgVideo.srcObject = null;

      webcamOk = false;
      cameraStatus = "unknown";
      updateCameraStatusUI();
    }
    console.log("[CV] stopped. stopStreamTracks =", !!stopStreamTracks);
  }

  // ===================== GESTURE HELPERS =====================
  function dist(lm, a, b) {
    return Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  }

  function palmCenter(lm) {
    var x = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
    var y = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
    return { x: x, y: y };
  }

  function palmScale(lm) {
    return Math.max(dist(lm, 0, 5), dist(lm, 0, 9), dist(lm, 0, 17), 0.001);
  }

  function pinchRatio(lm, fingerTipIndex) {
    return dist(lm, 4, fingerTipIndex) / palmScale(lm);
  }

  function landmarkFeatureVector(lm) {
    var wrist = lm[0];
    var scale = palmScale(lm);
    var features = [];
    for (var i = 0; i < lm.length; i++) {
      features.push((lm[i].x - wrist.x) / scale);
      features.push((lm[i].y - wrist.y) / scale);
      features.push(((lm[i].z || 0) - (wrist.z || 0)) / scale);
    }
    return features;
  }

  function wrapDeg(a) {
    while (a > 180) a -= 360;
    while (a < -180) a += 360;
    return a;
  }

  // Palm/wrist roll in degrees using landmarks 0,5,17
  function wristTwistDegrees(lm) {
    var v1x = lm[5].x - lm[0].x, v1y = lm[5].y - lm[0].y;
    var v2x = lm[17].x - lm[0].x, v2y = lm[17].y - lm[0].y;
    var a1 = Math.atan2(v1y, v1x);
    var a2 = Math.atan2(v2y, v2x);
    var deg = (a2 - a1) * 180 / Math.PI;
    return wrapDeg(deg);
  }

  function isOpenPalm(lm) {
    var tipMcp = function(tip, mcp) { return dist(lm, tip, mcp); };
    return tipMcp(8, 5) > OPEN_PALM_TIP_MCP_MIN && tipMcp(12, 9) > OPEN_PALM_TIP_MCP_MIN &&
           tipMcp(16, 13) > OPEN_PALM_TIP_MCP_MIN && tipMcp(20, 17) > OPEN_PALM_TIP_MCP_MIN &&
           tipMcp(4, 2) > OPEN_PALM_TIP_MCP_MIN * 0.8;
  }

  function isVSign(lm) {
    var tipMcp = function(tip, mcp) { return dist(lm, tip, mcp); };
    var indexExtended = tipMcp(8, 5) > OPEN_PALM_TIP_MCP_MIN;
    var middleExtended = tipMcp(12, 9) > OPEN_PALM_TIP_MCP_MIN;
    var ringCurled = tipMcp(16, 13) < OPEN_PALM_TIP_MCP_MIN * 0.9;
    var pinkyCurled = tipMcp(20, 17) < OPEN_PALM_TIP_MCP_MIN * 0.9;
    return indexExtended && middleExtended && ringCurled && pinkyCurled;
  }

  // ===================== GESTURE STATE =====================
  var emaX = 0.5, emaY = 0.5, emaSet = false;
  var currentZone = "NONE";
  var lastMoveMs = 0;

  var twistBaselineDeg = null;
  var twistArmed = true;
  var pinchArmed = true;
  var rotateCooldownUntil = 0;

  var dropHistory = [];
  var softDropHeld = false;
  var softDropHeldUntil = 0;
  var lastSoftDropAt = 0;

  var vSignPrev = false, vSignStart = 0, pauseCooldownUntil = 0;
  var clapHistory = [];
  var clapArmed = true;
  var clapCooldownUntil = 0;
  var lastClapStatus = "idle";

  function resetClapState() {
    clapHistory.length = 0;
    clapArmed = true;
    lastClapStatus = "idle";
  }

  function detectClapStart(landmarkSets, now) {
    if (!landmarkSets || landmarkSets.length < 2) {
      resetClapState();
      return false;
    }

    var a = landmarkSets[0];
    var b = landmarkSets[1];
    var palmA = palmCenter(a);
    var palmB = palmCenter(b);
    var scale = Math.max((palmScale(a) + palmScale(b)) / 2, 0.001);
    var dx = palmA.x - palmB.x;
    var dy = palmA.y - palmB.y;
    var distanceRatio = Math.hypot(dx, dy) / scale;
    var verticalRatio = Math.abs(dy) / scale;

    clapHistory.push({ d: distanceRatio, t: now });
    while (clapHistory.length > 0 && now - clapHistory[0].t > CLAP_WINDOW_MS) clapHistory.shift();

    if (distanceRatio > CLAP_REARM_DISTANCE_RATIO) clapArmed = true;

    var widestDistance = distanceRatio;
    for (var i = 0; i < clapHistory.length; i++) {
      if (clapHistory[i].d > widestDistance) widestDistance = clapHistory[i].d;
    }

    var closingAmount = widestDistance - distanceRatio;
    var closeEnough = distanceRatio <= CLAP_DISTANCE_RATIO && verticalRatio <= CLAP_MAX_VERTICAL_RATIO;
    var movingTogether = closingAmount >= CLAP_MIN_CLOSING_RATIO;
    var canStart = screen === "single" || (screen === "multi_game" && isHost);

    if (clapArmed && now >= clapCooldownUntil && closeEnough && movingTogether && canStart && startReadyGameFromInput()) {
      clapArmed = false;
      clapCooldownUntil = now + CLAP_COOLDOWN_MS;
      lastClapStatus = "start";
      return true;
    }

    lastClapStatus = closeEnough ? "close" : "apart";
    return false;
  }

  function resetGestureState() {
    emaSet = false;
    currentZone = "NONE";
    lastMoveMs = 0;

    twistBaselineDeg = null;
    twistArmed = true;
    pinchArmed = true;
    rotateCooldownUntil = 0;

    dropHistory.length = 0;
    softDropHeld = false;
    softDropHeldUntil = 0;
    lastSoftDropAt = 0;

    vSignPrev = false; vSignStart = 0; pauseCooldownUntil = 0;
    resetClapState();
  }

  // ===================== MEDIAPIPE RESULTS =====================
  function onResults(results) {
    var now = Date.now();

    // Proof that onResults is firing (logs once per second)
    if (!cvManager._lastResultsLog || now - cvManager._lastResultsLog > 1000) {
      cvManager._lastResultsLog = now;
      var handsCount = (results.multiHandLandmarks && results.multiHandLandmarks.length) || 0;
      console.log("[CV] onResults firing. hands:", handsCount);
    }

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      currentZone = "NONE";
      dropHistory.length = 0;
      softDropHeld = false;
      twistBaselineDeg = null;
      twistArmed = true;
      pinchArmed = true;
      resetClapState();
      updateCvStatus("CV: no hand");
      return;
    }

    cvManager.lastHandSeenMs = now;

    if (detectClapStart(results.multiHandLandmarks, now)) {
      updateCvStatus("CV: clap start");
      return;
    }

    var lm = results.multiHandLandmarks[0];
    var palm = palmCenter(lm);

    // --- left/right mapping (invert ONCE here) ---
    var rawX = palm.x;
    var rawY = palm.y;

    // The physical feeling you want is controlled by INVERT_LEFT_RIGHT
    // (we invert the X input once)
    if (INVERT_LEFT_RIGHT) rawX = 1 - rawX;

    if (!emaSet) { emaX = rawX; emaY = rawY; emaSet = true; }
    else {
      emaX = EMA_ALPHA * rawX + (1 - EMA_ALPHA) * emaX;
      emaY = EMA_ALPHA * rawY + (1 - EMA_ALPHA) * emaY;
    }

    var x = emaX;

    // --- 2-zone position move w/ hysteresis ---
    if (currentZone === "LEFT") {
      if (x > LEFT_EXIT) currentZone = "NONE";
      else if (gamePhase === "playing" && !paused && !gameOver) {
        if (now - lastMoveMs >= MOVE_REPEAT_MS || lastMoveMs === 0) {
          moveLeft();
          lastMoveMs = now;
        }
      }
    } else if (currentZone === "RIGHT") {
      if (x < RIGHT_EXIT) currentZone = "NONE";
      else if (gamePhase === "playing" && !paused && !gameOver) {
        if (now - lastMoveMs >= MOVE_REPEAT_MS || lastMoveMs === 0) {
          moveRight();
          lastMoveMs = now;
        }
      }
    } else {
      if (x < LEFT_ENTER) {
        currentZone = "LEFT";
        if (gamePhase === "playing" && !paused && !gameOver) { moveLeft(); lastMoveMs = now; }
      } else if (x > RIGHT_ENTER) {
        currentZone = "RIGHT";
        if (gamePhase === "playing" && !paused && !gameOver) { moveRight(); lastMoveMs = now; }
      }
    }

    var openPalm = isOpenPalm(lm);
    var vSign = isVSign(lm);
    var features = landmarkFeatureVector(lm);
    var classifier = window.TetrisGestureClassifier;
    var prediction = classifier && classifier.ready ? classifier.predict(features) : null;
    var indexPinch = pinchRatio(lm, 8);
    var middlePinch = pinchRatio(lm, 12);
    var indexPinching = indexPinch < PINCH_ENTER_RATIO;
    var middlePinching = middlePinch < PINCH_ENTER_RATIO;
    var rotateLabel = prediction && prediction.confidence >= CLASSIFIER_CONFIDENCE ? prediction.label : "";

    if (indexPinch > PINCH_EXIT_RATIO && middlePinch > PINCH_EXIT_RATIO) pinchArmed = true;

    if (pinchArmed && now > rotateCooldownUntil && gamePhase === "playing" && !paused && !gameOver) {
      if (indexPinching || rotateLabel === "rotate_cw") {
        rotateCW();
        rotateCooldownUntil = now + ROTATE_DEBOUNCE_MS;
        pinchArmed = false;
      } else if (middlePinching || rotateLabel === "rotate_ccw") {
        rotateCCW();
        rotateCooldownUntil = now + ROTATE_DEBOUNCE_MS;
        pinchArmed = false;
      }
    }

    if (ROTATION_GESTURE === "wrist_twist" || ROTATION_GESTURE === "trained_wrist_twist") {
      var ang = wristTwistDegrees(lm);
      if (twistBaselineDeg == null) twistBaselineDeg = ang;
      var delta = wrapDeg((ang - twistBaselineDeg) * ROTATE_CW_DIRECTION);

      if (Math.abs(delta) < TWIST_RELEASE_DEG) {
        twistArmed = true;
        twistBaselineDeg = wrapDeg(twistBaselineDeg + 0.05 * wrapDeg(ang - twistBaselineDeg));
      }

      if (twistArmed && now > rotateCooldownUntil && gamePhase === "playing" && !paused && !gameOver) {
        if (delta > TWIST_TRIGGER_DEG) {
          rotateCW();
          rotateCooldownUntil = now + ROTATE_DEBOUNCE_MS;
          twistArmed = false;
          twistBaselineDeg = ang;
        } else if (delta < -TWIST_TRIGGER_DEG) {
          rotateCCW();
          rotateCooldownUntil = now + ROTATE_DEBOUNCE_MS;
          twistArmed = false;
          twistBaselineDeg = ang;
        }
      }
    }

    var trainedSoftDropActive = rotateLabel === "soft_drop_wave_down";
    var softDropGestureActive = trainedSoftDropActive || !REQUIRE_OPEN_PALM_SOFTDROP || openPalm;

    // --- flat-hand wave down => soft drop burst ---
    dropHistory.push({ y: rawY, emaY: emaY, t: now });
    while (dropHistory.length > 0 && now - dropHistory[0].t > DROP_TIME_MS) dropHistory.shift();

    if (trainedSoftDropActive) {
      softDropHeld = true;
      softDropHeldUntil = now + SOFTDROP_HOLD_MS;
    }

    if (dropHistory.length >= 2 && softDropGestureActive) {
      var oldestDrop = dropHistory[0];
      var newestDrop = dropHistory[dropHistory.length - 1];
      var rawDy = newestDrop.y - oldestDrop.y;
      var smoothDy = newestDrop.emaY - oldestDrop.emaY;
      if (rawDy > DROP_DY_THRESHOLD || smoothDy > DROP_DY_THRESHOLD) {
        softDropHeld = true;
        softDropHeldUntil = now + SOFTDROP_HOLD_MS;
      }
    }
    if (!softDropGestureActive) softDropHeld = false;
    if (now > softDropHeldUntil) softDropHeld = false;

    if (softDropHeld && softDropGestureActive && gamePhase === "playing" && !paused && !gameOver) {
      if (now - lastSoftDropAt >= SOFTDROP_REPEAT_MS) {
        softDrop();
        lastSoftDropAt = now;
      }
    }

    updateCvStatus(
      "CV: " +
      "open=" + (openPalm ? "yes" : "no") +
      " | pinch index=" + indexPinch.toFixed(2) +
      " | pinch middle=" + middlePinch.toFixed(2) +
      " | soft=" + (softDropHeld ? "on" : "off") +
      " | clap=" + lastClapStatus +
      " | ml=" + (classifier ? classifier.status : "off") +
      (prediction ? " " + prediction.label + " " + Math.round(prediction.confidence * 100) + "%" : "")
    );

    // --- optional gestures ---
    if (vSign) {
      if (!vSignPrev) vSignStart = now;
      if (now - vSignStart >= V_SIGN_HOLD_MS && now > pauseCooldownUntil) {
        togglePause();
        pauseCooldownUntil = now + PAUSE_DEBOUNCE_MS;
        vSignStart = 0;
      }
    } else vSignStart = 0;
    vSignPrev = vSign;
  }

  // ===================== CV LOOP (rAF) =====================
  function startCameraAndCV(targetVideoEl) {
    if (!targetVideoEl) return Promise.resolve(false);
    if (!targetVideoEl.srcObject || !targetVideoEl.srcObject.active) return Promise.resolve(false);

    // Create Hands once
    if (!cvManager.hands) {
      if (typeof window.Hands === "undefined") {
        console.error("[CV] window.Hands is undefined. mediapipe hands.js not loaded.");
        return Promise.resolve(false);
      }

      var HandsClass = window.Hands;
      var handsInstance = new HandsClass({
        locateFile: function(f) { return "/node_modules/@mediapipe/hands/" + f; }
      });

      handsInstance.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
      });

      handsInstance.onResults(onResults);
      cvManager.hands = handsInstance;
      console.log("[CV] Hands created ✅");
    }

    // Cancel previous loop
    if (cvManager.rafId) {
      cancelAnimationFrame(cvManager.rafId);
      cvManager.rafId = 0;
    }

    cvManager.videoEl = targetVideoEl;
    cvManager.isRunning = true;

    console.log("[CV] LOOP STARTED (rAF) on", targetVideoEl.id);

    var lastSendTs = 0;
    var sendInFlight = false;

    function tick() {
      if (!cvManager.isRunning || cvManager.videoEl !== targetVideoEl) return;
      cvManager.rafId = requestAnimationFrame(tick);

      if (!targetVideoEl.srcObject || targetVideoEl.readyState < 2) return;

      var now = performance.now();
      if (now - lastSendTs < CV_FRAME_MS) return;
      if (sendInFlight) return;

      lastSendTs = now;
      sendInFlight = true;

      cvManager.hands.send({ image: targetVideoEl })
        .then(function() { sendInFlight = false; })
        .catch(function(e) {
          sendInFlight = false;
          // Don’t hard fail — CV should keep trying
        });
    }

    cvManager._tick = tick;
    cvManager.rafId = requestAnimationFrame(tick);
    return Promise.resolve(true);
  }

  function ensureCVRunning(activeVideoEl) {
    if (!activeVideoEl) return Promise.resolve(false);

    return requestCamera().then(function(ok) {
      if (!ok) return false;

      // If already running on this element, done
      if (cvManager.isRunning && cvManager.videoEl === activeVideoEl) return true;

      // Must have stream
      if (!activeVideoEl.srcObject) return false;

      return startCameraAndCV(activeVideoEl);
    });
  }

  // ✅ Robust “start and keep retrying” so it can’t silently fail
  function startWebcamLazy() {
    var vid = getActiveVideoEl();
    if (!vid) return;

    function tryStart() {
      ensureCVRunning(vid).then(function(ok) {
        console.log("[CV] ensureCVRunning ->", ok, "readyState:", vid.readyState, "hasStream:", !!vid.srcObject);
        if (!cvManager.isRunning) setTimeout(tryStart, 250);
      });
    }

    if (vid.readyState < 2) {
      vid.addEventListener("loadeddata", tryStart, { once: true });
      vid.addEventListener("loadedmetadata", tryStart, { once: true });
      setTimeout(tryStart, 400);
    } else {
      tryStart();
    }
  }

  // ===================== INIT =====================
  function init() {
    // UI tick
    setInterval(function() {
      if (screen === "single" || screen === "multi_game") tickUi();
    }, 100);

    setupMenuButtons();
    setupSingleButtons();
    setupLobbyButtons();
    setupMultiGameButtons();

    showScreen("screen-menu");

    // Start camera early so it’s ready when you enter game screens
    requestCamera().then(function() {
      updateCameraStatusUI();
      console.log("[CV] camera ready:", webcamOk, "status:", cameraStatus);
    });
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
