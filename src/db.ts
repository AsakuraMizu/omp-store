import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STORE_DIR = ".store";
const DB_FILE = "store.db";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 6;
const ID_IN_PATH = /\.store[\\/]([0-9a-hjkmnp-tv-z]{6})(?![0-9a-z])/g;

const IDLE_ACTIVE_DAYS = 20;
const TRASH_ACTIVE_DAYS = 7;

export interface Entry {
  id: string;
  title: string;
  description: string;
  session: string;
  created: number;
  lastUsed: number;
  trashedAt: number | null;
  dropReason: string | null;
}

interface EntryRow {
  id: string;
  title: string;
  description: string;
  session: string;
  created: number;
  last_used: number;
  trashed_at: number | null;
  drop_reason: string | null;
}

export interface CleanupPlan {
  expire: Entry[];
  purge: Entry[];
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function idsIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(ID_IN_PATH), m => m[1]))];
}

export function findRoot(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, STORE_DIR, DB_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, b => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    session: row.session,
    created: row.created,
    lastUsed: row.last_used,
    trashedAt: row.trashed_at,
    dropReason: row.drop_reason,
  };
}

export class Store {
  readonly dir: string;
  private readonly db: Database;

  constructor(readonly root: string, create = false) {
    this.dir = join(root, STORE_DIR);
    if (create) mkdirSync(this.dir, { recursive: true });
    this.db = new Database(join(this.dir, DB_FILE), { create });
    // WAL needs shared memory between connections, which NFS cannot provide across hosts.
    this.db.run("PRAGMA journal_mode = DELETE");
    this.db.run("PRAGMA busy_timeout = 10000");
    this.db.run(`CREATE TABLE IF NOT EXISTS entry (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      session TEXT NOT NULL,
      created INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      trashed_at INTEGER,
      drop_reason TEXT
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS dependency (
      entry TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (entry, target)
    )`);
    this.db.run("CREATE TABLE IF NOT EXISTS active_day (day TEXT PRIMARY KEY)");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  entryDir(id: string): string {
    return join(this.dir, id);
  }

  get(id: string): Entry | undefined {
    const row = this.db.query<EntryRow, [string]>("SELECT * FROM entry WHERE id = ?").get(id);
    return row ? toEntry(row) : undefined;
  }

  all(trashed: boolean): Entry[] {
    const sql = trashed
      ? "SELECT * FROM entry WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC"
      : "SELECT * FROM entry WHERE trashed_at IS NULL ORDER BY last_used DESC";
    return this.db.query<EntryRow, []>(sql).all().map(toEntry);
  }

  put(title: string, description: string, session: string): Entry {
    const now = Date.now();
    for (;;) {
      const id = newId();
      const inserted = this.db
        .query("INSERT OR IGNORE INTO entry (id, title, description, session, created, last_used) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, title, description, session, now, now);
      if (inserted.changes === 0) continue;
      mkdirSync(this.entryDir(id));
      return this.get(id)!;
    }
  }

  search(query: string, includeTrash: boolean, limit: number): Entry[] {
    const pool = includeTrash ? [...this.all(false), ...this.all(true)] : this.all(false);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return pool.slice(0, limit);
    return pool
      .map(entry => {
        const title = entry.title.toLowerCase();
        const description = entry.description.toLowerCase();
        const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 2 : description.includes(t) ? 1 : 0), 0);
        return { entry, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.lastUsed - a.entry.lastUsed)
      .slice(0, limit)
      .map(r => r.entry);
  }

  update(id: string, fields: { title?: string; description?: string }): void {
    if (fields.title !== undefined) this.db.query("UPDATE entry SET title = ? WHERE id = ?").run(fields.title, id);
    if (fields.description !== undefined) {
      this.db.query("UPDATE entry SET description = ? WHERE id = ?").run(fields.description, id);
    }
  }

  drop(id: string, reason: string): void {
    this.db.query("UPDATE entry SET trashed_at = ?, drop_reason = ? WHERE id = ?").run(Date.now(), reason, id);
  }

  restore(id: string): void {
    this.db.query("UPDATE entry SET trashed_at = NULL, drop_reason = NULL, last_used = ? WHERE id = ?").run(Date.now(), id);
  }

  addDependency(entry: string, target: string): void {
    this.db.query("INSERT OR IGNORE INTO dependency (entry, target) VALUES (?, ?)").run(entry, target);
  }

  dependencies(id: string): string[] {
    return this.db.query<{ target: string }, [string]>("SELECT target FROM dependency WHERE entry = ?").all(id).map(r => r.target);
  }

  dependents(id: string): string[] {
    return this.db.query<{ entry: string }, [string]>("SELECT entry FROM dependency WHERE target = ?").all(id).map(r => r.entry);
  }

  /** The entry and everything it depends on, directly or through other entries. */
  withDependencies(id: string): string[] {
    const targets = this.db.query<{ target: string }, [string]>("SELECT target FROM dependency WHERE entry = ?");
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const row of targets.all(next)) queue.push(row.target);
    }
    return [...seen];
  }

  touch(uses: Map<string, number>): void {
    const update = this.db.query("UPDATE entry SET last_used = MAX(last_used, ?) WHERE id = ?");
    this.db.transaction(() => {
      for (const [id, at] of uses) update.run(at, id);
    })();
  }

  recordActiveDay(day: string): void {
    this.db.query("INSERT OR IGNORE INTO active_day (day) VALUES (?)").run(day);
  }

  /** True for exactly one caller per day across every session and host sharing this store. */
  claimCleanup(day: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'last_cleanup'").get();
      if (row?.value === day) return false;
      this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_cleanup', ?)").run(day);
      return true;
    }).immediate();
  }

  private nthActiveDay(n: number): string | undefined {
    const rows = this.db.query<{ day: string }, [number]>("SELECT day FROM active_day ORDER BY day DESC LIMIT ?").all(n);
    return rows.length === n ? rows[n - 1].day : undefined;
  }

  cleanupPlan(): CleanupPlan {
    const idleCut = this.nthActiveDay(IDLE_ACTIVE_DAYS);
    const trashCut = this.nthActiveDay(TRASH_ACTIVE_DAYS);
    return {
      expire: idleCut ? this.all(false).filter(e => localDay(e.lastUsed) < idleCut) : [],
      purge: trashCut ? this.all(true).filter(e => localDay(e.trashedAt!) < trashCut) : [],
    };
  }

  async applyCleanup(plan: CleanupPlan): Promise<void> {
    for (const entry of plan.expire) this.drop(entry.id, `unused for ${IDLE_ACTIVE_DAYS} active days`);
    for (const entry of plan.purge) {
      await rm(this.entryDir(entry.id), { recursive: true, force: true });
      this.db.transaction(() => {
        this.db.query("DELETE FROM entry WHERE id = ?").run(entry.id);
        this.db.query("DELETE FROM dependency WHERE entry = ? OR target = ?").run(entry.id, entry.id);
      })();
    }
  }

  /** Top-level names under the store directory that no entry owns. */
  strays(): string[] {
    const known = new Set(this.db.query<{ id: string }, []>("SELECT id FROM entry").all().map(r => r.id));
    return readdirSync(this.dir).filter(name => !name.startsWith(DB_FILE) && !known.has(name));
  }
}
