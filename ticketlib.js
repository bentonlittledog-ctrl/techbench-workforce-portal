// Shared pieces for the repair queue, dashboard, photos and email alerts.
const path = require('path');
const fs = require('fs');

const STATUSES = ['Awaiting Assignment', 'Awaiting Diagnostic', 'Awaiting Repair', 'Awaiting Parts', 'Diagnostic in Progress', 'Quality Assurance Inspection',
    'Repair in Progress', 'Need to Order Parts', 'Repaired - Ready for Pickup', 'Unrepairable', 'Returned to Student'];
const CLOSED = ['Unrepairable', 'Returned to Student'];
const GRADES = ['6', '7', '8', '9', '10', '11', '12', 'Other'];
const FIRST = 'Awaiting Assignment', READY = 'Repaired - Ready for Pickup', PARTS = ['Awaiting Parts', 'Need to Order Parts'];
const STUCK_STATUSES = ['Awaiting Assignment', 'Awaiting Parts', 'Need to Order Parts'];   // flagged when they sit too long
const STUCK_DAYS = () => Math.max(1, parseInt(process.env.STUCK_DAYS, 10) || 3);
const OLD = { 'New': FIRST, 'Diagnosing': 'Diagnostic in Progress', 'Waiting on parts': 'Awaiting Parts', 'In repair': 'Repair in Progress', 'Testing': 'Quality Assurance Inspection', 'Ready to return': READY, 'Returned': 'Returned to Student' };
const PRIORITIES = ['Normal', 'High'];
const PROGRAM = 'Student Tech Work Bench';

const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const multi = (s, n) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n || 1000);
const tone = s => s === READY || s === 'Returned to Student' ? 'ok' : PARTS.includes(s) || s === 'Unrepairable' ? 'warn' : s === FIRST ? 'bad' : '';
const sid = s => String(s == null ? '' : s).trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
const nameOf = t => [t.student_first, t.student_last].filter(Boolean).join(' ');
const isEmail = s => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(String(s || '')) && String(s).length <= 120;

const parse = ts => { const d = new Date(String(ts || '').replace(' ', 'T') + (/[zZ]$/.test(String(ts)) ? '' : 'Z')); return isNaN(d) ? null : d; };
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// "2026-10-07 19:20:00" (UTC from SQLite) -> Mountain time, readable
const fmt = ts => {
    const d = parse(ts); if (!d) return ts ? String(ts) : '';
    return d.toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const ageDays = (ts, end) => {
    const a = parse(ts), b = end ? parse(end) : new Date();
    return a && b ? Math.max(0, Math.floor((b - a) / 86400000)) : 0;
};
const day = ts => { const d = parse(ts); return d ? d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) : ''; };   // YYYY-MM-DD in Mountain time
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const human = ms => {                       // 3d 4h / 5h 20m / 12m
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + mi + 'm' : mi + 'm';
};

// ---------- schema ----------
const ready = new WeakMap();
function ensureSchema(db) {
    if (!ready.has(db)) {
        const p = (async () => {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS repair_tickets (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  closed_at TEXT,
                  created_by INTEGER, created_by_name TEXT,
                  model TEXT NOT NULL, serial TEXT DEFAULT '',
                  complaint TEXT DEFAULT '', parts TEXT DEFAULT '', tier TEXT DEFAULT '',
                  priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Awaiting Assignment',
                  student_first TEXT DEFAULT '', student_last TEXT DEFAULT '', student_id TEXT DEFAULT '', student_grade TEXT DEFAULT '',
                  site_name TEXT DEFAULT '', notify_email TEXT DEFAULT '', notified_at TEXT,
                  assigned_to INTEGER, assigned_name TEXT DEFAULT '',
                  source TEXT DEFAULT 'form', sheet_row INTEGER, client_ref TEXT UNIQUE
                );
                CREATE TABLE IF NOT EXISTS ticket_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ticket_id INTEGER NOT NULL,
                  at TEXT DEFAULT CURRENT_TIMESTAMP,
                  user_id INTEGER, user_name TEXT,
                  kind TEXT NOT NULL, text TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS ticket_photos (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ticket_id INTEGER NOT NULL,
                  file TEXT NOT NULL UNIQUE, caption TEXT DEFAULT '',
                  uploaded_by INTEGER, uploaded_by_name TEXT DEFAULT '',
                  at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT '');
                CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);
                CREATE TABLE IF NOT EXISTS parts_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, on_hand INTEGER NOT NULL DEFAULT 0, min_stock INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
                CREATE TABLE IF NOT EXISTS ticket_parts_used (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, part TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, at TEXT DEFAULT CURRENT_TIMESTAMP, by_id INTEGER, by_name TEXT DEFAULT '');
                CREATE TABLE IF NOT EXISTS student_skills (employee_id INTEGER NOT NULL, skill TEXT NOT NULL, signed_by INTEGER, signed_name TEXT DEFAULT '', at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (employee_id, skill));
                CREATE INDEX IF NOT EXISTS idx_partsused_ticket ON ticket_parts_used(ticket_id);
                CREATE INDEX IF NOT EXISTS idx_tickets_status ON repair_tickets(status);
                CREATE INDEX IF NOT EXISTS idx_tickets_serial ON repair_tickets(serial);
                CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);
                CREATE INDEX IF NOT EXISTS idx_photos_ticket ON ticket_photos(ticket_id);`);
            const cols = (await db.all('PRAGMA table_info(repair_tickets)')).map(c => c.name);
            for (const c of ['student_first', 'student_last', 'student_id', 'student_grade', 'site_name', 'notify_email']) {
                if (!cols.includes(c)) await db.exec(`ALTER TABLE repair_tickets ADD COLUMN ${c} TEXT DEFAULT ''`);
            }
            if (!cols.includes('notified_at')) await db.exec('ALTER TABLE repair_tickets ADD COLUMN notified_at TEXT');
            for (const [c, def] of [['status_token', 'TEXT'], ['mentor_id', 'INTEGER'], ['mentor_name', "TEXT DEFAULT ''"], ['mentor_at', 'TEXT'], ['pickup_by', "TEXT DEFAULT ''"],
                ['pickup_rel', "TEXT DEFAULT ''"], ['pickup_at', 'TEXT'], ['pickup_note', "TEXT DEFAULT ''"], ['pickup_id_checked', 'INTEGER DEFAULT 0']]) {
                if (!cols.includes(c)) await db.exec(`ALTER TABLE repair_tickets ADD COLUMN ${c} ${def}`);
            }
            for (const k of Object.keys(OLD)) await db.run('UPDATE repair_tickets SET status = ? WHERE status = ?', [OLD[k], k]);   // statuses renamed earlier
            // tickets made before sites were recorded: use the creator's school when they have exactly one
            const blanks = await db.all("SELECT id, created_by FROM repair_tickets WHERE (site_name IS NULL OR site_name = '') AND created_by IS NOT NULL").catch(() => []);
            for (const b of blanks) {
                const s = await siteForUser(db, b.created_by).catch(() => '');
                if (s) await db.run('UPDATE repair_tickets SET site_name = ? WHERE id = ?', [s, b.id]);
            }
        })().catch(err => { ready.delete(db); throw err; });
        ready.set(db, p);
    }
    return ready.get(db);
}

// The one school this person works at (or manages) in the Tech Bench; '' when none or several.
async function siteForUser(db, userID) {
    if (!userID) return '';
    const pid = (await db.get('SELECT id FROM programs WHERE name = ?', [PROGRAM]) || {}).id;
    if (!pid) return '';
    const rows = await db.all(`SELECT DISTINCT s.name FROM sites s WHERE s.id IN (SELECT site_id FROM memberships WHERE employee_id = ? AND program_id = ?
        UNION SELECT site_id FROM scopes WHERE employee_id = ? AND (program_id = ? OR program_id IS NULL))`, [userID, pid, userID, pid]);
    return rows.length === 1 ? rows[0].name : '';
}

// ---------- status history ----------
const statusEvents = events => (events || []).filter(e => e.kind === 'status').map(e => {
    const parts = String(e.text || '').split('→').map(x => x.trim());
    const m = s => OLD[s] || s;
    return { at: e.at, from: m(parts[0] || ''), to: m(parts[1] || '') };
});
// How long the ticket spent in each status. events: that ticket's events, oldest first.
function timeline(t, events, now) {
    now = now || new Date();
    const evs = statusEvents(events);
    const segs = [];
    let cur = { status: evs.length ? evs[0].from : t.status, from: t.created_at };
    for (const e of evs) { segs.push(Object.assign(cur, { to: e.at })); cur = { status: e.to, from: e.at }; }
    const end = CLOSED.includes(t.status) && t.closed_at ? t.closed_at : null;
    if (!CLOSED.includes(cur.status)) segs.push(Object.assign(cur, { to: end || null }));
    const out = segs.map(s => {
        const a = parse(s.from), b = s.to ? parse(s.to) : now;
        return { status: s.status, from: s.from, to: s.to, ms: a && b ? Math.max(0, b - a) : 0, current: !s.to };
    });
    const totals = {};
    out.forEach(s => { totals[s.status] = (totals[s.status] || 0) + s.ms; });
    return { segments: out, totals: Object.keys(totals).map(k => ({ status: k, ms: totals[k], text: human(totals[k]) })) };
}
// When the repair first reached "ready for pickup" (or, failing that, when the ticket closed).
function repairedAt(t, events) {
    const e = statusEvents(events).find(x => x.to === READY);
    if (e) return e.at;
    return CLOSED.includes(t.status) && t.status !== 'Unrepairable' ? t.closed_at : null;
}
// Days the ticket has sat in its current status, or 0 when that status is not one we chase.
const stuckFor = (t, lastChangeAt, now) => {
    if (!STUCK_STATUSES.includes(t.status)) return 0;
    const a = parse(lastChangeAt || t.created_at), b = now || new Date();
    const d = a ? Math.floor((b - a) / 86400000) : 0;
    return d >= STUCK_DAYS() ? d : 0;
};
const lastChanges = async db => {
    const m = new Map();
    (await db.all("SELECT ticket_id, MAX(at) AS at FROM ticket_events WHERE kind = 'status' GROUP BY ticket_id")).forEach(r => m.set(r.ticket_id, r.at));
    return m;
};
// serial -> how many tickets that device has had
const repeatMap = async db => {
    const m = new Map();
    (await db.all("SELECT lower(serial) AS s, COUNT(*) AS n FROM repair_tickets WHERE serial IS NOT NULL AND serial NOT IN ('', 'Unknown') GROUP BY lower(serial) HAVING COUNT(*) > 1")).forEach(r => m.set(r.s, r.n));
    return m;
};

// ---------- photos on disk ----------
const uploadDir = () => path.join(path.dirname(path.resolve(process.env.DB_PATH || './timecards.db')), 'ticket-uploads');
async function removePhotos(db, ticketId) {
    const rows = await db.all('SELECT file FROM ticket_photos WHERE ticket_id = ?', [ticketId]);
    for (const r of rows) await fs.promises.unlink(path.join(uploadDir(), r.file)).catch(() => {});
    await db.run('DELETE FROM ticket_photos WHERE ticket_id = ?', [ticketId]);
}

async function benchPeople(db) {
    const pid = (await db.get('SELECT id FROM programs WHERE name = ?', [PROGRAM]) || {}).id;
    if (!pid) return [];
    return db.all(`SELECT DISTINCT e.id, e.name FROM employees e
        WHERE e.id IN (SELECT employee_id FROM memberships WHERE program_id = ?)
           OR e.id IN (SELECT employee_id FROM scopes WHERE program_id = ? OR program_id IS NULL)
        ORDER BY e.name`, [pid, pid]);
}
const csvCell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// ---------- settings, audit trail, skills ----------
const getSetting = async (db, key, def) => { const r = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]); return r && r.value != null ? r.value : def; };
const setSetting = (db, key, value, who) => db.run('INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,CURRENT_TIMESTAMP,?)', [key, String(value), who || '']);
const flag = async (db, key, def) => (await getSetting(db, key, def ? '1' : '0')) === '1';
// One line in the district audit log. `session` may be null for system actions.
const audit = (db, session, action, details, target) => db.run(
    'INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
    [session ? session.userID : null, session ? (session.name || '') : 'System', target && target.id != null ? target.id : null, target && target.name || '', action, String(details || '').slice(0, 500), '']);

// What a student can be signed off on. `re` decides which parts need the skill.
const SKILLS = [
    { key: 'diag', name: 'Diagnostics', re: null },
    { key: 'screen', name: 'Screens and displays', re: /screen|lcd|display|digitizer|bezel/i },
    { key: 'battery', name: 'Batteries', re: /batter/i },
    { key: 'keyboard', name: 'Keyboards, palmrests and trackpads', re: /keyboard|palm ?rest|track ?pad/i },
    { key: 'hinge', name: 'Hinges and covers', re: /hinge|cover|chassis|housing|body damage/i },
    { key: 'camera', name: 'Cameras', re: /camera|webcam/i },
    { key: 'board', name: 'Motherboards and daughterboards', re: /mother ?board|daughter ?board|logic board/i },
    { key: 'power', name: 'Charging and power', re: /charg|adapter|dc jack|power/i },
    { key: 'audio', name: 'Speakers', re: /speaker|audio/i },
    { key: 'mentor', name: 'Mentor (can check off other students’ repairs)', re: null }
];
const skillsForParts = text => { const t = String(text || ''); return SKILLS.filter(k => k.re && k.re.test(t)).map(k => k.key); };
const skillName = key => (SKILLS.find(k => k.key === key) || {}).name || key;
// Hours between two UTC stamps
const hoursBetween = (a, b) => { const x = parse(a), y = parse(b); return x && y ? Math.max(0, (y - x) / 3600000) : 0; };

module.exports = {
    getSetting, setSetting, flag, audit, SKILLS, skillsForParts, skillName, hoursBetween,
    benchPeople, csvCell,
    STATUSES, CLOSED, GRADES, FIRST, READY, PARTS, STUCK_STATUSES, STUCK_DAYS, OLD, PRIORITIES, PROGRAM,
    one, multi, tone, sid, nameOf, isEmail, parse, sqlNow, fmt, ageDays, day, isDate, human,
    ensureSchema, siteForUser, statusEvents, timeline, repairedAt, stuckFor, lastChanges, repeatMap, uploadDir, removePhotos
};
