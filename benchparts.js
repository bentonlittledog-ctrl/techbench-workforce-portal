// Parts inventory: what is on the shelf, what each repair used, what is running low, and what to order.
const bench = require('./bench');
const tiers = require('./tiers');
const L = require('./ticketlib');
const { CLOSED, PARTS } = L;

const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const pname = s => L.one(s, 80);
const intIn = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

// How fast each part is used and what to order. Uses recorded "parts used" first, and the parts typed on tickets for everything else.
async function forecast(db, now = new Date()) {
    const since = new Date(now - 90 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const inv = await db.all('SELECT * FROM parts_inventory ORDER BY name');
    const first = await db.get('SELECT MIN(created_at) AS d FROM repair_tickets');
    const spanDays = first && first.d ? Math.max(14, Math.min(90, (now - L.parse(first.d)) / 86400000)) : 90, weeks = spanDays / 7;
    const used = new Map(), usedTickets = new Set();
    (await db.all('SELECT ticket_id, part, qty FROM ticket_parts_used WHERE at >= ?', [since])).forEach(u => { usedTickets.add(u.ticket_id); used.set(norm(u.part), (used.get(norm(u.part)) || 0) + u.qty); });
    const names = new Map(inv.map(p => [norm(p.name), p.name]));
    const pending = new Map();
    (await db.all('SELECT id, parts, status, created_at FROM repair_tickets WHERE created_at >= ? OR status IN (?, ?)', [since, ...PARTS])).forEach(t => {
        for (const p of tiers.splitParts(t.parts)) {
            const k = norm(p); if (!k) continue;
            if (!names.has(k)) names.set(k, p.trim());
            if (t.created_at >= since && !usedTickets.has(t.id)) used.set(k, (used.get(k) || 0) + 1);
            if (PARTS.includes(t.status)) pending.set(k, (pending.get(k) || 0) + 1);
        }
    });
    const invBy = new Map(inv.map(p => [norm(p.name), p]));
    const rows = [...names].map(([k, name]) => {
        const p = invBy.get(k), qty90 = used.get(k) || 0, rate = qty90 / weeks, onHand = p ? p.on_hand : null, need = pending.get(k) || 0;
        const wk = rate > 0 && onHand != null ? onHand / rate : null;
        const order = onHand == null ? Math.ceil(rate * 4 + need) : Math.max(0, Math.ceil(rate * 4 + need - onHand));
        const low = p ? (p.on_hand <= p.min_stock || (wk != null && wk < 2 && rate > 0)) : false;
        return { id: p ? p.id : null, name, onHand, minStock: p ? p.min_stock : null, tracked: !!p, qty90, perWeek: Math.round(rate * 10) / 10, weeksLeft: wk == null ? null : Math.round(wk * 10) / 10, pending: need, order, low };
    });
    rows.sort((a, b) => (b.low - a.low) || (b.order - a.order) || (b.qty90 - a.qty90) || a.name.localeCompare(b.name));
    return { rows, spanDays: Math.round(spanDays) };
}

async function useOnTicket(db, session, ticketId, part, qty) {
    const name = pname(part); qty = intIn(qty, 1, 20, 1);
    if (!name) return { ok: false, error: 'Choose or type the part.' };
    let p = await db.get('SELECT * FROM parts_inventory WHERE name = ? COLLATE NOCASE', [name]);
    if (!p) { await db.run('INSERT INTO parts_inventory (name, on_hand, min_stock) VALUES (?, 0, 0)', [name]); p = await db.get('SELECT * FROM parts_inventory WHERE name = ? COLLATE NOCASE', [name]); }
    const short = p.on_hand < qty;
    await db.run('UPDATE parts_inventory SET on_hand = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [Math.max(0, p.on_hand - qty), p.id]);
    await db.run('INSERT INTO ticket_parts_used (ticket_id, part, qty, by_id, by_name) VALUES (?,?,?,?,?)', [ticketId, p.name, qty, session.userID, session.name || '']);
    await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [ticketId, session.userID, session.name || '', 'part', 'Used ' + qty + ' x ' + p.name]);
    await db.run('UPDATE repair_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [ticketId]);
    return { ok: true, short, name: p.name, left: Math.max(0, p.on_hand - qty) };
}

async function ticketData(db, t) {
    return {
        used: await db.all('SELECT id, part, qty, by_name, at FROM ticket_parts_used WHERE ticket_id = ? ORDER BY id', [t.id]),
        partChoices: (await db.all('SELECT name, on_hand FROM parts_inventory ORDER BY name')).concat(tiers.splitParts(t.parts).filter(Boolean).map(n => ({ name: n.trim(), on_hand: null })))
            .filter((x, i, a) => a.findIndex(y => norm(y.name) === norm(x.name)) === i)
    };
}

function mount(app, getDb, wrap) {
    async function gate(req, res, managersOnly, json) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        if (managersOnly && req.session.admin !== 1) { req.session.flash = { msg: 'Only managers can do that.', bad: true }; res.redirect('/bench/inventory'); return null; }
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const back = (req, res) => res.redirect('/bench/inventory');

    app.get('/bench/inventory', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const f = await forecast(db);
        res.render('bench_inventory', { flash: takeFlash(req), rows: f.rows, spanDays: f.spanDays, isAdmin: req.session.admin === 1,
            lowCount: f.rows.filter(r => r.low).length, toOrder: f.rows.filter(r => r.order > 0) });
    }));
    app.post('/bench/inventory/add', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const name = pname(req.body.name), qty = intIn(req.body.on_hand, 0, 9999, 0), min = req.session.admin === 1 ? intIn(req.body.min_stock, 0, 9999, 0) : 0;
        if (!name) { flash(req, 'Enter the part name.', true); return back(req, res); }
        if (await db.get('SELECT 1 AS x FROM parts_inventory WHERE name = ? COLLATE NOCASE', [name])) { flash(req, name + ' is already on the list.', true); return back(req, res); }
        await db.run('INSERT INTO parts_inventory (name, on_hand, min_stock) VALUES (?,?,?)', [name, qty, min]);
        await L.audit(db, req.session, 'INVENTORY', 'Added part ' + name + ' (' + qty + ' on hand)');
        flash(req, 'Added ' + name + '.'); back(req, res);
    }));
    app.post('/bench/inventory/bulk', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const names = String(req.body.names || '').split(/\r?\n/).map(pname).filter(Boolean).slice(0, 200);
        let n = 0;
        for (const name of names) if (!(await db.get('SELECT 1 AS x FROM parts_inventory WHERE name = ? COLLATE NOCASE', [name]))) { await db.run('INSERT INTO parts_inventory (name) VALUES (?)', [name]); n++; }
        if (n) await L.audit(db, req.session, 'INVENTORY', 'Added ' + n + ' parts to the list');
        flash(req, 'Added ' + n + ' part' + (n === 1 ? '' : 's') + '.'); back(req, res);
    }));
    // set the shelf count (anyone on the bench) or the low-stock line (managers)
    app.post('/bench/inventory/save', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const p = await db.get('SELECT * FROM parts_inventory WHERE id = ?', [parseInt(req.body.id, 10) || 0]);
        if (!p) { flash(req, 'That part was not found.', true); return back(req, res); }
        const onHand = intIn(req.body.on_hand, 0, 9999, p.on_hand), min = req.session.admin === 1 ? intIn(req.body.min_stock, 0, 9999, p.min_stock) : p.min_stock;
        if (onHand !== p.on_hand || min !== p.min_stock) {
            await db.run('UPDATE parts_inventory SET on_hand = ?, min_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [onHand, min, p.id]);
            await L.audit(db, req.session, 'INVENTORY', p.name + ': on hand ' + p.on_hand + ' to ' + onHand + (min !== p.min_stock ? ', low-stock line ' + p.min_stock + ' to ' + min : ''));
        }
        flash(req, 'Saved ' + p.name + '.'); back(req, res);
    }));
    // stock arrived: add to the count
    app.post('/bench/inventory/receive', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const p = await db.get('SELECT * FROM parts_inventory WHERE id = ?', [parseInt(req.body.id, 10) || 0]);
        const add = intIn(req.body.qty, 1, 999, 0);
        if (!p || !add) { flash(req, 'Enter how many arrived.', true); return back(req, res); }
        await db.run('UPDATE parts_inventory SET on_hand = on_hand + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [add, p.id]);
        await L.audit(db, req.session, 'INVENTORY', 'Received ' + add + ' x ' + p.name);
        flash(req, 'Added ' + add + ' to ' + p.name + '.'); back(req, res);
    }));
    app.post('/bench/inventory/delete', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const p = await db.get('SELECT * FROM parts_inventory WHERE id = ?', [parseInt(req.body.id, 10) || 0]);
        if (p) { await db.run('DELETE FROM parts_inventory WHERE id = ?', [p.id]); await L.audit(db, req.session, 'INVENTORY', 'Removed part ' + p.name + ' from the list'); flash(req, 'Removed ' + p.name + '.'); }
        back(req, res);
    }));

    // ----- on a ticket -----
    const ticketBack = (res, id) => res.redirect('/bench/ticket?id=' + id);
    app.post('/bench/ticket/part', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await db.get('SELECT id FROM repair_tickets WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!t) return res.redirect('/bench/queue');
        const r = await useOnTicket(db, req.session, t.id, req.body.part, req.body.qty);
        flash(req, r.ok ? 'Recorded ' + r.name + '.' + (r.short ? ' The shelf count was lower than that, so check it on the Inventory page.' : ' ' + r.left + ' left on the shelf.') : r.error, !r.ok || r.short);
        ticketBack(res, t.id);
    }));
    app.post('/bench/ticket/part/delete', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const u = await db.get('SELECT * FROM ticket_parts_used WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!u) return res.redirect('/bench/queue');
        await db.run('DELETE FROM ticket_parts_used WHERE id = ?', [u.id]);
        await db.run('UPDATE parts_inventory SET on_hand = on_hand + ? WHERE name = ? COLLATE NOCASE', [u.qty, u.part]);
        await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [u.ticket_id, req.session.userID, req.session.name || '', 'part', 'Took back ' + u.qty + ' x ' + u.part + ' (put on the shelf)']);
        flash(req, 'Removed. ' + u.qty + ' put back on the shelf.'); ticketBack(res, u.ticket_id);
    }));
}

module.exports = mount;
Object.assign(module.exports, { forecast, useOnTicket, ticketData });
