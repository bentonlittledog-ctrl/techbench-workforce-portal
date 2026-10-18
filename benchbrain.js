// Smart parts of the repair queue: time estimates, "this one is taking unusually long", who should take a ticket,
// failure patterns, the history of one device, and the Bench settings page.
const bench = require('./bench');
const tiers = require('./tiers');
const L = require('./ticketlib');
const { CLOSED, READY, STATUSES } = L;

const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = n => n == null ? null : Math.round(n * 10) / 10;
const modelKey = m => String(m || '').trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

// ticket id -> when its repair finished (first time Ready for Pickup, else the day it closed as returned)
async function finishTimes(db) {
    const evs = await db.all("SELECT ticket_id, at, text, kind FROM ticket_events WHERE kind = 'status' ORDER BY id");
    const by = new Map();
    for (const e of evs) { if (by.has(e.ticket_id)) continue; const to = L.statusEvents([e])[0]; if (to && to.to === READY) by.set(e.ticket_id, e.at); }
    const m = new Map();
    (await db.all('SELECT id, status, closed_at, created_at FROM repair_tickets')).forEach(t => {
        const f = by.get(t.id) || (CLOSED.includes(t.status) && t.status !== 'Unrepairable' ? t.closed_at : null);
        if (f) m.set(t.id, f);
    });
    return m;
}
const daysTaken = (t, fin) => { const f = fin.get(t.id); return f ? Math.max(0, L.hoursBetween(t.created_at, f) / 24) : null; };

// Typical days to repair, from this shop's own history (same model, else same tier, else everything).
async function estimator(db) {
    const fin = await finishTimes(db), now = new Date();
    const factor = Math.min(5, Math.max(1.2, parseFloat(await L.getSetting(db, 'bench_long_factor', '1.5')) || 1.5));
    const done = (await db.all('SELECT id, model, tier, created_at FROM repair_tickets')).map(t => ({ t, d: daysTaken(t, fin) })).filter(x => x.d != null);
    const group = (fn, key) => done.filter(x => fn(x.t) === key).map(x => x.d);
    const estimate = t => {
        const a = group(x => modelKey(x.model), modelKey(t.model)), tn = tiers.num(t.tier);
        if (a.length >= 3) return { days: r1(median(a)), basis: 'this model', n: a.length };
        const b = tn ? group(x => tiers.num(x.tier), tn) : [];
        if (b.length >= 3) return { days: r1(median(b)), basis: 'this repair tier', n: b.length };
        const c = done.map(x => x.d);
        if (c.length >= 5) return { days: r1(median(c)), basis: 'all repairs', n: c.length };
        return null;
    };
    // An open ticket is "long" when it has been open well past the typical time (and at least 2 days).
    const longFor = t => {
        if (CLOSED.includes(t.status) || t.status === READY) return null;
        const e = estimate(t); if (!e) return null;
        const age = L.hoursBetween(t.created_at, now.toISOString().replace('T', ' ').slice(0, 19)) / 24;
        const limit = Math.max(e.days * factor, e.days + 2, 2);
        return age > limit ? { age: r1(age), est: e.days, basis: e.basis } : null;
    };
    return { estimate, longFor, fin, samples: done.length };
}

// ---------- who should take a ticket ----------
async function loadPeopleState(db) {
    const people = await L.benchPeople(db);
    const open = new Map();
    (await db.all(`SELECT assigned_to AS id, COUNT(*) AS n FROM repair_tickets WHERE assigned_to IS NOT NULL AND status NOT IN (${CLOSED.map(() => '?').join(',')}) GROUP BY assigned_to`, CLOSED)).forEach(r => open.set(r.id, r.n));
    const onShift = new Set((await db.all(`SELECT l.employee_id AS id FROM logs l WHERE l.action = 'CLOCK_IN' AND l.id = (SELECT id FROM logs x WHERE x.employee_id = l.employee_id ORDER BY x.timestamp DESC, x.id DESC LIMIT 1)`).catch(() => [])).map(r => r.id));
    const skills = new Map();
    (await db.all('SELECT employee_id, skill FROM student_skills')).forEach(r => { if (!skills.has(r.employee_id)) skills.set(r.employee_id, new Set()); skills.get(r.employee_id).add(r.skill); });
    return { people, open, onShift, skills };
}
// Ranked candidates, best first. `eligible` is false when Tier 3 gating is on and they are missing a needed skill.
async function suggestions(db, t, state) {
    state = state || await loadPeopleState(db);
    const gate = await L.flag(db, 'bench_gate_tier3', false);
    const needed = L.skillsForParts(t.parts).filter(k => k !== 'diag');
    const hard = gate && (tiers.num(t.tier) || 0) >= 3;
    const rows = state.people.map(p => {
        const have = state.skills.get(p.id) || new Set(), missing = needed.filter(k => !have.has(k));
        const open = state.open.get(p.id) || 0, shift = state.onShift.has(p.id);
        const score = open * 10 + missing.length * 25 - (shift ? 8 : 0) - (needed.length && !missing.length ? 6 : 0);
        const why = [open + ' open ticket' + (open === 1 ? '' : 's')];
        if (needed.length) why.push(missing.length ? 'not signed off on ' + missing.map(L.skillName).join(', ') : 'signed off on the needed skills');
        if (shift) why.push('clocked in now');
        return { id: p.id, name: p.name, open, onShift: shift, missing, score, eligible: !(hard && missing.length), why: why.join(' · ') };
    });
    return rows.sort((a, b) => a.score - b.score || a.open - b.open || a.name.localeCompare(b.name));
}
async function autoAssign(db, t, session) {
    if (t.assigned_to || CLOSED.includes(t.status)) return null;
    const best = (await suggestions(db, t)).find(x => x.eligible);
    if (!best) return null;
    await db.run('UPDATE repair_tickets SET assigned_to = ?, assigned_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND assigned_to IS NULL', [best.id, best.name, t.id]);
    await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, session ? session.userID : null, session ? (session.name || '') : 'System', 'assign', 'Auto-assigned to ' + best.name + ' (' + best.why + ')']);
    return best;
}

// Extra data for the ticket page
async function ticketData(db, t) {
    const est = await estimator(db);
    const open = !CLOSED.includes(t.status);
    const sug = open && !t.assigned_to ? (await suggestions(db, t)).slice(0, 3) : [];
    return { est: est.estimate(t), long: est.longFor(t), sug };
}

function mount(app, getDb, wrap) {
    async function gate(req, res, managersOnly) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        if (managersOnly && req.session.admin !== 1) { res.redirect('/bench/queue'); return null; }
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };

    // ----- failure patterns -----
    app.get('/bench/patterns', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const range = ['30', '90', '365', 'all'].includes(req.query.range) ? req.query.range : '90';
        const since = range === 'all' ? '' : new Date(Date.now() - parseInt(range, 10) * 86400000).toISOString().slice(0, 10);
        const all = await db.all('SELECT id, model, serial, parts, tier, site_name, status, created_at FROM repair_tickets' + (since ? ' WHERE created_at >= ?' : ''), since ? [since] : []);
        const fin = await finishTimes(db);
        const models = new Map(), parts = new Map(), schools = new Map();
        const serialN = new Map(); all.forEach(t => { const k = String(t.serial || '').toLowerCase(); if (k && k !== 'unknown') serialN.set(k, (serialN.get(k) || 0) + 1); });
        const bump = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
        for (const t of all) {
            const mk = String(t.model || '').trim() || 'Unknown', tn = tiers.num(t.tier) || 0, d = daysTaken(t, fin);
            const m = bump(models, mk, () => ({ model: mk, n: 0, days: [], parts: new Map(), t2: 0, repeats: 0 }));
            m.n++; if (d != null) m.days.push(d); if (tn >= 2) m.t2++;
            if ((serialN.get(String(t.serial || '').toLowerCase()) || 0) > 1) m.repeats++;
            const sc = bump(schools, t.site_name || 'Not recorded', () => ({ school: t.site_name || 'Not recorded', n: 0, tierSum: 0, tierN: 0 }));
            sc.n++; if (tn) { sc.tierSum += tn; sc.tierN++; }
            for (const p of tiers.splitParts(t.parts)) {
                const pk = p.trim(); if (!pk) continue;
                m.parts.set(pk, (m.parts.get(pk) || 0) + 1);
                const pp = bump(parts, pk, () => ({ part: pk, n: 0, models: new Map(), schools: new Map() }));
                pp.n++; pp.models.set(mk, (pp.models.get(mk) || 0) + 1); pp.schools.set(t.site_name || 'Not recorded', (pp.schools.get(t.site_name || 'Not recorded') || 0) + 1);
            }
        }
        const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(x => x[0] + ' (' + x[1] + ')').join(', ');
        const modelRows = [...models.values()].map(m => ({ model: m.model, n: m.n, avgDays: m.days.length ? r1(m.days.reduce((a, b) => a + b, 0) / m.days.length) : null, repeats: m.repeats, topParts: top(m.parts, 3), share: all.length ? Math.round(m.n / all.length * 100) : 0 })).sort((a, b) => b.n - a.n).slice(0, 25);
        const partRows = [...parts.values()].map(p => ({ part: p.part, n: p.n, models: top(p.models, 3), schools: top(p.schools, 2) })).sort((a, b) => b.n - a.n).slice(0, 25);
        const schoolRows = [...schools.values()].map(s => ({ school: s.school, n: s.n, avgTier: s.tierN ? r1(s.tierSum / s.tierN) : null })).sort((a, b) => b.n - a.n);
        // plain-language findings
        const insights = [];
        const t2 = [...models.values()].reduce((a, m) => a + m.t2, 0), topT2 = [...models.values()].sort((a, b) => b.t2 - a.t2)[0];
        if (t2 >= 5 && topT2 && topT2.t2 / t2 >= 0.25) insights.push(topT2.model + ' accounts for ' + Math.round(topT2.t2 / t2 * 100) + '% of Tier 2 and higher repairs (' + topT2.t2 + ' of ' + t2 + ').');
        const topPart = partRows[0];
        if (topPart && topPart.n >= 5) insights.push(topPart.part + ' is the most common part (' + topPart.n + ' repairs), most often on ' + topPart.models.split(' (')[0] + '.');
        const rep = [...models.values()].filter(m => m.n >= 4).sort((a, b) => b.repeats / b.n - a.repeats / a.n)[0];
        if (rep && rep.repeats / rep.n >= 0.25) insights.push(rep.model + ' has the most devices coming back: ' + rep.repeats + ' of ' + rep.n + ' tickets are repeats.');
        const slow = [...models.values()].filter(m => m.days.length >= 3).sort((a, b) => (b.days.reduce((x, y) => x + y, 0) / b.days.length) - (a.days.reduce((x, y) => x + y, 0) / a.days.length))[0];
        if (slow) insights.push(slow.model + ' takes the longest to repair, about ' + r1(slow.days.reduce((x, y) => x + y, 0) / slow.days.length) + ' days on average.');
        res.render('bench_patterns', { range, total: all.length, modelRows, partRows, schoolRows, insights });
    }));

    // ----- one device's whole life -----
    app.get('/bench/device', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const q = L.one(req.query.q, 60);
        let tickets = [], matches = [];
        if (q) {
            tickets = await db.all('SELECT * FROM repair_tickets WHERE serial = ? COLLATE NOCASE ORDER BY id DESC', [q]);
            if (!tickets.length) matches = await db.all("SELECT serial, model, COUNT(*) AS n FROM repair_tickets WHERE serial LIKE ? AND serial != '' GROUP BY lower(serial) ORDER BY n DESC LIMIT 20", ['%' + q.replace(/[%_]/g, '') + '%']);
            if (!tickets.length && matches.length === 1) tickets = await db.all('SELECT * FROM repair_tickets WHERE serial = ? COLLATE NOCASE ORDER BY id DESC', [matches[0].serial]);
        }
        const fin = await finishTimes(db);
        const used = new Map();
        if (tickets.length) (await db.all(`SELECT ticket_id, part, qty FROM ticket_parts_used WHERE ticket_id IN (${tickets.map(() => '?').join(',')})`, tickets.map(t => t.id))).forEach(u => used.set(u.ticket_id, (used.get(u.ticket_id) || []).concat(u.qty + ' x ' + u.part)));
        const rows = tickets.map(t => ({ id: t.id, when: L.fmt(t.created_at), student: L.nameOf(t), complaint: t.complaint, parts: t.parts, used: (used.get(t.id) || []).join(', '), tier: t.tier, status: t.status, tone: L.tone(t.status), days: daysTaken(t, fin) == null ? null : r1(daysTaken(t, fin)), school: t.site_name }));
        const students = [...new Set(tickets.map(t => L.nameOf(t)).filter(Boolean))];
        const partCount = new Map(); tickets.forEach(t => tiers.splitParts(t.parts).forEach(p => partCount.set(p, (partCount.get(p) || 0) + 1)));
        const common = (await db.all("SELECT serial, MAX(model) AS model, COUNT(*) AS n FROM repair_tickets WHERE serial != '' AND serial != 'Unknown' GROUP BY lower(serial) HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10"));
        res.render('bench_device', { q, rows, matches, students, partsSeen: [...partCount].sort((a, b) => b[1] - a[1]), model: tickets[0] && tickets[0].model, common,
            summary: tickets.length ? { n: tickets.length, first: L.fmt(tickets[tickets.length - 1].created_at), totalDays: r1(rows.reduce((a, r) => a + (r.days || 0), 0)) } : null });
    }));

    // ----- Bench settings (managers) -----
    app.get('/bench/settings', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        res.render('bench_settings', { flash: takeFlash(req), s: {
            autoassign: await L.flag(db, 'bench_autoassign', false), gate3: await L.flag(db, 'bench_gate_tier3', false), signoff: await L.flag(db, 'bench_require_signoff', false),
            factor: parseFloat(await L.getSetting(db, 'bench_long_factor', '1.5')) || 1.5 } });
    }));
    app.post('/bench/settings', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const b = req.body || {}, who = req.session.name || '';
        const f = Math.min(5, Math.max(1.2, parseFloat(b.factor) || 1.5));
        const old = { a: await L.flag(db, 'bench_autoassign', false), g: await L.flag(db, 'bench_gate_tier3', false), s: await L.flag(db, 'bench_require_signoff', false) };
        await L.setSetting(db, 'bench_autoassign', b.autoassign === '1' ? '1' : '0', who);
        await L.setSetting(db, 'bench_gate_tier3', b.gate3 === '1' ? '1' : '0', who);
        await L.setSetting(db, 'bench_require_signoff', b.signoff === '1' ? '1' : '0', who);
        await L.setSetting(db, 'bench_long_factor', f, who);
        await L.audit(db, req.session, 'BENCH_SETTINGS', 'Auto-assign ' + (b.autoassign === '1' ? 'on' : 'off') + ', Tier 3 skill gate ' + (b.gate3 === '1' ? 'on' : 'off') + ', mentor check-off ' + (b.signoff === '1' ? 'required' : 'optional') + ', "long" after ' + f + 'x typical');
        flash(req, 'Saved.'); res.redirect('/bench/settings');
    }));

    // ----- assign everything waiting (managers) -----
    app.post('/bench/autoassign', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const waiting = await db.all("SELECT * FROM repair_tickets WHERE assigned_to IS NULL AND status NOT IN (" + CLOSED.map(() => '?').join(',') + ") ORDER BY id", CLOSED);
        let n = 0;
        for (const t of waiting) { if (await autoAssign(db, t, req.session)) n++; }
        if (n) await L.audit(db, req.session, 'AUTO_ASSIGN', 'Auto-assigned ' + n + ' ticket(s) from the Workload page');
        flash(req, n ? 'Assigned ' + n + ' ticket' + (n === 1 ? '' : 's') + '.' : 'Nobody eligible to assign, or nothing waiting.', !n);
        res.redirect('/bench/workload');
    }));
}

module.exports = mount;
Object.assign(module.exports, { estimator, finishTimes, suggestions, autoAssign, ticketData, loadPeopleState });
