// bench.js - Student Tech Work Bench tools: order a part and log a repair, written straight into the master Google Sheet
// through the Apps Script web app (see appsscript/Code.gs and sheet.js). Only people in the Tech Bench program can use them.
const fs = require('fs');
const path = require('path');
const sheet = require('./sheet');
const { programAccess } = require('./education');

const PROGRAM = 'Student Tech Work Bench';
// Used only until the sheet's own dropdown lists can be read.
const FALLBACK_PARTS = ['LCD Screen (Display)', 'LCD Bezel', 'LCD (Display) Cable', 'Battery', 'Motherboard', 'Trackpad', 'Trackpad Cable', 'Palmrest- with Keyboard',
    'Palmrest - No Keyboard/Trackpad', 'Keyboard (No Palmrest)', 'Camera', 'Camera Cable', 'Camera - CTL (Multiple Parts)', 'Hinge Cover', 'Speakers', 'Top Cover', 'Bottom Cover', 'AC Adapter'];
const TIERS = ['Tier 1', 'Tier 2', 'Tier 3'];
const FLOWS = ['Diagnostic', 'Awaiting Parts', 'Awaiting Repair', 'Repaired'];

const first = (...arrs) => arrs.find(a => Array.isArray(a) && a.length) || [];
const one = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

async function benchProgramId(db) {
    const r = await db.get('SELECT id FROM programs WHERE name = ?', [PROGRAM]);
    return r ? r.id : null;
}
async function hasBench(db, s) {
    if (!s || !s.userID) return false;
    const id = await benchProgramId(db);
    if (!id) return false;
    const acc = await programAccess(db, s);
    return acc.all || acc.ids.includes(id);
}

function mount(app, getDb, wrap) {
    let ready = null, cache = null;
    const inflight = new Set();
    async function database() {
        const db = getDb();
        if (!ready) {
            ready = db.exec(`
                CREATE TABLE IF NOT EXISTS sheet_submissions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  at TEXT DEFAULT CURRENT_TIMESTAMP,
                  user_id INTEGER, user_name TEXT,
                  kind TEXT NOT NULL, summary TEXT NOT NULL,
                  status TEXT NOT NULL, error TEXT DEFAULT '', row_no INTEGER
                )`).catch(err => { ready = null; throw err; });
        }
        await ready;
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    // gate: signed in + in the Tech Bench program
    async function gate(req, res) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = await database();
        if (!(await hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        return db;
    }

    async function lists(db, force) {
        if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.data;
        let live = null, error = '';
        if (sheet.configured()) {
            try { live = (await sheet.call('lists')).lists || null; } catch (e) { error = e.message; }
        }
        const tb = await benchProgramId(db);
        const devs = (await db.all('SELECT name FROM devices WHERE program_id = ? ORDER BY brand, name', [tb])).map(d => d.name);
        const data = {
            live: !!live, error,
            orderModels: first(live && live.orderModels, devs),
            orderParts: first(live && live.orderParts, FALLBACK_PARTS),
            repairModels: first(live && live.repairModels, live && live.orderModels, devs),
            repairParts: first(live && live.repairParts, live && live.orderParts, FALLBACK_PARTS),
            tiers: first(live && live.tiers, TIERS),
            flows: first(live && live.flows, FLOWS)
        };
        cache = { at: Date.now(), ttl: live ? 10 * 60e3 : 60e3, data };
        return data;
    }

    const recentOf = (db, kind) => db.all(
        `SELECT datetime(at, 'localtime') AS at, user_name, summary, status, error, row_no FROM sheet_submissions WHERE kind = ? ORDER BY id DESC LIMIT 15`, [kind]);

    // Sends one row to the sheet and records the attempt. Returns { ok, message }.
    async function submit(db, req, kind, values, summary) {
        const dupe = await db.get(
            `SELECT 1 FROM sheet_submissions WHERE user_id = ? AND kind = ? AND summary = ? AND status = 'ok' AND at > datetime('now', '-30 seconds')`,
            [req.session.userID, kind, summary]);
        if (dupe) return { ok: false, message: 'That was just submitted. Check the list below before sending it again.' };
        const key = req.session.userID + '|' + kind + '|' + summary;
        if (inflight.has(key)) return { ok: false, message: 'That is already being sent.' };
        inflight.add(key);
        let row = null;
        try {
            const r = await sheet.call(kind, values);
            row = r.row || null;
        } catch (e) {
            inflight.delete(key);
            await db.run('INSERT INTO sheet_submissions (user_id, user_name, kind, summary, status, error) VALUES (?,?,?,?,?,?)',
                [req.session.userID, req.session.name || '', kind, summary, 'failed', e.message]);
            return { ok: false, message: 'Not saved to the sheet: ' + e.message };
        }
        await db.run('INSERT INTO sheet_submissions (user_id, user_name, kind, summary, status, row_no) VALUES (?,?,?,?,?,?)',
            [req.session.userID, req.session.name || '', kind, summary, 'ok', row]);
        inflight.delete(key);
        return { ok: true, message: 'Added to the ' + (kind === 'order' ? 'Order Sheet' : 'Repair Logger') + (row ? ' (row ' + row + ')' : '') + '.' };
    }

    // ---------- Order a part ----------
    app.get('/bench/order', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const l = await lists(db, req.query.refresh === '1');
        res.render('bench_order', { flash: takeFlash(req), configured: sheet.configured(), l, recent: await recentOf(db, 'order'), isAdmin: req.session.admin === 1 });
    }));

    app.post('/bench/order', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const l = await lists(db);
        const b = req.body || {};
        const model = one(b.model), part = one(b.part), notes = one(b.notes).slice(0, 200);
        const qty = /^\d{1,2}$/.test(one(b.qty)) ? parseInt(b.qty, 10) : NaN;
        if (!sheet.configured()) flash(req, 'The sheet connection is not set up yet.', true);
        else if (!l.orderModels.includes(model)) flash(req, 'Choose the device model from the list.', true);
        else if (!l.orderParts.includes(part)) flash(req, 'Choose the part from the list.', true);
        else if (!(qty >= 1 && qty <= 99)) flash(req, 'Quantity must be a whole number from 1 to 99.', true);
        else {
            const r = await submit(db, req, 'order', { model, part, qty, notes }, model + ' | ' + part + ' x' + qty + (notes ? ' | ' + notes : ''));
            flash(req, r.message, !r.ok);
        }
        res.redirect('/bench/order');
    }));

    // ---------- Log a repair ----------
    app.get('/bench/repair', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const l = await lists(db, req.query.refresh === '1');
        res.render('bench_repair', { flash: takeFlash(req), configured: sheet.configured(), l, recent: await recentOf(db, 'repair'), isAdmin: req.session.admin === 1 });
    }));

    app.post('/bench/repair', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const l = await lists(db);
        const b = req.body || {};
        const model = one(b.model), serial = one(b.serial).slice(0, 40) || 'Unknown', tier = one(b.tier), flowv = one(b.flow), notes = one(b.notes).slice(0, 600);
        const picked = [].concat(b.parts || []).map(one).filter(Boolean);
        const parts = l.repairParts.filter(p => picked.includes(p));
        if (!sheet.configured()) flash(req, 'The sheet connection is not set up yet.', true);
        else if (!l.repairModels.includes(model)) flash(req, 'Choose the device model from the list.', true);
        else if (picked.length !== parts.length) flash(req, 'One of the parts is not in the sheet\'s list.', true);
        else if (!l.tiers.includes(tier)) flash(req, 'Choose the repair tier.', true);
        else if (!l.flows.includes(flowv)) flash(req, 'Choose the repair status.', true);
        else {
            const r = await submit(db, req, 'repair', { model, serial, parts: parts.join(', '), tier, flow: flowv, notes },
                model + ' | ' + serial + ' | ' + (parts.join(', ') || 'no parts') + ' | ' + tier + ' | ' + flowv + (notes ? ' | ' + notes : ''));
            flash(req, r.message, !r.ok);
        }
        res.redirect('/bench/repair');
    }));

    // ---------- Setup (managers) ----------
    app.get('/bench/setup', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        if (req.session.admin !== 1) return res.redirect('/bench/order');
        let code = '';
        try { code = fs.readFileSync(path.join(__dirname, 'appsscript', 'Code.gs'), 'utf8'); } catch (e) { code = '// Code.gs was not found next to the app.'; }
        res.render('bench_setup', {
            flash: takeFlash(req), urlSet: !!process.env.SHEET_WEBAPP_URL, tokenSet: !!process.env.SHEET_TOKEN, configured: sheet.configured(), code
        });
    }));

    app.post('/bench/setup/test', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        if (req.session.admin !== 1) return res.redirect('/bench/order');
        if (!sheet.configured()) flash(req, 'Add SHEET_WEBAPP_URL and SHEET_TOKEN in Render first.', true);
        else {
            const l = await lists(db, true);
            if (l.live) flash(req, 'Connected. Read ' + l.orderModels.length + ' device models and ' + l.orderParts.length + ' parts from the sheet.');
            else flash(req, 'Could not connect: ' + (l.error || 'unknown problem') , true);
        }
        res.redirect('/bench/setup');
    }));
}

module.exports = mount;
module.exports.hasBench = hasBench;
