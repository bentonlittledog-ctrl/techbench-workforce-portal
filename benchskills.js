// Student skills and sign-offs, mentor check-off on repairs, printable portfolio, and hours worked per ticket.
const bench = require('./bench');
const tiers = require('./tiers');
const certs = require('./certs');
const L = require('./ticketlib');
const { CLOSED, READY, SKILLS } = L;
const r1 = n => n == null ? null : Math.round(n * 10) / 10;
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function skillsOf(db, id) { return new Set((await db.all('SELECT skill FROM student_skills WHERE employee_id = ?', [id])).map(r => r.skill)); }
async function isMentor(db, session) {
    if (!session || !session.userID) return false;
    if (session.admin === 1) return true;
    return !!(await db.get("SELECT 1 AS x FROM student_skills WHERE employee_id = ? AND skill = 'mentor'", [session.userID]));
}

// May this ticket go to this person? Only matters when "Tier 3 and 4 need a signed-off student" is on.
async function checkAssign(db, t, assigneeId, session, override) {
    if (!assigneeId) return { ok: true };
    // Certification gate: Tier 1-2 needs a Basic, Tier 3 a Senior, Tier 4 a Master Repair Specialist (or higher).
    let overridden = null;
    if (await L.flag(db, 'bench_gate_certs', false)) {
        const c = await certs.ticketCheck(db, tiers.num(t.tier), assigneeId);
        if (!c.ok) {
            if (session.admin === 1 && override) overridden = [c.need];
            else return { ok: false, missing: [], msg: 'That person needs the ' + c.need + ' certification for a ' + tiers.label(tiers.num(t.tier)).split(' - ')[0] + ' repair.' + (session.admin === 1 ? ' Tick "Override" to assign it anyway.' : ' Ask a manager.') };
        }
    }
    const done = { ok: true }; if (overridden) done.overridden = overridden;
    if (!(await L.flag(db, 'bench_gate_tier3', false))) return done;
    if ((tiers.num(t.tier) || 0) < 3) return done;
    const have = await skillsOf(db, assigneeId);
    const missing = L.skillsForParts(t.parts).filter(k => k !== 'diag' && !have.has(k));
    if (!missing.length) return done;
    if (session.admin === 1 && override) return { ok: true, overridden: (overridden || []).concat(missing) };
    return { ok: false, missing, msg: 'That person is not signed off on ' + missing.map(L.skillName).join(', ') + ', which this ' + tiers.label(tiers.num(t.tier)).split(' - ')[0] + ' repair needs.' + (session.admin === 1 ? ' Tick "Override" to assign it anyway.' : ' Ask a manager.') };
}
// Called before a ticket moves to Ready for Pickup. Returns { ok:false, msg } to refuse, or records the sign-off when a mentor/manager is the one moving it.
async function checkReady(db, t, session) {
    if (t.mentor_id || !(await L.flag(db, 'bench_require_signoff', false))) return { ok: true };
    if (await isMentor(db, session) && (session.admin === 1 || t.assigned_to !== session.userID)) {
        await recordSignoff(db, t, session, 'Signed off when marked ready');
        return { ok: true, signed: true };
    }
    return { ok: false, msg: 'A mentor or manager must check this repair off before it can be marked Ready for Pickup.' };
}
async function recordSignoff(db, t, session, text) {
    await db.run("UPDATE repair_tickets SET mentor_id = ?, mentor_name = ?, mentor_at = datetime('now') WHERE id = ?", [session.userID, session.name || '', t.id]);
    await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, session.userID, session.name || '', 'signoff', text || 'Checked off the repair']);
}

// ---------- hours worked, attributed to tickets ----------
// A shift's hours are shared among the tickets that person touched (note, status, photo, part...) while clocked in.
async function hoursAttribution(db, sinceDate) {
    const since = sinceDate || '1970-01-01';
    const logs = await db.all('SELECT employee_id, action, timestamp FROM logs WHERE timestamp >= ? ORDER BY employee_id, timestamp, id', [since]);
    const shifts = [];
    for (let i = 0; i < logs.length; i++) {
        const a = logs[i], b = logs[i + 1];
        if (a.action === 'CLOCK_IN' && b && b.action === 'CLOCK_OUT' && b.employee_id === a.employee_id) { shifts.push({ e: a.employee_id, a: a.timestamp, b: b.timestamp }); i++; }
    }
    const evs = await db.all("SELECT ticket_id, user_id, at FROM ticket_events WHERE user_id IS NOT NULL AND at >= ? AND kind NOT IN ('email','created')", [since]);
    const byUser = new Map(); evs.forEach(e => { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); });
    const perTicket = new Map(), perStudent = new Map();
    for (const s of shifts) {
        const hrs = L.hoursBetween(s.a, s.b);
        const touched = new Set((byUser.get(s.e) || []).filter(e => e.at >= s.a && e.at <= s.b).map(e => e.ticket_id));
        const st = perStudent.get(s.e) || { shift: 0, onTickets: 0, tickets: new Set() };
        st.shift += hrs;
        if (touched.size) { st.onTickets += hrs; touched.forEach(id => { st.tickets.add(id); perTicket.set(id, (perTicket.get(id) || 0) + hrs / touched.size); }); }
        perStudent.set(s.e, st);
    }
    return { perTicket, perStudent, shifts: shifts.length };
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

    // ----- skills matrix -----
    app.get('/bench/skills', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const people = await L.benchPeople(db);
        const have = new Map();
        (await db.all('SELECT employee_id, skill, signed_name, at FROM student_skills')).forEach(r => { if (!have.has(r.employee_id)) have.set(r.employee_id, new Map()); have.get(r.employee_id).set(r.skill, r); });
        const mentor = await isMentor(db, req.session);
        res.render('bench_skills', { flash: takeFlash(req), skills: SKILLS, mentor, isAdmin: req.session.admin === 1, me: req.session.userID,
            people: people.map(p => ({ id: p.id, name: p.name, have: have.get(p.id) || new Map() })) });
    }));
    app.post('/bench/skills/toggle', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const id = parseInt(req.body.employee, 10), skill = String(req.body.skill || '');
        if (!SKILLS.some(k => k.key === skill)) { flash(req, 'Unknown skill.', true); return res.redirect('/bench/skills'); }
        const p = (await L.benchPeople(db)).find(x => x.id === id);
        if (!p) { flash(req, 'That person is not on the Tech Bench.', true); return res.redirect('/bench/skills'); }
        const admin = req.session.admin === 1, mentor = await isMentor(db, req.session);
        if (!mentor || (skill === 'mentor' && !admin)) { flash(req, skill === 'mentor' ? 'Only a manager can make someone a mentor.' : 'Only mentors and managers can sign people off.', true); return res.redirect('/bench/skills'); }
        if (id === req.session.userID && !admin) { flash(req, 'You cannot sign yourself off.', true); return res.redirect('/bench/skills'); }
        const had = await db.get('SELECT 1 AS x FROM student_skills WHERE employee_id = ? AND skill = ?', [id, skill]);
        if (had) await db.run('DELETE FROM student_skills WHERE employee_id = ? AND skill = ?', [id, skill]);
        else await db.run('INSERT INTO student_skills (employee_id, skill, signed_by, signed_name) VALUES (?,?,?,?)', [id, skill, req.session.userID, req.session.name || '']);
        await L.audit(db, req.session, 'SKILL_SIGNOFF', (had ? 'Removed ' : 'Signed off ') + L.skillName(skill), p);
        flash(req, (had ? 'Removed ' : 'Signed off ') + p.name + (had ? ' from ' : ' on ') + L.skillName(skill) + '.');
        res.redirect('/bench/skills');
    }));

    // ----- mentor check-off on a ticket -----
    app.post('/bench/ticket/signoff', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!t) return res.redirect('/bench/queue');
        const back = () => res.redirect('/bench/ticket?id=' + t.id);
        if (!(await isMentor(db, req.session))) { flash(req, 'Only mentors and managers can check off a repair.', true); return back(); }
        if (t.assigned_to === req.session.userID && req.session.admin !== 1) { flash(req, 'You cannot check off your own repair. Ask another mentor.', true); return back(); }
        if (!t.mentor_id) { await recordSignoff(db, t, req.session, 'Checked off the repair' + (L.multi(req.body.note, 300) ? ': ' + L.multi(req.body.note, 300) : '')); flash(req, 'Repair checked off.'); }
        back();
    }));
    app.post('/bench/ticket/signoff/clear', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const t = await db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(req.body.id, 10) || 0]); if (!t) return res.redirect('/bench/queue');
        await db.run('UPDATE repair_tickets SET mentor_id = NULL, mentor_name = \'\', mentor_at = NULL WHERE id = ?', [t.id]);
        await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, req.session.userID, req.session.name || '', 'signoff', 'Removed the check-off']);
        res.redirect('/bench/ticket?id=' + t.id);
    }));

    // ----- portfolio -----
    app.get('/bench/portfolio', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const admin = req.session.admin === 1;
        const id = admin && parseInt(req.query.id, 10) ? parseInt(req.query.id, 10) : req.session.userID;
        await require('./profile').ensure(db);
        const emp = await db.get('SELECT id, name, student_id, periods FROM employees WHERE id = ?', [id]);
        if (!emp) return res.redirect('/bench/skills');
        const fin = await require('./benchbrain').finishTimes(db);
        const mine = await db.all('SELECT * FROM repair_tickets WHERE assigned_to = ? ORDER BY id DESC', [id]);
        const done = mine.filter(t => fin.has(t.id));
        const byTier = [1, 2, 3, 4].map(n => ({ n, label: tiers.label(n), count: done.filter(t => tiers.num(t.tier) === n).length }));
        const days = done.map(t => L.hoursBetween(t.created_at, fin.get(t.id)) / 24);
        const hrs = await hoursAttribution(db, '1970-01-01');
        const st = hrs.perStudent.get(id) || { shift: 0, onTickets: 0, tickets: new Set() };
        const skills = (await db.all('SELECT skill, signed_name, at FROM student_skills WHERE employee_id = ? ORDER BY at', [id])).map(s => ({ name: L.skillName(s.skill), by: s.signed_name, when: L.fmt(s.at) }));
        const givenOff = (await db.get('SELECT COUNT(*) AS n FROM repair_tickets WHERE mentor_id = ?', [id])).n;
        await certs.ensure(db);
        const certList = (await db.all('SELECT cert, awarded_name, awarded_at FROM certifications WHERE employee_id = ? ORDER BY awarded_at', [id]))
            .filter(c => certs.BY_KEY[c.cert]).map(c => ({ name: certs.nameOf(c.cert), by: c.awarded_name, when: L.fmt(c.awarded_at) }));
        res.render('bench_portfolio', {
            emp: { id: emp.id, name: emp.name, studentId: emp.student_id || '', periods: emp.periods || '' }, isMe: id === req.session.userID, isAdmin: admin,
            repairs: done.length, byTier, avgDays: days.length ? r1(days.reduce((a, b) => a + b, 0) / days.length) : null,
            hours: r1(st.shift), hoursOnTickets: r1(st.onTickets), skills, certList, givenOff, today: new Date().toLocaleDateString('en-US'),
            recent: done.slice(0, 12).map(t => ({ id: t.id, model: t.model, tier: t.tier ? t.tier.split(' - ')[0] : '', when: L.fmt(fin.get(t.id)) }))
        });
    }));

    // ----- hours per ticket -----
    app.get('/bench/hours', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const range = ['30', '90', '365', 'all'].includes(req.query.range) ? req.query.range : '90';
        const since = range === 'all' ? '1970-01-01' : stamp(Date.now() - parseInt(range, 10) * 86400000);
        const h = await hoursAttribution(db, since);
        const names = new Map((await db.all('SELECT id, name FROM employees')).map(e => [e.id, e.name]));
        const people = [...h.perStudent].map(([id, s]) => ({ id, name: names.get(id) || '#' + id, shift: r1(s.shift), onTickets: r1(s.onTickets), tickets: s.tickets.size, share: s.shift ? Math.round(s.onTickets / s.shift * 100) : 0 }))
            .filter(p => p.shift > 0).sort((a, b) => b.shift - a.shift);
        const ids = [...h.perTicket.keys()];
        const ticks = ids.length ? await db.all(`SELECT id, model, tier, status, assigned_name FROM repair_tickets WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
        const tierRows = [1, 2, 3, 4].map(n => { const ts = ticks.filter(t => tiers.num(t.tier) === n && h.perTicket.get(t.id) > 0); const tot = ts.reduce((a, t) => a + h.perTicket.get(t.id), 0); return { label: tiers.label(n), tickets: ts.length, avg: ts.length ? r1(tot / ts.length) : null, total: r1(tot) }; });
        const top = ticks.map(t => ({ id: t.id, model: t.model, tier: t.tier ? t.tier.split(' - ')[0] : '-', status: t.status, who: t.assigned_name, hours: r1(h.perTicket.get(t.id)) })).sort((a, b) => b.hours - a.hours).slice(0, 15);
        res.render('bench_hours', { range, people, tierRows, top, shifts: h.shifts });
    }));
}

module.exports = mount;
Object.assign(module.exports, { checkAssign, checkReady, isMentor, hoursAttribution, recordSignoff, skillsOf, ticketData: async (db, t, session) => {
    const h = await hoursAttribution(db, t.created_at);
    return { mentor: await isMentor(db, session), tHours: h.perTicket.has(t.id) ? r1(h.perTicket.get(t.id)) : null };
} });
