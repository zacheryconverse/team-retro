const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const HOST = process.env.RETRO_HOST || "127.0.0.1";
const PORT = Number(process.env.RETRO_PORT || 8787);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = process.env.RETRO_DATA_DIR || path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "board.json");
const SHARE_URL_FILE = path.join(DATA_DIR, "share-url.txt");
const DEFAULT_TIMER_MINUTES = 15;

function createDefaultTimer() {
  const durationMs = DEFAULT_TIMER_MINUTES * 60 * 1000;
  return {
    durationMs,
    remainingMs: durationMs,
    endAt: null,
  };
}

function normalizeTimer(value) {
  const fallback = createDefaultTimer();
  const input = value && typeof value === "object" ? value : {};
  const durationMs =
    Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0
      ? Math.round(Number(input.durationMs))
      : fallback.durationMs;
  let remainingMs =
    Number.isFinite(Number(input.remainingMs)) && Number(input.remainingMs) >= 0
      ? Math.min(durationMs, Math.round(Number(input.remainingMs)))
      : durationMs;
  let endAt = typeof input.endAt === "string" && input.endAt ? input.endAt : null;

  if (endAt) {
    const endTime = Date.parse(endAt);
    if (!Number.isFinite(endTime)) {
      endAt = null;
      remainingMs = durationMs;
    } else {
      remainingMs = Math.max(0, endTime - Date.now());
      if (remainingMs === 0) {
        endAt = null;
      }
    }
  }

  return {
    durationMs,
    remainingMs,
    endAt,
  };
}

function createDefaultState() {
  return {
    title: "Team Retro",
    columns: [
      { id: "went-well", title: "Went Well", color: "#4d8b31" },
      { id: "needs-work", title: "Needs Work", color: "#d78324" },
      { id: "action-items", title: "Action Items", color: "#2962c6" },
    ],
    cards: [],
    timer: createDefaultTimer(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value) {
  const fallback = createDefaultState();
  const input = value && typeof value === "object" ? value : {};
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : fallback.title,
    columns: Array.isArray(input.columns) && input.columns.length ? input.columns : fallback.columns,
    cards: Array.isArray(input.cards) ? input.cards : [],
    timer: normalizeTimer(input.timer),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt,
  };
}

function loadStateSync() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    return createDefaultState();
  }
}

function loadShareUrlSync() {
  try {
    const value = fs.readFileSync(SHARE_URL_FILE, "utf8").trim();
    return value || null;
  } catch (error) {
    return null;
  }
}

function cloneState() {
  syncTimerState();
  return JSON.parse(JSON.stringify(state));
}

async function persistState() {
  syncTimerState();
  const nextState = normalizeState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  state = nextState;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(DATA_FILE, JSON.stringify(nextState, null, 2));
}

function queuePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistState().catch((error) => {
      console.error("Failed to persist retro board state.", error);
    });
  }, 100);
}

function syncTimerState() {
  if (!state) {
    return createDefaultTimer();
  }

  const nextTimer = normalizeTimer(state.timer);
  state = {
    ...state,
    timer: nextTimer,
  };
  return nextTimer;
}

function scheduleTimerCompletion() {
  clearTimeout(timerDoneTimer);
  const timer = syncTimerState();

  if (!timer.endAt) {
    return;
  }

  const delay = Math.max(0, Date.parse(timer.endAt) - Date.now());
  timerDoneTimer = setTimeout(() => {
    syncTimerState();
    queuePersist();
    broadcastState("timer-finished");
  }, delay + 25);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastState(reason = "update") {
  const payload = {
    state: cloneState(),
    reason,
    at: new Date().toISOString(),
  };

  for (const client of clients) {
    try {
      sendEvent(client, "state", payload);
    } catch (error) {
      clients.delete(client);
    }
  }
}

function broadcastReload(changedPath = "") {
  const payload = {
    changedPath,
    at: new Date().toISOString(),
  };

  for (const client of clients) {
    try {
      sendEvent(client, "reload", payload);
    } catch (error) {
      clients.delete(client);
    }
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function serveStaticFile(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

function resolvePublicPath(requestPath) {
  const cleanPath = requestPath.replace(/^\/+/, "") || "index.html";
  const resolvedPath = path.resolve(PUBLIC_DIR, cleanPath);
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolvedPath;
}

function findCard(cardId) {
  return state.cards.find((card) => card.id === cardId);
}

function updateCard(cardId, updater) {
  let changedCard = null;
  state.cards = state.cards.map((card) => {
    if (card.id !== cardId) {
      return card;
    }
    changedCard = updater(card);
    return changedCard;
  });
  return changedCard;
}

function createCard(text, columnId, media) {
  const card = {
    id: crypto.randomUUID(),
    text: text.trim(),
    columnId,
    media: media || null,
    votes: 0,
    createdAt: new Date().toISOString(),
  };
  state.cards.unshift(card);
  return card;
}

let state = loadStateSync();
let persistTimer = null;
let reloadTimer = null;
let timerDoneTimer = null;
const clients = new Set();

scheduleTimerCompletion();

setInterval(() => {
  for (const client of clients) {
    try {
      client.write(": keep-alive\n\n");
    } catch (error) {
      clients.delete(client);
    }
  }
}, 15000);

try {
  fs.watch(PUBLIC_DIR, { recursive: true }, (_eventType, filename) => {
    const changedPath = String(filename || "");
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      broadcastReload(changedPath);
    }, 120);
  });
} catch (error) {
  console.warn("Live UI reload watcher could not be started.", error);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, { state: cloneState() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/share-url") {
    sendJson(res, 200, { shareUrl: loadShareUrlSync() });
    return;
  }

  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");
    clients.add(res);
    sendEvent(res, "state", { state: cloneState(), reason: "connected", at: new Date().toISOString() });

    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/title") {
    try {
      const body = await parseJsonBody(req);
      state.title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Team Retro";
      queuePersist();
      broadcastState("title-updated");
      sendJson(res, 200, { ok: true, state: cloneState() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/cards") {
    try {
      const body = await parseJsonBody(req);
      if (typeof body.text !== "string" || !body.text.trim()) {
        sendJson(res, 400, { ok: false, error: "Card text is required." });
        return;
      }
      if (typeof body.columnId !== "string" || !body.columnId) {
        sendJson(res, 400, { ok: false, error: "A target column is required." });
        return;
      }

      const card = createCard(body.text, body.columnId, body.media || null);
      queuePersist();
      broadcastState("card-created");
      sendJson(res, 201, { ok: true, card });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/timer") {
    try {
      const body = await parseJsonBody(req);
      const currentTimer = syncTimerState();

      if (body.action === "set-duration") {
        const minutes = Number(body.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
          sendJson(res, 400, { ok: false, error: "Pick a timer length between 1 and 240 minutes." });
          return;
        }

        const durationMs = Math.round(minutes * 60 * 1000);
        state = {
          ...state,
          timer: {
            durationMs,
            remainingMs: durationMs,
            endAt: null,
          },
        };
      } else if (body.action === "start") {
        const remainingMs = currentTimer.remainingMs > 0 ? currentTimer.remainingMs : currentTimer.durationMs;
        state = {
          ...state,
          timer: {
            durationMs: currentTimer.durationMs,
            remainingMs,
            endAt: new Date(Date.now() + remainingMs).toISOString(),
          },
        };
      } else if (body.action === "pause") {
        state = {
          ...state,
          timer: {
            durationMs: currentTimer.durationMs,
            remainingMs: currentTimer.remainingMs,
            endAt: null,
          },
        };
      } else if (body.action === "reset") {
        state = {
          ...state,
          timer: {
            durationMs: currentTimer.durationMs,
            remainingMs: currentTimer.durationMs,
            endAt: null,
          },
        };
      } else {
        sendJson(res, 400, { ok: false, error: "Unknown timer action." });
        return;
      }

      syncTimerState();
      scheduleTimerCompletion();
      queuePersist();
      broadcastState("timer-updated");
      sendJson(res, 200, { ok: true, timer: state.timer, state: cloneState() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  const cardMatch = pathname.match(/^\/api\/cards\/([a-zA-Z0-9-]+)$/);
  const voteMatch = pathname.match(/^\/api\/cards\/([a-zA-Z0-9-]+)\/vote$/);
  const duplicateMatch = pathname.match(/^\/api\/cards\/([a-zA-Z0-9-]+)\/duplicate$/);

  if (req.method === "PATCH" && cardMatch) {
    try {
      const body = await parseJsonBody(req);
      const cardId = cardMatch[1];
      const nextCard = updateCard(cardId, (card) => ({
        ...card,
        text: typeof body.text === "string" && body.text.trim() ? body.text.trim() : card.text,
        columnId: typeof body.columnId === "string" && body.columnId ? body.columnId : card.columnId,
        media: Object.prototype.hasOwnProperty.call(body, "media") ? body.media : card.media,
      }));

      if (!nextCard) {
        sendJson(res, 404, { ok: false, error: "Card not found." });
        return;
      }

      queuePersist();
      broadcastState("card-updated");
      sendJson(res, 200, { ok: true, card: nextCard });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && cardMatch) {
    const cardId = cardMatch[1];
    const beforeCount = state.cards.length;
    state.cards = state.cards.filter((card) => card.id !== cardId);
    if (state.cards.length === beforeCount) {
      sendJson(res, 404, { ok: false, error: "Card not found." });
      return;
    }

    queuePersist();
    broadcastState("card-deleted");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && voteMatch) {
    const cardId = voteMatch[1];
    const nextCard = updateCard(cardId, (card) => ({
      ...card,
      votes: (card.votes || 0) + 1,
    }));

    if (!nextCard) {
      sendJson(res, 404, { ok: false, error: "Card not found." });
      return;
    }

    queuePersist();
    broadcastState("card-voted");
    sendJson(res, 200, { ok: true, card: nextCard });
    return;
  }

  if (req.method === "POST" && duplicateMatch) {
    const cardId = duplicateMatch[1];
    const originalCard = findCard(cardId);
    if (!originalCard) {
      sendJson(res, 404, { ok: false, error: "Card not found." });
      return;
    }

    const card = createCard(originalCard.text, originalCard.columnId, originalCard.media || null);
    queuePersist();
    broadcastState("card-duplicated");
    sendJson(res, 201, { ok: true, card });
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    state = createDefaultState();
    scheduleTimerCompletion();
    queuePersist();
    broadcastState("board-reset");
    sendJson(res, 200, { ok: true, state: cloneState() });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    await serveStaticFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  const publicPath = resolvePublicPath(pathname);
  if (!publicPath) {
    sendText(res, 403, "Forbidden");
    return;
  }
  await serveStaticFile(res, publicPath);
});

server.listen(PORT, HOST, () => {
  console.log(`Retro board running at http://${HOST}:${PORT}`);
});
