import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { importConfiguration } from "./config.js";

type Configuration = ReturnType<typeof importConfiguration>;
type Account = { name: string; role: "admin" | "volunteer" };
type Capture = { id: string; participantId: number; contestId: number; splitId: number; point: string; at: number; voided: boolean };
const root = fileURLToPath(new URL(".", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function passwordHash(password: string, salt = randomBytes(16).toString("hex")) {
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}

async function body(req: IncomingMessage, limit = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Upload exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function json(req: IncomingMessage) {
  try { return JSON.parse((await body(req)).toString()); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON.");
  }
}

const assets: Record<string, string> = {
  "/": "text/html", "/app.js": "text/javascript", "/styles.css": "text/css",
  "/sw.js": "text/javascript", "/manifest.webmanifest": "application/manifest+json", "/icon.svg": "image/svg+xml",
  "/icon-192.png": "image/png", "/icon-512.png": "image/png",
};

export function createTimingServer(options: { directory: string; adminPassword?: string }) {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(options.directory, "timing.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, role TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, operator TEXT NOT NULL,
      participantId INTEGER NOT NULL, contestId INTEGER NOT NULL, splitId INTEGER NOT NULL,
      point TEXT NOT NULL, at INTEGER NOT NULL, voided INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS captures_event_at ON captures(event, at);
  `);
  if (!db.prepare("SELECT 1 FROM accounts WHERE name = 'admin'").get()) {
    if (!options.adminPassword || options.adminPassword.length < 12) {
      db.close();
      throw new Error("Set TIMING_ADMIN_PASSWORD to at least 12 characters on first startup.");
    }
    db.prepare("INSERT INTO accounts VALUES ('admin', 'admin', ?)").run(passwordHash(options.adminPassword));
  }

  function account(req: IncomingMessage): Account {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const user = token && db.prepare(`
      SELECT a.name, a.role FROM sessions s JOIN accounts a ON a.name = s.name
      WHERE s.token = ? AND s.expires > ?
    `).get(hash(token), Date.now()) as Account | undefined;
    if (!user) throw new HttpError(401, "Sign in to sync your device.");
    return user;
  }

  function admin(user: Account) {
    if (user.role !== "admin") throw new HttpError(403, "Race-control access required.");
  }

  function event(id: string): Configuration {
    const row = db.prepare("SELECT config FROM events WHERE id = ?").get(id);
    if (!row) throw new HttpError(404, "Event not found.");
    return JSON.parse(row.config as string);
  }

  const loginAttempts = new Map<string, { count: number; until: number }>();
  const server = createServer(async (req, res) => {
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method;
    try {
      if (method === "GET" && Object.hasOwn(assets, url.pathname)) {
        res.writeHead(200, { "Content-Type": assets[url.pathname], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
        res.end(readFileSync(join(root, "public", url.pathname === "/" ? "index.html" : url.pathname.slice(1))));
        return;
      }
      if (method === "GET" && url.pathname === "/api/clock") return send({ now: Date.now() });
      if (method === "POST" && url.pathname === "/api/login") {
        const { name, password } = await json(req);
        if (typeof name !== "string" || typeof password !== "string" || name.length > 48 || password.length > 256) {
          throw new HttpError(400, "Enter a username and password.");
        }
        const ip = req.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        for (const [key, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(key);
        const attempt = loginAttempts.get(ip) ?? { count: 0, until: now + 60_000 };
        if (attempt.count >= 10) throw new HttpError(429, "Too many sign-in attempts. Try again in a minute.");
        const row = db.prepare("SELECT * FROM accounts WHERE name = ?").get(name.trim().toLowerCase());
        const stored = row?.password as string | undefined;
        const computed = passwordHash(password, stored?.split(":")[0] ?? "0".repeat(32));
        if (!stored || !timingSafeEqual(Buffer.from(stored), Buffer.from(computed))) {
          attempt.count++;
          loginAttempts.set(ip, attempt);
          throw new HttpError(401, "Username or password is incorrect.");
        }
        loginAttempts.delete(ip);
        const token = randomBytes(32).toString("hex");
        db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
        db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(hash(token), row!.name, now + 7 * 86400_000);
        return send({ token, name: row!.name, role: row!.role });
      }

      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
      const user = account(req);
      if (method === "POST" && url.pathname === "/api/logout") {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(hash(req.headers.authorization!.slice(7)));
        return send({ ok: true });
      }
      if (method === "POST" && url.pathname === "/api/volunteers") {
        admin(user);
        const input = await json(req);
        const name = String(input.name ?? "").trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,48}$/.test(name) || typeof input.password !== "string" || input.password.length < 12 || input.password.length > 256) {
          throw new HttpError(400, "Use a username of 3–48 letters, numbers, dots, hyphens or underscores and a password of 12–256 characters.");
        }
        const result = db.prepare("INSERT OR IGNORE INTO accounts VALUES (?, 'volunteer', ?)").run(name, passwordHash(input.password));
        if (!result.changes) throw new HttpError(409, "That username already exists.");
        return send({ name }, 201);
      }
      if (url.pathname === "/api/events" && method === "GET") {
        const rows = db.prepare("SELECT id, json_extract(config,'$.name') name, json_extract(config,'$.date') date FROM events ORDER BY rowid DESC").all();
        return send(rows);
      }
      if (url.pathname === "/api/events" && method === "POST") {
        admin(user);
        const name = url.searchParams.get("filename") ?? "";
        if (!/\.ses$/i.test(name)) throw new HttpError(400, "Choose a RACE RESULT .ses file.");
        const bytes = await body(req, 256 * 1024 * 1024);
        if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0") throw new HttpError(422, "This file is not a readable RACE RESULT SES database.");
        const dir = mkdtempSync(join(tmpdir(), "backup-ses-"));
        try {
          const file = join(dir, "event.ses");
          writeFileSync(file, bytes);
          let config: Configuration;
          try { config = importConfiguration(file, name); }
          catch { throw new HttpError(422, "The SES file does not contain a supported event configuration."); }
          const previous = db.prepare("SELECT id FROM events WHERE fingerprint = ?").get(config.fingerprint);
          if (previous) {
            db.prepare("UPDATE events SET config = ? WHERE id = ?").run(JSON.stringify(config), previous.id);
            return send({ id: previous.id, ...config });
          }
          const id = randomUUID();
          db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(id, config.fingerprint, JSON.stringify(config));
          return send({ id, ...config }, 201);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      const match = url.pathname.match(/^\/api\/events\/([\w-]+)(\/captures)?$/);
      if (!match) throw new HttpError(404, "Not found.");
      const [, eventId, captures] = match;
      const config = event(eventId);
      if (!captures && method === "GET") return send({ id: eventId, ...config });
      if (captures && method === "GET") {
        admin(user);
        return send(db.prepare("SELECT * FROM captures WHERE event = ? ORDER BY at, id").all(eventId));
      }
      if (captures && method === "POST") {
        const entries: unknown = (await json(req)).entries;
        if (!Array.isArray(entries) || entries.length > 200) throw new HttpError(400, "Send up to 200 captures per batch.");
        const runners = new Map(config.roster.map((runner) => [runner.id, runner]));
        const splits = new Set(config.timingPoints.flatMap((point) => point.passes.flatMap((pass) =>
          pass.splits.map((split) => JSON.stringify([point.name, split.contestId, split.id])))));
        const save = db.prepare(`
          INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET voided = max(captures.voided, excluded.voided)
          WHERE event = excluded.event AND operator = excluded.operator AND participantId = excluded.participantId
            AND contestId = excluded.contestId AND splitId = excluded.splitId AND point = excluded.point AND at = excluded.at
        `);
        const accepted: string[] = [];
        const rejected: string[] = [];
        db.exec("BEGIN");
        try {
          for (const entry of entries as Capture[]) {
            if (!entry || typeof entry.id !== "string" || !/^[a-f0-9-]{36}$/i.test(entry.id)
              || !Number.isSafeInteger(entry.at) || entry.at < 0 || entry.at > 8_640_000_000_000_000
              || !Number.isInteger(entry.participantId) || !Number.isInteger(entry.contestId) || !Number.isInteger(entry.splitId)
              || runners.get(entry.participantId)?.contestId !== entry.contestId
              || [4, 5].includes(runners.get(entry.participantId)?.status ?? 0)
              || !splits.has(JSON.stringify([entry.point, entry.contestId, entry.splitId])) || typeof entry.voided !== "boolean") {
              if (typeof entry?.id === "string") rejected.push(entry.id);
              continue;
            }
            const result = save.run(entry.id, eventId, user.name, entry.participantId, entry.contestId, entry.splitId, entry.point, entry.at, Number(entry.voided));
            (result.changes ? accepted : rejected).push(entry.id);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return send({ accepted, rejected });
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      if (!res.destroyed) send({ error: error instanceof HttpError ? error.message : "The server could not complete the request." }, error instanceof HttpError ? error.status : 500);
    }
  });
  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.TIMING_PORT ?? 4420);
  const host = process.env.TIMING_HOST ?? "127.0.0.1";
  const server = createTimingServer({ directory: process.env.TIMING_DATA_DIR ?? join(root, "data"), adminPassword: process.env.TIMING_ADMIN_PASSWORD });
  server.listen(port, host, () => console.log(`Backup Timing is running at http://${host}:${port}`));
}
