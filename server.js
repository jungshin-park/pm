const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, "data", "pm.db"));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://svc-swc.bee0.lge.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 200;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS review (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Title TEXT NOT NULL UNIQUE,
    GroupName TEXT NOT NULL DEFAULT '',
    ReviewDate TEXT NOT NULL DEFAULT '',
    ReviewTime TEXT NOT NULL DEFAULT '',
    CandidateName TEXT NOT NULL DEFAULT '',
    Completed INTEGER NOT NULL DEFAULT 0,
    CompletedBy TEXT NOT NULL DEFAULT '',
    CompletedAt TEXT,
    Modified TEXT NOT NULL
  );
`);

const listStmt = db.prepare("SELECT * FROM review ORDER BY ReviewDate, ReviewTime, Id");
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO review (Title, GroupName, ReviewDate, ReviewTime, CandidateName, Completed, CompletedBy, CompletedAt, Modified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateStmt = db.prepare("UPDATE review SET Completed = ?, CompletedBy = ?, CompletedAt = ?, Modified = ? WHERE Id = ?");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, label) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(400, `${label} 형식이 올바르지 않습니다.`);
  const v = value.trim();
  if (v.length > MAX_TEXT) throw new HttpError(400, `${label} 값이 너무 깁니다.`);
  return v;
}
function isoOrNull(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "날짜 형식이 올바르지 않습니다.");
  return d.toISOString();
}
function toItem(row) {
  return { ...row, Completed: row.Completed === 1 };
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (origin.toLowerCase() === `http://${request.headers.host}`.toLowerCase()) return true;
  if (!ALLOWED_ORIGINS.includes("*") && !ALLOWED_ORIGINS.includes(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes("*") ? "*" : origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}
function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "요청이 너무 큽니다.")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function handleSync(payload) {
  const now = new Date().toISOString();
  switch (payload?.action) {
    case "list":
      return listStmt.all().map(toItem);
    case "create": {
      const f = payload.fields || {};
      const title = text(f.Title, "Title");
      if (!title) throw new HttpError(400, "Title이 필요합니다.");
      const completed = f.Completed === true ? 1 : 0;
      insertStmt.run(
        title, text(f.GroupName, "GroupName"), text(f.ReviewDate, "ReviewDate"), text(f.ReviewTime, "ReviewTime"),
        text(f.CandidateName, "CandidateName"), completed, completed ? text(f.CompletedBy, "CompletedBy") : "",
        completed ? isoOrNull(f.CompletedAt) || now : null, now
      );
      return { ok: true };
    }
    case "update": {
      const id = Number(payload.id);
      const f = payload.fields || {};
      if (!Number.isInteger(id)) throw new HttpError(400, "id가 올바르지 않습니다.");
      const completed = f.Completed === true ? 1 : 0;
      const result = updateStmt.run(
        completed, completed ? text(f.CompletedBy, "CompletedBy") : "", completed ? isoOrNull(f.CompletedAt) || now : null, now, id
      );
      if (!result.changes) throw new HttpError(404, "대상을 찾을 수 없습니다.");
      return { ok: true };
    }
    default:
      throw new HttpError(400, "지원하지 않는 action입니다.");
  }
}

// 수식으로 해석될 수 있는 셀 앞에 작은따옴표를 붙여 Excel 수식 주입을 막는다.
function csvCell(value) {
  let v = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function exportCsv() {
  const header = ["심사일", "시간", "그룹", "대상자", "완료", "처리자", "완료시각", "수정시각"];
  const lines = [header.join(",")];
  for (const r of listStmt.all()) {
    lines.push([r.ReviewDate, r.ReviewTime, r.GroupName, r.CandidateName, r.Completed ? "완료" : "", r.CompletedBy, r.CompletedAt || "", r.Modified].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

const server = http.createServer(async (request, response) => {
  try {
    if (!setCors(request, response)) throw new HttpError(403, "허용되지 않은 출처입니다.");
    const url = new URL(request.url, "http://localhost");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/pm_js.html")) {
      return send(response, 200, fs.readFileSync(path.join(__dirname, "pm_js.html")), "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/api/export.csv") {
      response.setHeader("Content-Disposition", 'attachment; filename="pm_review.csv"');
      return send(response, 200, exportCsv(), "text/csv; charset=utf-8");
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      let payload;
      try { payload = JSON.parse(await readBody(request)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "JSON 형식이 올바르지 않습니다."); }
      return send(response, 200, handleSync(payload));
    }
    throw new HttpError(404, "Not found");
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    send(response, status, { error: status === 500 ? "서버 오류" : error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PMC review API: http://${HOST}:${PORT} (db=${DB_FILE})`);
});
