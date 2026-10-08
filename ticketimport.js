// One-time (re-runnable) import of the old Repair Logger sheet into the repair queue.
// A manager downloads the "Repair Logger" tab as CSV and uploads it here. Rows already in the portal are skipped.
const L = require('./ticketlib');
const tiers = require('./tiers');
const { STATUSES, one, multi } = L;

// --- CSV reader: quotes, doubled quotes, commas and line breaks inside cells, BOM, CRLF ---
function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false, i = 0;
    text = String(text || '').replace(/^﻿/, '');
    for (; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Which status does a free-text "Repair Flow" value mean? '' when we can't tell.
function guessStatus(raw) {
    const s = norm(raw);
    if (!s) return '';
    const exact = STATUSES.find(x => norm(x) === s) || Object.keys(L.OLD).map(k => [norm(k), L.OLD[k]]).find(p => p[0] === s);
    if (exact) return Array.isArray(exact) ? exact[1] : exact;
    if (/unrepair|beyond repair|not repairable|total loss/.test(s)) return 'Unrepairable';
    if (/returned|picked up|given back|handed|delivered|closed|complete[d]?$|^done|finished/.test(s)) return 'Returned to Student';
    if (/ready|pickup|pick up|rfp|repaired/.test(s)) return 'Repaired - Ready for Pickup';
    if (/need.*order|to order|order part/.test(s)) return 'Need to Order Parts';
    if (/part/.test(s)) return 'Awaiting Parts';
    if (/quality|\bqa\b/.test(s)) return 'Quality Assurance Inspection';
    if (/diagnos/.test(s)) return /await|waiting|queue/.test(s) ? 'Awaiting Diagnostic' : 'Diagnostic in Progress';
    if (/in progress|repairing|working/.test(s)) return 'Repair in Progress';
    if (/await.*repair|waiting.*repair|to repair/.test(s)) return 'Awaiting Repair';
    if (/assign|new|intake|check/.test(s)) return 'Awaiting Assignment';
    return '';
}

// 2024-05-03, 5/3/2024 or 5/3/24 -> '2024-05-03 12:00:00'; '' when it is not a date
function dateOf(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else return '';
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2015 || y > 2100) return '';
    const p = n => String(n).padStart(2, '0');
    return y + '-' + p(mo) + '-' + p(d) + ' 12:00:00';
}

// Turns the CSV text into { rows, flows, problem }. Row numbers are record numbers, which match the sheet's own row numbers.
function read(text) {
    const recs = parseCsv(text);
    let h = -1, cols = {};
    for (let r = 0; r < Math.min(6, recs.length) && h < 0; r++) {
        const n = recs[r].map(norm);
        if (n.includes('device model')) {
            h = r;
            const find = fn => { const i = n.findIndex(fn); return i < 0 ? -1 : i; };
            cols = { model: n.indexOf('device model'), serial: find(x => x.includes('serial') || x.includes('asset')), parts: find(x => x === 'necessary' || x.startsWith('necessary')),
                tier: find(x => x === 'repair tier'), flow: find(x => x === 'repair flow'), notes: find(x => x === 'repair notes'),
                complaint: find(x => /complaint|issue|problem/.test(x)), date: find(x => /date/.test(x)) };
        }
    }
    if (h < 0) return { problem: 'I could not find a "Device Model" heading in the first few rows. Download the Repair Logger tab (File > Download > Comma-separated values) and try again.' };
    const get = (rec, k) => cols[k] >= 0 ? String(rec[cols[k]] == null ? '' : rec[cols[k]]).trim() : '';
    const rows = [];
    for (let r = h + 1; r < recs.length; r++) {
        const rec = recs[r], model = get(rec, 'model');
        if (!model) continue;
        rows.push({ row: r + 1, model: one(model, 120), serial: one(get(rec, 'serial'), 40), parts: one(get(rec, 'parts'), 400), tier: one(get(rec, 'tier'), 40), flow: get(rec, 'flow'),
            notes: multi(get(rec, 'notes'), 600), complaint: multi(get(rec, 'complaint'), 600), when: dateOf(get(rec, 'date')) });
    }
    const flows = new Map();
    rows.forEach(x => { const k = x.flow; flows.set(k, (flows.get(k) || 0) + 1); });
    return { rows, flows: [...flows].map(([flow, n]) => ({ flow, n, guess: guessStatus(flow) })).sort((a, b) => b.n - a.n), hasDate: cols.date >= 0 };
}

function mount(app, getDb, wrap, express) {
    async function gate(req, res, json) {
        if (!req.session.userID) { json ? res.status(401).json({ ok: false, error: 'Please sign in again.' }) : res.redirect('/'); return null; }
        if (req.session.admin !== 1) { json ? res.status(403).json({ ok: false, error: 'Managers only.' }) : res.redirect('/dashboard'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        return db;
    }
    const bench = require('./bench');
    const json = express.json({ limit: '6mb' });

    app.get('/bench/import', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        if (!(await bench.hasBench(db, req.session))) return res.redirect('/dashboard');
        const sites = (await db.all('SELECT name FROM sites ORDER BY name')).map(x => x.name);
        res.render('bench_import', { sites, statuses: STATUSES, existing: (await db.get('SELECT COUNT(*) AS n FROM repair_tickets')).n });
    }));

    app.post('/bench/import', json, wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const b = req.body || {};
        const data = read(b.csv);
        if (data.problem) return res.json({ ok: false, error: data.problem });
        const have = new Set((await db.all('SELECT sheet_row FROM repair_tickets WHERE sheet_row IS NOT NULL')).map(x => x.sheet_row));
        const fresh = data.rows.filter(x => !have.has(x.row));
        const skipped = data.rows.length - fresh.length;
        if (!b.go) {      // preview
            const flows = new Map();
            fresh.forEach(x => flows.set(x.flow, (flows.get(x.flow) || 0) + 1));
            return res.json({ ok: true, total: data.rows.length, fresh: fresh.length, skipped, hasDate: data.hasDate,
                flows: [...flows].map(([flow, n]) => ({ flow, n, guess: guessStatus(flow) })).sort((a, c) => c.n - a.n) });
        }
        const map = b.map && typeof b.map === 'object' ? b.map : {};
        const fallback = STATUSES.includes(b.fallback) ? b.fallback : 'Returned to Student';
        const site = one(b.site, 60);
        if (site && !(await db.get('SELECT 1 AS x FROM sites WHERE name = ?', [site]))) return res.json({ ok: false, error: 'That school was not found.' });
        const who = req.session.name || '';
        let made = 0;
        await db.run('BEGIN');
        try {
            for (const x of fresh) {
                const pick = Object.prototype.hasOwnProperty.call(map, x.flow) ? map[x.flow] : '';
                const status = STATUSES.includes(pick) ? pick : (guessStatus(x.flow) || fallback);
                let tier = x.tier;
                if (!tiers.num(tier)) { const g = tiers.classify(tiers.splitParts(x.parts), ''); tier = g.tier ? tiers.label(g.tier) : ''; } else tier = tiers.label(tiers.num(tier));
                const closed = L.CLOSED.includes(status);
                const when = x.when || null;
                const r = await db.run(
                    `INSERT INTO repair_tickets (created_at, updated_at, closed_at, created_by, created_by_name, model, serial, complaint, parts, tier, priority, status, source, sheet_row, site_name)
                     VALUES (COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP), CASE WHEN ? THEN COALESCE(?, CURRENT_TIMESTAMP) END, ?,?,?,?,?,?,?, 'Normal', ?, 'import', ?, ?)`,
                    [when, when, closed ? 1 : 0, when, req.session.userID, who, x.model, x.serial, x.complaint || x.notes || 'Imported from the Repair Logger sheet', x.parts, tier, status, x.row, site]);
                await db.run('INSERT INTO ticket_events (ticket_id, at, user_id, user_name, kind, text) VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?,?,?,?)',
                    [r.lastID, when, req.session.userID, who, 'created', 'Imported from the Repair Logger sheet (row ' + x.row + ')']);
                if (status !== L.FIRST) await db.run('INSERT INTO ticket_events (ticket_id, at, user_id, user_name, kind, text) VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?,?,?,?)',
                    [r.lastID, when, req.session.userID, who, 'status', L.FIRST + ' → ' + status]);
                made++;
            }
            await db.run('COMMIT');
        } catch (e) { try { await db.run('ROLLBACK'); } catch (e2) {} throw e; }
        res.json({ ok: true, made, skipped });
    }));
}

module.exports = mount;
module.exports.read = read;
module.exports.guessStatus = guessStatus;
module.exports.parseCsv = parseCsv;
