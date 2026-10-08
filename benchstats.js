// Tech Bench dashboard, workload view and fee report.
const bench = require('./bench');
const tiers = require('./tiers');
const L = require('./ticketlib');
const { STATUSES, CLOSED, READY, PRIORITIES } = L;

const pct = (n, max) => max ? Math.max(n ? 4 : 0, Math.round(n / max * 100)) : 0;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = n => n == null ? null : Math.round(n * 10) / 10;
const daysBetween = (a, b) => { const x = L.parse(a), y = L.parse(b); return x && y ? Math.max(0, (y - x) / 86400000) : null; };
const monday = ts => { const d = L.parse(ts); if (!d) return ''; const s = d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }); const dt = new Date(s + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

function mount(app, getDb, wrap) {
    async function gate(req, res) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        return db;
    }
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const eventsByTicket = async db => {
        const m = new Map();
        (await db.all("SELECT ticket_id, at, kind, text FROM ticket_events WHERE kind = 'status' ORDER BY id")).forEach(e => { if (!m.has(e.ticket_id)) m.set(e.ticket_id, []); m.get(e.ticket_id).push(e); });
        return m;
    };

    // ---------- dashboard ----------
    app.get('/bench/dashboard', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const range = ['30', '90', '365', 'all'].includes(req.query.range) ? req.query.range : '90';
        const cutoff = range === 'all' ? '' : new Date(Date.now() - parseInt(range, 10) * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const all = await db.all('SELECT * FROM repair_tickets');
        const evs = await eventsByTicket(db), changes = await L.lastChanges(db), repeats = await L.repeatMap(db), now = new Date();
        const open = all.filter(t => !CLOSED.includes(t.status));
        open.forEach(t => { t.stuck = L.stuckFor(t, changes.get(t.id), now); });
        const inRange = all.filter(t => !cutoff || L.day(t.created_at) >= cutoff);

        const byStatus = STATUSES.filter(s => !CLOSED.includes(s)).map(s => ({ status: s, n: open.filter(t => t.status === s).length, tone: L.tone(s) }));
        const maxStatus = Math.max(1, ...byStatus.map(x => x.n));
        byStatus.forEach(x => { x.w = pct(x.n, maxStatus); });

        const days = inRange.map(t => { const r = L.repairedAt(t, evs.get(t.id)); return r ? daysBetween(t.created_at, r) : null; }).filter(d => d != null);
        const tierRows = [1, 2, 3, 4].map(n => ({ n, name: tiers.TIERS[n].name, count: inRange.filter(t => tiers.num(t.tier) === n).length }));
        tierRows.push({ n: 0, name: 'Not set', count: inRange.filter(t => !tiers.num(t.tier)).length });
        const maxTier = Math.max(1, ...tierRows.map(x => x.count)); tierRows.forEach(x => { x.w = pct(x.count, maxTier); });

        const schoolMap = new Map();
        inRange.forEach(t => {
            const k = t.site_name || 'Not recorded';
            if (!schoolMap.has(k)) schoolMap.set(k, { name: k, count: 0, open: 0, days: [] });
            const o = schoolMap.get(k); o.count++; if (!CLOSED.includes(t.status)) o.open++;
            const r = L.repairedAt(t, evs.get(t.id)); if (r) o.days.push(daysBetween(t.created_at, r));
        });
        const schools = [...schoolMap.values()].sort((a, b) => b.count - a.count).map(o => ({ name: o.name, count: o.count, open: o.open, avgDays: r1(avg(o.days)) }));
        const maxSchool = Math.max(1, ...schools.map(x => x.count)); schools.forEach(x => { x.w = pct(x.count, maxSchool); });

        const holders = new Map();
        open.forEach(t => { const k = t.assigned_name || 'Unassigned'; holders.set(k, (holders.get(k) || 0) + 1); });
        const mostOpen = [...holders.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
        const maxHold = Math.max(1, ...mostOpen.map(x => x.n)); mostOpen.forEach(x => { x.w = pct(x.n, maxHold); });

        const modelMap = new Map(); inRange.forEach(t => modelMap.set(t.model, (modelMap.get(t.model) || 0) + 1));
        const models = [...modelMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n }));
        const maxModel = Math.max(1, ...models.map(x => x.n)); models.forEach(x => { x.w = pct(x.n, maxModel); });

        const weeks = []; const wk = new Map();
        for (let i = 7; i >= 0; i--) { const d = new Date(Date.now() - i * 7 * 86400000); const k = monday(d.toISOString()); if (!wk.has(k)) { wk.set(k, 0); weeks.push(k); } }
        all.forEach(t => { const k = monday(t.created_at); if (wk.has(k)) wk.set(k, wk.get(k) + 1); });
        const weekRows = weeks.map(k => ({ week: k, n: wk.get(k) })); const maxWeek = Math.max(1, ...weekRows.map(x => x.n)); weekRows.forEach(x => { x.w = pct(x.n, maxWeek); });

        const repeatDevices = [];
        for (const [serial, n] of repeats.entries()) {
            const list = all.filter(t => String(t.serial || '').toLowerCase() === serial).sort((a, b) => b.id - a.id);
            repeatDevices.push({ serial: list[0].serial, model: list[0].model, n, last: L.fmt(list[0].created_at), lastId: list[0].id, open: list.some(t => !CLOSED.includes(t.status)) });
        }
        repeatDevices.sort((a, b) => b.n - a.n || b.lastId - a.lastId);

        res.render('bench_dashboard', {
            range, flash: takeFlash(req),
            cards: {
                open: open.length, ready: open.filter(t => t.status === READY).length, stuck: open.filter(t => t.stuck).length,
                high: open.filter(t => t.priority === 'High').length, repeatOpen: open.filter(t => (repeats.get(String(t.serial || '').toLowerCase()) || 0) > 1).length,
                unassigned: open.filter(t => !t.assigned_to).length
            },
            opened: inRange.length, finished: days.length, avgDays: r1(avg(days)), medianDays: r1(median(days)),
            unrepairable: inRange.filter(t => t.status === 'Unrepairable').length,
            byStatus, tierRows, schools, mostOpen, models, weekRows, repeatDevices: repeatDevices.slice(0, 10), stuckDays: L.STUCK_DAYS(), isAdmin: req.session.admin === 1
        });
    }));

    // ---------- workload ----------
    app.get('/bench/workload', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const people = await L.benchPeople(db);
        const open = await db.all("SELECT * FROM repair_tickets WHERE status NOT IN ('Unrepairable', 'Returned to Student')");
        const changes = await L.lastChanges(db), now = new Date();
        const decorate = t => ({ id: t.id, model: t.model, serial: t.serial, student: L.nameOf(t), status: t.status, tone: L.tone(t.status), high: t.priority === 'High',
            tier: tiers.num(t.tier), age: L.ageDays(t.created_at), stuck: L.stuckFor(t, changes.get(t.id), now) });
        const order = (a, b) => (b.high - a.high) || (b.age - a.age) || a.id - b.id;
        const card = (id, name) => {
            const list = open.filter(t => (id == null ? !t.assigned_to : t.assigned_to === id)).map(decorate).sort(order);
            return { id, name, list, n: list.length, high: list.filter(x => x.high).length, stuck: list.filter(x => x.stuck).length, oldest: list.length ? Math.max(...list.map(x => x.age)) : 0, ready: list.filter(x => x.status === READY).length };
        };
        const cards = people.map(p => card(p.id, p.name));
        // anyone holding tickets who is no longer on the bench still shows up
        open.filter(t => t.assigned_to && !people.some(p => p.id === t.assigned_to)).forEach(t => { if (!cards.some(c => c.id === t.assigned_to)) cards.push(card(t.assigned_to, t.assigned_name || 'Former member')); });
        cards.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
        const max = Math.max(1, ...cards.map(c => c.n)); cards.forEach(c => { c.w = pct(c.n, max); });
        res.render('bench_workload', { flash: takeFlash(req), cards, unassigned: card(null, 'Unassigned'), me: req.session.userID, stuckDays: L.STUCK_DAYS() });
    }));

    // ---------- fee report (managers) ----------
    const reportData = async (db, Q) => {
        const f = {
            from: L.isDate(Q.from) ? Q.from : today().slice(0, 8) + '01',
            to: L.isDate(Q.to) ? Q.to : today(),
            basis: Q.basis === 'finished' ? 'finished' : 'opened',
            scope: Q.scope === 'all' ? 'all' : 'billable',
            school: L.one(Q.school, 60)
        };
        const all = await db.all('SELECT * FROM repair_tickets ORDER BY id');
        const evs = await eventsByTicket(db);
        const rows = [];
        for (const t of all) {
            const n = tiers.num(t.tier);
            const fin = L.repairedAt(t, evs.get(t.id)) || t.closed_at || '';
            const stamp = f.basis === 'finished' ? fin : t.created_at;
            if (!stamp) continue;
            const d = L.day(stamp);
            if (d < f.from || d > f.to) continue;
            if (f.school && (t.site_name || '') !== f.school) continue;
            const done = t.status === READY || t.status === 'Returned to Student';
            if (f.scope === 'billable' && !(done || (n === 4 && CLOSED.includes(t.status)))) continue;
            rows.push({ id: t.id, opened: L.day(t.created_at), finished: fin ? L.day(fin) : '', student: L.nameOf(t), student_id: t.student_id, grade: t.student_grade, school: t.site_name || '',
                model: t.model, serial: t.serial, status: t.status, tier: n, tierName: n ? tiers.label(n) : '', fee: n ? tiers.TIERS[n].fee : 0 });
        }
        const byTier = [1, 2, 3, 4].map(n => { const c = rows.filter(r => r.tier === n).length; return { n, name: tiers.TIERS[n].name, fee: tiers.TIERS[n].fee, count: c, total: c * tiers.TIERS[n].fee }; });
        const noTier = rows.filter(r => !r.tier).length;
        const stuMap = new Map();
        rows.filter(r => r.tier).forEach(r => { const k = (r.student_id || '') + '|' + r.student; if (!stuMap.has(k)) stuMap.set(k, { student: r.student || 'Not recorded', student_id: r.student_id, count: 0, total: 0 }); const o = stuMap.get(k); o.count++; o.total += r.fee; });
        const byStudent = [...stuMap.values()].sort((a, b) => b.total - a.total || a.student.localeCompare(b.student));
        const schMap = new Map();
        rows.filter(r => r.tier).forEach(r => { const k = r.school || 'Not recorded'; if (!schMap.has(k)) schMap.set(k, { school: k, count: 0, total: 0 }); const o = schMap.get(k); o.count++; o.total += r.fee; });
        const bySchool = [...schMap.values()].sort((a, b) => b.total - a.total);
        const schools = [...new Set(all.map(t => t.site_name).filter(Boolean))].sort();
        return { f, rows, byTier, noTier, byStudent, bySchool, schools, grand: byTier.reduce((s, x) => s + x.total, 0), count: byTier.reduce((s, x) => s + x.count, 0) };
    };
    const managerGate = async (req, res) => {
        const db = await gate(req, res); if (!db) return null;
        if (req.session.admin !== 1) { res.redirect('/bench/queue'); return null; }
        return db;
    };
    app.get('/bench/report', wrap(async (req, res) => {
        const db = await managerGate(req, res); if (!db) return;
        const d = await reportData(db, req.query || {});
        const qs = ['from', 'to', 'basis', 'scope', 'school'].filter(k => d.f[k]).map(k => k + '=' + encodeURIComponent(d.f[k])).join('&');
        res.render('bench_report', Object.assign({ flash: takeFlash(req), qs }, d));
    }));
    app.get('/bench/report.csv', wrap(async (req, res) => {
        const db = await managerGate(req, res); if (!db) return;
        const d = await reportData(db, req.query || {});
        const head = ['Ticket', 'Opened', 'Finished', 'Student', 'Student ID', 'Grade', 'School', 'Device', 'Serial / asset ID', 'Tier', 'Fee', 'Status'];
        const lines = [head.map(L.csvCell).join(',')].concat(d.rows.map(r => [r.id, r.opened, r.finished, r.student, r.student_id, r.grade, r.school, r.model, r.serial, r.tierName, r.tier ? r.fee : '', r.status].map(L.csvCell).join(',')));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tech-bench-repairs-' + d.f.from + '-to-' + d.f.to + '.csv"', 'X-Content-Type-Options': 'nosniff' });
        res.send('﻿' + lines.join('\r\n') + '\r\n');
    }));
}

module.exports = mount;
