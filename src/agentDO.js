import { DurableObject } from "cloudflare:workers";
import { getDayWindow, shiftDayWindow } from "./util.js";
import { MAX_LOG_ROWS } from "./config.js";

const MEDIA_GROUP_DEBOUNCE_MS = 1500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_window TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  media_refs TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_day ON messages(day_window);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

CREATE TABLE IF NOT EXISTS memory_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rollups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  covers_from_day TEXT NOT NULL,
  covers_to_day TEXT NOT NULL,
  summary TEXT NOT NULL,
  vector_id TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_ts ON logs(ts);

CREATE TABLE IF NOT EXISTS pending_media_groups (
  media_group_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  items TEXT NOT NULL,
  caption TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wake_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_hhmm TEXT NOT NULL,
  theme TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_day TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);

CREATE TABLE IF NOT EXISTS media_cache (
  file_id TEXT PRIMARY KEY,
  base64 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function rowsOf(cursor) {
  return cursor.toArray();
}

export class AgentDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA.split(";")) {
        const trimmed = stmt.trim();
        if (trimmed) this.ctx.storage.sql.exec(trimmed);
      }
      try {
        this.ctx.storage.sql.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='id')`
        );
        this.ctx.storage.sql.exec(
          `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
             INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
           END;`
        );
        this.ctx.storage.sql.exec(
          `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
             INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
           END;`
        );
        this.ctx.storage.sql.exec(
          `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
             INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
             INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
           END;`
        );
        this._notesFtsAvailable = true;
      } catch {
        this._notesFtsAvailable = false;
      }
    });
  }

  // Helper to ensure Meta updates also refresh any internal variables if needed
  getMeta(key) {
    const row = rowsOf(this.ctx.storage.sql.exec(`SELECT value FROM kv_meta WHERE key = ?`, key))[0];
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.ctx.storage.sql.exec(
      `INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      key,
      value
    );
  }

  // -------------------------------------------------------------------
  // Media Cache Methods
  // -------------------------------------------------------------------

  getCachedMedia(fileId) {
    const row = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM media_cache WHERE file_id = ?`, fileId))[0];
    if (!row) return null;
    return { base64: row.base64, mimeType: row.mime_type };
  }

  setCachedMedia(fileId, base64, mimeType) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO media_cache (file_id, base64, mime_type, created_at) VALUES (?, ?, ?, ?)`,
      fileId,
      base64,
      mimeType,
      Date.now()
    );
  }

  // -------------------------------------------------------------------
  // Messages / rolling history
  // -------------------------------------------------------------------

  appendMessage({ dayWindow, role, content = null, toolCalls = null, toolCallId = null, toolName = null, mediaRefs = null }) {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (day_window, role, content, tool_calls, tool_call_id, tool_name, media_refs, ts)
       VALUES (?,?,?,?,?,?,?,?)`,
      dayWindow,
      role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolCallId,
      toolName,
      mediaRefs ? JSON.stringify(mediaRefs) : null,
      Date.now()
    );
  }

  getMessagesInRange({ fromDayInclusive, toDayInclusive }) {
    return rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM messages WHERE day_window >= ? AND day_window <= ? ORDER BY ts ASC`,
        fromDayInclusive,
        toDayInclusive
      )
    );
  }

  getTodayAndYesterday() {
    const today = getDayWindow();
    const yesterday = shiftDayWindow(today, -1);
    return this.getMessagesInRange({ fromDayInclusive: yesterday, toDayInclusive: today });
  }

  getOldestAgedDay() {
    const today = getDayWindow();
    const boundary = shiftDayWindow(today, -2);
    const row = rowsOf(
      this.ctx.storage.sql.exec(`SELECT MIN(day_window) as d FROM messages WHERE day_window <= ?`, boundary)
    )[0];
    return row && row.d ? row.d : null;
  }

  getMessagesOlderThan(boundaryDayInclusive) {
    return rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM messages WHERE day_window <= ? ORDER BY ts ASC`, boundaryDayInclusive)
    );
  }

  deleteMessagesOlderThan(boundaryDayInclusive) {
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE day_window <= ?`, boundaryDayInclusive);
  }

  // -------------------------------------------------------------------
  // Memory profile
  // -------------------------------------------------------------------

  getMemoryProfile() {
    const row = rowsOf(this.ctx.storage.sql.exec(`SELECT content FROM memory_profile WHERE id = 1`))[0];
    return row ? row.content : "";
  }

  setMemoryProfile(content) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO memory_profile (id, content, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      content,
      now
    );
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Todos
  // -------------------------------------------------------------------

  createTodo({ title, description = null, dueAt }) {
    if (!title) throw new Error("title is required");
    if (!Number.isFinite(dueAt)) throw new Error("dueAt (epoch ms) is required");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO todos (title, description, due_at, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)`,
      title,
      description,
      dueAt,
      now,
      now
    );
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM todos WHERE id = last_insert_rowid()`))[0];
  }

  listTodos({ status = null } = {}) {
    return status
      ? rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM todos WHERE status = ? ORDER BY due_at ASC`, status))
      : rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM todos ORDER BY due_at ASC`));
  }

  updateTodo(id, patch) {
    const existing = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM todos WHERE id = ?`, id))[0];
    if (!existing) throw new Error(`todo ${id} not found`);
    const merged = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      due_at: Number.isFinite(patch.dueAt) ? patch.dueAt : existing.due_at,
      status: patch.status ?? existing.status,
    };
    this.ctx.storage.sql.exec(
      `UPDATE todos SET title=?, description=?, due_at=?, status=?, updated_at=? WHERE id=?`,
      merged.title,
      merged.description,
      merged.due_at,
      merged.status,
      Date.now(),
      id
    );
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM todos WHERE id = ?`, id))[0];
  }

  deleteTodo(id) {
    this.ctx.storage.sql.exec(`DELETE FROM todos WHERE id = ?`, id);
    return { deleted: true };
  }

  getDueTodos(nowMs = Date.now()) {
    return rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM todos WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC`, nowMs)
    );
  }

  markTodoFired(id) {
    this.ctx.storage.sql.exec(`UPDATE todos SET status='fired', updated_at=? WHERE id=?`, Date.now(), id);
  }

  // -------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------

  getActivePlan() {
    const plan = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1`))[0];
    if (!plan) return null;
    const items = rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position ASC`, plan.id)
    );
    return { plan, items };
  }

  createPlan({ goal, items }) {
    if (!goal) throw new Error("goal is required");
    if (!Array.isArray(items) || items.length === 0) throw new Error("items (non-empty array) is required");
    const existing = this.getActivePlan();
    if (existing) {
      throw new Error(
        `یک برنامه‌ی فعال («${existing.plan.goal}») از قبل وجود داره. اول باید تمومش کنی (تمام آیتم‌ها complete بشن) قبل از ساختن برنامه‌ی جدید.`
      );
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(`INSERT INTO plans (goal, status, created_at) VALUES (?, 'active', ?)`, goal, now);
    const planId = rowsOf(this.ctx.storage.sql.exec(`SELECT last_insert_rowid() as id`))[0].id;
    items.forEach((description, idx) => {
      this.ctx.storage.sql.exec(
        `INSERT INTO plan_items (plan_id, position, description, done, created_at) VALUES (?,?,?,0,?)`,
        planId,
        idx,
        String(description),
        now
      );
    });
    return this.getActivePlan();
  }

  completePlanItem(itemId) {
    const item = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM plan_items WHERE id = ?`, itemId))[0];
    if (!item) throw new Error(`plan item ${itemId} not found`);
    this.ctx.storage.sql.exec(`UPDATE plan_items SET done=1, done_at=? WHERE id=?`, Date.now(), itemId);

    const remaining = rowsOf(
      this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM plan_items WHERE plan_id = ? AND done = 0`, item.plan_id)
    )[0].c;
    let planCompleted = false;
    if (remaining === 0) {
      this.ctx.storage.sql.exec(`UPDATE plans SET status='completed', completed_at=? WHERE id=?`, Date.now(), item.plan_id);
      planCompleted = true;
    }
    return { itemId, planCompleted };
  }

  renderPlanBlock() {
    const active = this.getActivePlan();
    if (!active) return "";
    const lines = active.items.map((it) => `${it.done ? "✅" : "◻️"} ${it.description}`);
    return `برنامه‌ی فعال فعلی («${active.plan.goal}»):\n${lines.join("\n")}`;
  }

  // -------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------

  listSkills({ enabledOnly = true } = {}) {
    return enabledOnly
      ? rowsOf(this.ctx.storage.sql.exec(`SELECT id, name, description, enabled FROM skills WHERE enabled = 1 ORDER BY name ASC`))
      : rowsOf(this.ctx.storage.sql.exec(`SELECT id, name, description, enabled FROM skills ORDER BY name ASC`));
  }

  getSkillBody(name) {
    const row = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM skills WHERE name = ?`, name))[0];
    if (!row) throw new Error(`skill "${name}" not found`);
    return row;
  }

  addSkill({ name, description, body, enabled = true }) {
    if (!name || !description || !body) throw new Error("name, description and body are all required");
    this.ctx.storage.sql.exec(
      `INSERT INTO skills (name, description, body, enabled, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET description=excluded.description, body=excluded.body, enabled=excluded.enabled`,
      name,
      description,
      body,
      enabled ? 1 : 0,
      Date.now()
    );
    return this.getSkillBody(name);
  }

  deleteSkill(name) {
    this.ctx.storage.sql.exec(`DELETE FROM skills WHERE name = ?`, name);
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // Rollups
  // -------------------------------------------------------------------

  getCurrentRollup() {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM rollups WHERE is_current = 1 LIMIT 1`))[0] || null;
  }

  listRollups() {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM rollups ORDER BY id DESC`));
  }

  setCurrentRollup({ coversFromDay, coversToDay, summary, vectorId }) {
    this.ctx.storage.sql.exec(`UPDATE rollups SET is_current = 0 WHERE is_current = 1`);
    this.ctx.storage.sql.exec(
      `INSERT INTO rollups (covers_from_day, covers_to_day, summary, vector_id, is_current, created_at) VALUES (?,?,?,?,1,?)`,
      coversFromDay,
      coversToDay,
      summary,
      vectorId || null,
      Date.now()
    );
    return this.getCurrentRollup();
  }

  getRollupsByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM rollups WHERE id IN (${placeholders})`,
        ...ids
      )
    );
  }

  getRollupsByVectorIds(vectorIds) {
    if (!vectorIds || vectorIds.length === 0) return [];
    const placeholders = vectorIds.map(() => "?").join(",");
    return rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM rollups WHERE vector_id IN (${placeholders})`,
        ...vectorIds
      )
    );
  }

  clearRollups() {
    this.ctx.storage.sql.exec(`DELETE FROM rollups`);
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Small key-value store (rollover cursor, proactive-fire flags, skill
  // wizard state - all keyed by string, all reuse this one table)
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Logs (new) - lets the agent's own tool-call history be inspected via
  // the /logs and /stats bot commands, the same way the router exposes
  // its own request logs. Written by tools/index.js's dispatchTool
  // wrapper and by agentLoop.js at the turn level.
  // -------------------------------------------------------------------

  appendLog({ kind, toolName = null, status, detail = null, latencyMs = null }) {
    this.ctx.storage.sql.exec(
      `INSERT INTO logs (ts, kind, tool_name, status, detail, latency_ms) VALUES (?,?,?,?,?,?)`,
      Date.now(),
      kind,
      toolName,
      status,
      detail ? String(detail).slice(0, 800) : null,
      latencyMs
    );
    const countRow = rowsOf(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM logs`))[0];
    if (countRow && countRow.c > MAX_LOG_ROWS) {
      const toDelete = countRow.c - MAX_LOG_ROWS;
      this.ctx.storage.sql.exec(`DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)`, toDelete);
    }
    return { ok: true };
  }

  getLogs({ limit = 30, status = null } = {}) {
    const lim = Math.max(1, Math.min(300, limit | 0));
    return status
      ? rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM logs WHERE status = ? ORDER BY id DESC LIMIT ?`, status, lim))
      : rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`, lim));
  }

  getStats({ sinceMs = 24 * 3600 * 1000 } = {}) {
    const since = Date.now() - sinceMs;
    const totals = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) as timeouts,
                AVG(latency_ms) as avg_latency_ms
         FROM logs WHERE ts >= ? AND kind='tool_call'`,
        since
      )
    )[0];
    const byTool = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT tool_name,
                COUNT(*) as calls,
                SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) as timeouts
         FROM logs WHERE ts >= ? AND kind='tool_call' GROUP BY tool_name`,
        since
      )
    );
    return { since: new Date(since).toISOString(), totals, by_tool: byTool };
  }

  // -------------------------------------------------------------------
  // Wake schedule
  // -------------------------------------------------------------------

  listWakeSchedule() {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM wake_schedule ORDER BY time_hhmm ASC`));
  }

  addWakeSlot({ timeHHMM, theme }) {
    if (!/^\d{2}:\d{2}$/.test(timeHHMM)) throw new Error("timeHHMM must be in HH:MM format");
    if (!theme) throw new Error("theme is required");
    this.ctx.storage.sql.exec(
      `INSERT INTO wake_schedule (time_hhmm, theme, enabled, created_at) VALUES (?, ?, 1, ?)`,
      timeHHMM,
      theme,
      Date.now()
    );
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM wake_schedule WHERE id = last_insert_rowid()`))[0];
  }

  deleteWakeSlot(id) {
    this.ctx.storage.sql.exec(`DELETE FROM wake_schedule WHERE id = ?`, id);
    return { deleted: true };
  }

  getDueWakeSlots(nowMinutes, today, graceMinutes = 60) {
    const slots = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM wake_schedule WHERE enabled = 1 AND (last_fired_day IS NULL OR last_fired_day != ?)`,
        today
      )
    );
    return slots.filter((slot) => {
      const [h, m] = slot.time_hhmm.split(":").map(Number);
      const slotMinutes = h * 60 + m;
      const diff = nowMinutes - slotMinutes;
      return diff >= 0 && diff < graceMinutes;
    });
  }

  markWakeSlotFired(id, today) {
    this.ctx.storage.sql.exec(`UPDATE wake_schedule SET last_fired_day = ? WHERE id = ?`, today, id);
  }

  // -------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------

  createNote({ title, body }) {
    if (!title || !body) throw new Error("title and body are required");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      title,
      body,
      now,
      now
    );
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes WHERE id = last_insert_rowid()`))[0];
  }

  updateNote(id, { title, body }) {
    const existing = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes WHERE id = ?`, id))[0];
    if (!existing) throw new Error(`note ${id} not found`);
    const newTitle = title !== undefined ? title : existing.title;
    const newBody = body !== undefined ? body : existing.body;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?`,
      newTitle,
      newBody,
      now,
      id
    );
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes WHERE id = ?`, id))[0];
  }

  deleteNote(id) {
    this.ctx.storage.sql.exec(`DELETE FROM notes WHERE id = ?`, id);
    return { deleted: true };
  }

  getNote(id) {
    const row = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes WHERE id = ?`, id))[0];
    if (!row) throw new Error(`note ${id} not found`);
    return row;
  }

  searchNotes({ query, dateFrom, dateTo, dateField = "created", limit = 10 } = {}) {
    const lim = Math.max(1, Math.min(100, limit | 0));
    const conditions = [];
    const params = [];

    const col = dateField === "updated" ? "updated_at" : "created_at";
    if (Number.isFinite(dateFrom)) {
      conditions.push(`${col} >= ?`);
      params.push(dateFrom);
    }
    if (Number.isFinite(dateTo)) {
      conditions.push(`${col} <= ?`);
      params.push(dateTo);
    }

    if (query && typeof query === "string" && query.trim()) {
      const q = query.trim();
      if (this._notesFtsAvailable) {
        try {
          const ftsRows = rowsOf(
            this.ctx.storage.sql.exec(
              `SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?`,
              q
            )
          );
          const ids = ftsRows.map((r) => r.rowid);
          if (ids.length === 0) return [];
          conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
          params.push(...ids);
        } catch {
          // FTS query syntax error fallback
          conditions.push(`(title LIKE ? OR body LIKE ?)`);
          params.push(`%${q}%`, `%${q}%`);
        }
      } else {
        conditions.push(`(title LIKE ? OR body LIKE ?)`);
        params.push(`%${q}%`, `%${q}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(lim);
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes ${whereClause} ORDER BY updated_at DESC LIMIT ?`, ...params));
  }

  listNotesPaginated({ page = 1, pageSize = 8 } = {}) {
    const p = Math.max(1, page | 0);
    const ps = Math.max(1, pageSize | 0);
    const offset = (p - 1) * ps;
    const totalCount = rowsOf(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM notes`))[0].c;
    const totalPages = Math.ceil(totalCount / ps) || 1;
    const notes = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ps, offset));
    return { notes, totalCount, totalPages, page: p, pageSize: ps };
  }

  // -------------------------------------------------------------------
  // Media-group (album) debounce buffer
  //
  // Telegram sends each photo/video of an album as a SEPARATE webhook
  // update sharing one media_group_id. Without buffering, each one would
  // become its own isolated agent turn. Instead: every item that arrives
  // gets appended to a row for its media_group_id, and a Durable Object
  // alarm is scheduled (or moved earlier) for MEDIA_GROUP_DEBOUNCE_MS
  // from now. When the alarm fires, any group whose last item arrived
  // more than the debounce window ago gets flushed as ONE agent turn
  // with all its items as mediaRefs; any group still receiving items
  // gets left alone and the alarm is rescheduled for it.
  // -------------------------------------------------------------------

  async bufferMediaGroupItem({ mediaGroupId, chatId, item, caption }) {
    const now = Date.now();
    const existing = rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM pending_media_groups WHERE media_group_id = ?`, mediaGroupId)
    )[0];

    if (existing) {
      const items = JSON.parse(existing.items);
      items.push(item);
      const newCaption = existing.caption || caption || null;
      this.ctx.storage.sql.exec(
        `UPDATE pending_media_groups SET items=?, caption=?, last_seen_at=? WHERE media_group_id=?`,
        JSON.stringify(items),
        newCaption,
        now,
        mediaGroupId
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_media_groups (media_group_id, chat_id, items, caption, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)`,
        mediaGroupId,
        String(chatId),
        JSON.stringify([item]),
        caption || null,
        now,
        now
      );
    }

    const desiredAlarm = now + MEDIA_GROUP_DEBOUNCE_MS;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || desiredAlarm < currentAlarm) {
      await this.ctx.storage.setAlarm(desiredAlarm);
    }
    return { ok: true };
  }

  async alarm() {
    const now = Date.now();
    const groups = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM pending_media_groups`));
    let nextAlarmAt = null;

    for (const g of groups) {
      if (now - g.last_seen_at >= MEDIA_GROUP_DEBOUNCE_MS) {
        this.ctx.storage.sql.exec(`DELETE FROM pending_media_groups WHERE media_group_id = ?`, g.media_group_id);
        
        if (this.env && this.env.TURNS_QUEUE) {
          await this.env.TURNS_QUEUE.send({
            chatId: g.chat_id,
            trigger: { kind: "user_message", text: g.caption || "", mediaRefs: JSON.parse(g.items) },
          });
        }
      } else {
        const readyAt = g.last_seen_at + MEDIA_GROUP_DEBOUNCE_MS;
        nextAlarmAt = nextAlarmAt ? Math.min(nextAlarmAt, readyAt) : readyAt;
      }
    }

    if (nextAlarmAt) {
      await this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }
}