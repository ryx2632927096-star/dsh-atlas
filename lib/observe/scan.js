import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { atlasRoot, sessionsRoot, DB_FILE } from '../core/paths.js'
import { parseSessionText } from '../core/parse.js'

export function findSessionFiles(root = sessionsRoot()) {
  const out = []
  if (!existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.zstd')) out.push(full)
    }
  }
  walk(root)
  return out
}

export function readSessionFile(file) {
  const buf = readFileSync(file)
  const raw = zlib.zstdDecompressSync(buf)
  return raw.toString('utf8')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  dir TEXT,
  cwd TEXT,
  preset TEXT,
  version INTEGER,
  created_at INTEGER,
  file TEXT,
  records INTEGER DEFAULT 0,
  events INTEGER DEFAULT 0,
  human_msgs INTEGER DEFAULT 0,
  injected_msgs INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  scanned_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER,
  type TEXT NOT NULL,
  tool TEXT,
  call_id TEXT,
  summary TEXT,
  arg_shape TEXT,
  duration_ms INTEGER,
  is_error INTEGER,
  text_len INTEGER,
  injected INTEGER DEFAULT 0,
  source_kind TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_error ON events(is_error) WHERE is_error = 1;
-- 宿主实际下发给模型的工具面（来自 request/header）。
-- 与 events 里的 tool/call 是两件事：
--   declared_tools = 「DS 知道存在什么工具」
--   events.tool/call = 「DS 真的用了什么工具」
-- 两者求差就是「知道但不会用/不敢用」的那批工具，这是本项目的核心判据之一。
CREATE TABLE IF NOT EXISTS declared_tools (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  first_seq INTEGER,
  first_time INTEGER,
  PRIMARY KEY (session_id, name)
);
CREATE TABLE IF NOT EXISTS watermarks (
  file TEXT PRIMARY KEY,
  size INTEGER,
  mtime_ms INTEGER,
  session_id TEXT,
  events INTEGER,
  scanned_at INTEGER
);
`

function migrateSchema(db) {
  const wanted = [
    { table: 'events', column: 'arg_shape', type: 'TEXT' },
    { table: 'events', column: 'duration_ms', type: 'INTEGER' },
  ]
  for (const { table, column, type } of wanted) {
    let columns
    try {
      columns = db.prepare(`PRAGMA table_info(${table})`).all()
    } catch { continue }
    if (!columns.length) continue
    if (columns.some((c) => c.name === column)) continue
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`) } catch {   }
  }
}

export function openDb(root = atlasRoot()) {
  const file = join(root, DB_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  migrateSchema(db)
  return db
}

export function scan(options = {}) {
  const root = options.root || atlasRoot()
  const started = Date.now()
  const db = openDb(root)
  const files = findSessionFiles(options.sessionsRoot || sessionsRoot())

  const getWm = db.prepare('SELECT size, mtime_ms, session_id FROM watermarks WHERE file = ?')
  const putWm = db.prepare(
    'INSERT INTO watermarks(file,size,mtime_ms,session_id,events,scanned_at) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(file) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, ' +
    'session_id=excluded.session_id, events=excluded.events, scanned_at=excluded.scanned_at'
  )
  const putSession = db.prepare(
    'INSERT INTO sessions(id,dir,cwd,preset,version,created_at,file,records,events,human_msgs,injected_msgs,tool_calls,errors,scanned_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
    'cwd=excluded.cwd, preset=excluded.preset, version=excluded.version, file=excluded.file, ' +
    'records=excluded.records, events=excluded.events, human_msgs=excluded.human_msgs, ' +
    'injected_msgs=excluded.injected_msgs, tool_calls=excluded.tool_calls, errors=excluded.errors, ' +
    'scanned_at=excluded.scanned_at'
  )
  const putDeclared = db.prepare(
    'INSERT INTO declared_tools(session_id,name,description,first_seq,first_time) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(session_id,name) DO UPDATE SET description=excluded.description'
  )
  const putEvent = db.prepare(
    'INSERT OR REPLACE INTO events(session_id,seq,time,type,tool,call_id,summary,arg_shape,duration_ms,is_error,text_len,injected,source_kind) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  )

  const result = {
    files: files.length,
    scanned: 0,
    skipped: 0,
    failed: 0,
    unsupported: 0,
    events: 0,
    humanMessages: 0,
    injectedMessages: 0,
    toolCalls: 0,
    errors: 0,
    unresolvedResults: 0,
    declaredTools: 0,
    elapsedMs: 0,
    failures: [],
    pruned: { sessions: 0, events: 0 },
  }

  try {
    const cleaned = pruneMissing(db, files)
    result.pruned = cleaned
  } catch (error) {
    result.failures.push({ file: '(prune)', reason: String(error?.message || error) })
  }

  try {
    for (const file of files) {
      let stat
      try { stat = statSync(file) } catch { result.failed++; continue }
      if (!options.full) {
        const wm = getWm.get(file)
        if (wm && wm.size === stat.size && wm.mtime_ms === Math.floor(stat.mtimeMs)) {
          result.skipped++
          continue
        }
      }

      let text
      try { text = readSessionFile(file) } catch (error) {
        result.failed++
        result.failures.push({ file, reason: String(error?.message || error) })
        continue
      }

      const parsed = parseSessionText(text)
      if (!parsed.ok) {
        result.unsupported++
        result.failures.push({ file, reason: parsed.reason })
        putWm.run(file, stat.size, Math.floor(stat.mtimeMs), parsed.header?.id || null, 0, Date.now())
        continue
      }

      const header = parsed.header || {}
      const sessionId = header.id || file
      const dirMatch = /session-[0-9a-f-]{36}/i.exec(file)

      db.exec('BEGIN')
      try {
        putSession.run(
          sessionId,
          dirMatch ? dirMatch[0].toLowerCase() : null,
          header.cwd || null,
          header.agentPreset || null,
          header.version || null,
          header.createdAt || null,
          file,
          parsed.stats.records,
          parsed.events.length,
          parsed.stats.humanMessages,
          parsed.stats.injectedMessages,
          parsed.stats.toolCalls,
          parsed.stats.errors,
          Date.now()
        )

        for (const d of parsed.declared || []) {
          putDeclared.run(sessionId, d.name, d.description, d.seq, d.time)
        }

        for (const event of parsed.events) {
          if (event.seq === null) continue
          putEvent.run(
            sessionId,
            event.seq,
            event.time,
            event.type,
            event.tool,
            event.callId,
            event.summary,
            event.argShape || null,
            event.durationMs === null || event.durationMs === undefined ? null : event.durationMs,
            event.isError === null ? null : (event.isError ? 1 : 0),
            event.textLen,
            event.injected ? 1 : 0,
            event.sourceKind || null
          )
        }

        putWm.run(file, stat.size, Math.floor(stat.mtimeMs), sessionId, parsed.events.length, Date.now())
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {   }
        result.failed++
        result.failures.push({ file, reason: String(error?.message || error) })
        continue
      }

      result.scanned++
      result.events += parsed.events.length
      result.humanMessages += parsed.stats.humanMessages
      result.injectedMessages += parsed.stats.injectedMessages
      result.toolCalls += parsed.stats.toolCalls
      result.errors += parsed.stats.errors
      result.unresolvedResults += parsed.stats.unresolvedResults

      if (options.onProgress) {
        try { options.onProgress({ file, sessionId, events: parsed.events.length }) } catch {   }
      }
    }
  } catch (error) {
    result.failures.push({ file: '(scan-loop)', reason: String(error?.message || error) })
    result.failed++
  } finally {
    result.elapsedMs = Date.now() - started
    writeMeta(root, result)
    try { db.close() } catch {   }
  }

  return result
}

export function pruneMissing(db, liveFiles) {
  const live = new Set(liveFiles)
  const keep = new Set()
  let sessions = 0
  let events = 0

  const rows = db.prepare('SELECT id, file FROM sessions').all()
  const delEvents = db.prepare('DELETE FROM events WHERE session_id = ?')
  const delDeclared = db.prepare('DELETE FROM declared_tools WHERE session_id = ?')
  const delSession = db.prepare('DELETE FROM sessions WHERE id = ?')
  for (const row of rows) {
    if (live.has(row.file)) { keep.add(row.id); continue }
    events += delEvents.run(row.id).changes
    delDeclared.run(row.id)
    sessions += delSession.run(row.id).changes
  }

  const delWm = db.prepare('DELETE FROM watermarks WHERE file = ?')
  for (const wm of db.prepare('SELECT file, session_id FROM watermarks').all()) {
    if (!live.has(wm.file)) delWm.run(wm.file)
    else if (wm.session_id && !keep.has(wm.session_id) && !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(wm.session_id)) {
      delWm.run(wm.file)
    }
  }

  return { sessions, events }
}

export function toolSurface(db) {
  const declared = db.prepare(`
    SELECT name, MAX(description) AS description, COUNT(DISTINCT session_id) AS sessions
    FROM declared_tools GROUP BY name
  `).all()
  const called = db.prepare(`
    SELECT tool AS name, COUNT(*) AS calls,
           SUM(CASE WHEN type='tool/result' AND is_error=1 THEN 1 ELSE 0 END) AS errors
    FROM events WHERE tool IS NOT NULL GROUP BY tool
  `).all()
  const byName = new Map()
  for (const d of declared) {
    byName.set(d.name, {
      name: d.name,
      description: d.description || '',
      sessions: d.sessions || 0,
      calls: 0,
      errors: 0,
      declared: true,
    })
  }
  for (const c of called) {
    const cur = byName.get(c.name)
    if (cur) {
      cur.calls = c.calls || 0
      cur.errors = c.errors || 0
    } else {
      byName.set(c.name, {
        name: c.name,
        description: '',
        sessions: 0,
        calls: c.calls || 0,
        errors: c.errors || 0,
        declared: false,
      })
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls)
}

function writeMeta(root, result) {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'last-scan.json'), JSON.stringify({ ...result, at: Date.now() }, null, 2))
  } catch {   }
}

export function summary(root = atlasRoot()) {
  const db = openDb(root)
  try {
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM events WHERE type = 'tool/call') AS tool_calls,
        (SELECT COUNT(*) FROM events WHERE type = 'tool/result') AS tool_results,
        (SELECT COUNT(*) FROM events WHERE is_error = 1) AS errors,
        (SELECT COUNT(*) FROM events WHERE type = 'user/message' AND injected = 0) AS human_messages,
        (SELECT COUNT(*) FROM events WHERE type = 'user/message' AND injected = 1) AS injected_messages,
        (SELECT COUNT(DISTINCT tool) FROM events WHERE type = 'tool/call') AS distinct_tools
    `).get()
    const topTools = db.prepare(`
      SELECT
        c.tool AS tool,
        c.calls AS calls,
        COALESCE(e.errors, 0) AS errors
      FROM (
        SELECT tool, COUNT(*) AS calls FROM events
        WHERE type = 'tool/call' AND tool IS NOT NULL
        GROUP BY tool
      ) c
      LEFT JOIN (
        SELECT tool, COUNT(*) AS errors FROM events
        WHERE type = 'tool/result' AND tool IS NOT NULL AND is_error = 1
        GROUP BY tool
      ) e ON e.tool = c.tool
      ORDER BY c.calls DESC LIMIT 20
    `).all()
    return { totals, topTools }
  } finally {
    try { db.close() } catch {   }
  }
}
