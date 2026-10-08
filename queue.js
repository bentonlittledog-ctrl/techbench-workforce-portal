// Repair queue: every repair logged through the Repair Logger form becomes an active ticket here.
const bench = require('./bench');
const tiers = require('./tiers');

const L = require('./ticketlib');
const notify = require('./notify');
const { STATUSES, CLOSED, GRADES, FIRST, READY, PARTS, PRIORITIES, one, multi, tone, sid, nameOf, fmt, ageDays, day, isDate } = L;

function mount(app, getDb, wrap) {
    async function database() {
        const db = getDb();
        await L.ensureSchema(db);
        return db;
    }
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    async function gate(req, res, json) {
        if (!req.session.userID) { json ? res.status(401).json({ ok: false }) : res.redirect('/'); return null; }
        const db = await database();
        if (!(await bench.hasBench(db, req.session))) { json ? res.status(403).json({ ok: false }) : res.redirect('/dashboard'); return null; }
        return db;
    }
    const event = (db, id, req, kind, text) => db.run(
        'INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)',
        [id, req.session.userID, req.session.name || '', kind, text || '']);
    const touch = (db, id) => db.run('UPDATE repair_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    const getTicket = (db, id) => db.get('SELECT * FROM repair_tickets WHERE id = ?', [parseInt(id, 10) || 0]);

    const people = db => L.benchPeople(db);
    async function create(db, req, f, source) {
        const model = one(f.model, 120);
        if (!model) return { ok: false, error: 'Choose the device model.' };
        const ref = one(f.client_ref, 60) || null;
        if (ref) { const dup = await db.get('SELECT id FROM repair_tickets WHERE client_ref = ?', [ref]); if (dup) return { ok: true, id: dup.id, duplicate: true }; }
        const stu = { first: one(f.student_first, 40), last: one(f.student_last, 40), id: sid(f.student_id), grade: GRADES.includes(one(f.student_grade, 10)) ? one(f.student_grade, 10) : '' };
        if (source === 'portal') {
            if (!stu.first || !stu.last) return { ok: false, error: 'Enter the student\'s first and last name.' };
            if (!stu.id) return { ok: false, error: 'Enter the student ID number.' };
            if (!stu.grade) return { ok: false, error: 'Choose the student\'s grade.' };
        }
        let tier = one(f.tier, 40), tierWhy = '';
        if (/^[1-4]$/.test(tier)) tier = tiers.label(parseInt(tier, 10));
        const partList = tiers.splitParts(f.parts);
        if (!tiers.num(tier)) {                     // nothing usable from the form: work it out from the parts
            const special = tiers.SPECIALS.find(x => String(f.notes || '').includes(x)) || '';
            const g = tiers.classify(partList, special);
            if (g.tier) { tier = tiers.label(g.tier); tierWhy = g.why; }
        }
        const row = parseInt(f.sheet_row, 10);
        const site = await L.siteForUser(db, req.session.userID).catch(() => '');
        const mail = L.isEmail(String(f.notify_email || '').trim()) ? String(f.notify_email).trim() : '';
        const r = await db.run(
            `INSERT INTO repair_tickets (created_by, created_by_name, model, serial, complaint, parts, tier, priority, status, source, sheet_row, client_ref,
                student_first, student_last, student_id, student_grade, site_name, notify_email)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.session.userID, req.session.name || '', model, one(f.serial, 40), multi(f.complaint, 600), one(f.parts, 400), tier,
             PRIORITIES.includes(f.priority) ? f.priority : 'Normal', FIRST, source, row > 0 ? row : null, ref, stu.first, stu.last, stu.id, stu.grade, site, mail]);
        await event(db, r.lastID, req, 'created', source === 'form' ? 'Logged from the Repair Logger form' : 'Created in the portal');
        if (tierWhy) await event(db, r.lastID, req, 'tier', 'Suggested ' + tier + ' (' + tierWhy.toLowerCase() + ')'); 
        if (f.notes && multi(f.notes, 600)) await event(db, r.lastID, req, 'note', multi(f.notes, 600));
        return { ok: true, id: r.lastID };
    }

    // ---------- the queue ----------
    const tierView = t => { const n = tiers.num(t.tier); return n ? { n, label: tiers.label(n), fee: tiers.TIERS[n].fee, items: tiers.TIERS[n].items } : { n: 0, label: t.tier || '', fee: null }; };
    const suggest = t => {
        const g = tiers.classify(tiers.splitParts(t.parts), '');
        return g.tier && g.tier !== tiers.num(t.tier) ? { n: g.tier, label: tiers.label(g.tier), fee: tiers.TIERS[g.tier].fee, why: g.why, other: g.other } : null;
    };
    const SORTS = { priority: 'Priority, then oldest', newest: 'Newest first', oldest: 'Oldest first', updated: 'Recently updated', longest: 'Open the longest' };

    app.get('/bench/queue', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const Q = req.query || {};
        const f = {
            q: one(Q.q, 60),
            status: STATUSES.includes(Q.status) ? Q.status : '',
            assignee: one(Q.assignee, 12),                      // '', 'none', 'me' or an employee id
            priority: PRIORITIES.includes(Q.priority) ? Q.priority : '',
            tier: ['1', '2', '3', '4', 'none'].includes(Q.tier) ? Q.tier : '',
            model: one(Q.model, 120),
            school: one(Q.school, 60),
            flag: ['stuck', 'repeat'].includes(Q.flag) ? Q.flag : '',
            from: isDate(Q.from) ? Q.from : '', to: isDate(Q.to) ? Q.to : '',
            sort: SORTS[Q.sort] ? Q.sort : 'priority'
        };
        let view = ['active', 'mine', 'parts', 'ready', 'closed', 'all'].includes(Q.view) ? Q.view : 'active';
        if (f.status && view !== 'mine') view = 'all';          // picking an exact status overrides the tab
        const me = req.session.userID;
        const all = await db.all('SELECT * FROM repair_tickets ORDER BY id DESC LIMIT 5000');
        const changes = await L.lastChanges(db), repeats = await L.repeatMap(db), nowD = new Date();
        all.forEach(t => { t.stuck = L.stuckFor(t, changes.get(t.id), nowD); t.repeatN = repeats.get(String(t.serial || '').toLowerCase()) || 1; });
        const isOpen = t => !CLOSED.includes(t.status);
        const count = {
            active: all.filter(isOpen).length,
            mine: all.filter(t => isOpen(t) && t.assigned_to === me).length,
            parts: all.filter(t => PARTS.includes(t.status)).length,
            ready: all.filter(t => t.status === READY).length,
            closed: all.filter(t => !isOpen(t)).length, all: all.length,
            stuck: all.filter(t => isOpen(t) && t.stuck).length, repeat: all.filter(t => isOpen(t) && t.repeatN > 1).length
        };
        let rows = all.filter(t => view === 'all' ? true : view === 'closed' ? !isOpen(t) : view === 'mine' ? isOpen(t) && t.assigned_to === me
            : view === 'parts' ? PARTS.includes(t.status) : view === 'ready' ? t.status === READY : isOpen(t));
        if (f.q) {
            const n = f.q.toLowerCase();
            rows = rows.filter(t => [t.model, t.serial, t.complaint, t.assigned_name, t.status, '#' + t.id, nameOf(t), t.student_id].join(' ').toLowerCase().includes(n));
        }
        if (f.status) rows = rows.filter(t => t.status === f.status);
        if (f.assignee === 'none') rows = rows.filter(t => !t.assigned_to);
        else if (f.assignee === 'me') rows = rows.filter(t => t.assigned_to === me);
        else if (/^\d+$/.test(f.assignee)) rows = rows.filter(t => String(t.assigned_to) === f.assignee);
        if (f.priority) rows = rows.filter(t => t.priority === f.priority);
        if (f.tier) rows = rows.filter(t => (tiers.num(t.tier) || 'none') == f.tier);
        if (f.model) rows = rows.filter(t => t.model === f.model);
        if (f.school) rows = rows.filter(t => (t.site_name || '') === f.school);
        if (f.flag === 'stuck') rows = rows.filter(t => t.stuck && isOpen(t));
        if (f.flag === 'repeat') rows = rows.filter(t => t.repeatN > 1);
        if (f.from) rows = rows.filter(t => day(t.created_at) >= f.from);
        if (f.to) rows = rows.filter(t => day(t.created_at) <= f.to);
        const by = {
            priority: (a, b) => (b.priority === 'High') - (a.priority === 'High') || a.id - b.id,
            newest: (a, b) => b.id - a.id, oldest: (a, b) => a.id - b.id,
            updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id,
            longest: (a, b) => ageDays(b.created_at, b.closed_at) - ageDays(a.created_at, a.closed_at) || a.id - b.id
        };
        const sort = (view === 'closed' || view === 'all') && !Q.sort ? 'newest' : f.sort;   // history views default to newest first
        f.sort = sort;
        rows.sort(by[sort]);
        const total = rows.length;
        rows = rows.slice(0, 300).map(t => Object.assign({}, t, { age: ageDays(t.created_at, t.closed_at), tone: tone(t.status), when: fmt(t.created_at), student: nameOf(t), tierN: tiers.num(t.tier), stuck: t.stuck, repeatN: t.repeatN }));
        const devices = await db.all("SELECT d.name FROM devices d JOIN programs p ON p.id = d.program_id WHERE p.name = 'Student Tech Work Bench' ORDER BY d.brand, d.name").catch(() => []);
        const models = [...new Set(all.map(t => t.model))].sort((a, b) => a.localeCompare(b));
        const schools = [...new Set(all.map(t => t.site_name).filter(Boolean))].sort();
        const filterKeys = ['q', 'status', 'assignee', 'priority', 'tier', 'model', 'school', 'flag', 'from', 'to'];
        const activeFilters = filterKeys.filter(k => f[k]).length;
        const qs = filterKeys.concat(['sort']).filter(k => f[k] && !(k === 'sort' && !Q.sort)).map(k => k + '=' + encodeURIComponent(f[k])).join('&');
        res.render('bench_queue', { flash: takeFlash(req), view, f, sorts: SORTS, count, rows, total, models, schools, stuckDays: L.STUCK_DAYS(), mailConfigured: notify.configured(), activeFilters, qs, people: await people(db),
            devices: devices.map(d => d.name), statuses: STATUSES, grades: GRADES, priorities: PRIORITIES, TIERS: tiers.TIERS, me });
    }));

    app.post('/bench/queue/new', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const r = await create(db, req, req.body || {}, 'portal');
        if (!r.ok) { flash(req, r.error, true); return res.redirect('/bench/queue'); }
        res.redirect('/bench/ticket?id=' + r.id);
    }));

    // Called by the page after the Google Repair Logger form reports a successful save
    app.post('/bench/queue/from-form', wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const r = await create(db, req, req.body || {}, 'form');
        res.status(r.ok ? 200 : 400).json(r);
    }));

    // ---------- one ticket ----------
    app.get('/bench/ticket', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.query.id);
        if (!t) { flash(req, 'That ticket was not found.', true); return res.redirect('/bench/queue'); }
        const events = (await db.all('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC', [t.id])).map(e => Object.assign({}, e, { when: fmt(e.at) }));
        const history = t.serial ? (await db.all('SELECT id, model, status, complaint, created_at FROM repair_tickets WHERE serial = ? COLLATE NOCASE AND id != ? ORDER BY id DESC LIMIT 10', [t.serial, t.id]))
            .map(h => Object.assign({}, h, { when: fmt(h.created_at) })) : [];
        const asc = events.slice().reverse();
        const tl = L.timeline(t, asc);
        const last = asc.filter(e => e.kind === 'status').pop();
        const stuck = L.stuckFor(t, last ? last.at : t.created_at);
        const earlier = history.filter(h => h.id < t.id);
        const times = earlier.length + 1;
        const prev = earlier.find(h => (L.parse(t.created_at) - L.parse(h.created_at)) < 90 * 86400000);
        const photos = (await db.all('SELECT * FROM ticket_photos WHERE ticket_id = ? ORDER BY id', [t.id])).map(p => Object.assign({}, p, { when: fmt(p.at) }));
        const sites = (await db.all('SELECT name FROM sites ORDER BY name')).map(x => x.name);
        res.render('bench_ticket', {
            timeline: tl, fmtTs: fmt, stuck, stuckDays: L.STUCK_DAYS(), times, prevSoon: prev || null, photos, sites, human: L.human,
            mailConfigured: notify.configured(), mailTo: notify.recipients(t), canDeletePhotos: req.session.admin === 1,
            flash: takeFlash(req), t: Object.assign({}, t, { student: nameOf(t), age: ageDays(t.created_at, t.closed_at), tone: tone(t.status), when: fmt(t.created_at), closedWhen: fmt(t.closed_at) }),
            tier: tierView(t), suggestion: suggest(t), TIERS: tiers.TIERS,
            events, history, grades: GRADES, statuses: STATUSES, priorities: PRIORITIES, people: await people(db), me: req.session.userID, isAdmin: req.session.admin === 1
        });
    }));

    const back = (res, id) => res.redirect('/bench/ticket?id=' + id);

    app.post('/bench/ticket/status', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const s = one(req.body.status, 40), note = multi(req.body.note, 600);
        if (!STATUSES.includes(s)) { flash(req, 'Choose a status from the list.', true); return back(res, t.id); }
        if (s !== t.status) {
            await db.run('UPDATE repair_tickets SET status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [s, CLOSED.includes(s) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, t.id]);
            await event(db, t.id, req, 'status', t.status + ' → ' + s);
            flash(req, 'Status is now ' + s + '.');
            if (s === READY) {
                const r = await notify.onReady(db, Object.assign({}, t, { notified_at: t.notified_at }));
                if (r.status === 'sent' || r.status === 'failed') {
                    await event(db, t.id, req, 'email', notify.describe(r));
                    flash(req, 'Status is now ' + s + '. ' + notify.describe(r), r.status === 'failed');
                }
            }
        }
        if (note) { await event(db, t.id, req, 'note', note); await touch(db, t.id); }
        back(res, t.id);
    }));

    app.post('/bench/ticket/note', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const text = multi(req.body.text, 1000);
        if (!text) flash(req, 'Write something first.', true);
        else { await event(db, t.id, req, 'note', text); await touch(db, t.id); flash(req, 'Note added.'); }
        back(res, t.id);
    }));

    app.post('/bench/ticket/assign', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const want = one(req.body.assignee, 20);
        let id = null, name = '';
        if (want === 'me') { id = req.session.userID; name = req.session.name || ''; }
        else if (want) {
            const p = (await people(db)).find(x => String(x.id) === want);
            if (!p) { flash(req, 'That person is not on the Tech Bench.', true); return back(res, t.id); }
            id = p.id; name = p.name;
        }
        const nextUrl = String(req.body.next || '') === 'workload' ? '/bench/workload' : '';
        if (id !== t.assigned_to) {
            await db.run('UPDATE repair_tickets SET assigned_to = ?, assigned_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id, name, t.id]);
            await event(db, t.id, req, 'assign', id ? 'Assigned to ' + name : 'Unassigned');
            flash(req, id ? 'Assigned to ' + name + '.' : 'Unassigned.');
        }
        if (nextUrl) return res.redirect(nextUrl);
        back(res, t.id);
    }));

    app.post('/bench/ticket/edit', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const b = req.body, model = one(b.model, 120);
        if (!model) { flash(req, 'The device model cannot be blank.', true); return back(res, t.id); }
        const grade = GRADES.includes(one(b.student_grade, 10)) ? one(b.student_grade, 10) : t.student_grade;
        const siteWant = one(b.site_name, 60);
        const siteOk = !siteWant || (await db.get('SELECT 1 AS x FROM sites WHERE name = ?', [siteWant]));
        const mailWant = String(b.notify_email || '').trim();
        if (mailWant && !L.isEmail(mailWant)) { flash(req, 'That email address does not look right.', true); return back(res, t.id); }
        const n = { site_name: siteOk ? siteWant : t.site_name, notify_email: mailWant, student_grade: grade, student_first: one(b.student_first, 40), student_last: one(b.student_last, 40), student_id: sid(b.student_id), model, serial: one(b.serial, 40), complaint: multi(b.complaint, 600), parts: one(b.parts, 400), tier: one(b.tier, 40), priority: PRIORITIES.includes(b.priority) ? b.priority : t.priority };
        { const want = tiers.num(b.tier);
          n.tier = !b.tier ? '' : want ? (want === tiers.num(t.tier) ? t.tier : tiers.label(want)) : t.tier; }
        const changed = Object.keys(n).filter(k => String(n[k]) !== String(t[k] == null ? '' : t[k]));
        if (changed.length) {
            await db.run('UPDATE repair_tickets SET model=?, serial=?, complaint=?, parts=?, tier=?, priority=?, student_first=?, student_last=?, student_id=?, student_grade=?, site_name=?, notify_email=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
                [n.model, n.serial, n.complaint, n.parts, n.tier, n.priority, n.student_first, n.student_last, n.student_id, n.student_grade, n.site_name, n.notify_email, t.id]);
            await event(db, t.id, req, 'edit', 'Changed: ' + changed.join(', '));
            flash(req, 'Ticket updated.');
        }
        back(res, t.id);
    }));

    app.post('/bench/ticket/tier', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const n = parseInt(req.body.tier, 10);
        if (!tiers.TIERS[n]) { flash(req, 'Choose a tier.', true); return back(res, t.id); }
        if (n !== tiers.num(t.tier)) {
            await db.run('UPDATE repair_tickets SET tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [tiers.label(n), t.id]);
            await event(db, t.id, req, 'tier', (t.tier ? t.tier + ' \u2192 ' : '') + tiers.label(n));
            flash(req, 'Repair tier is now ' + tiers.label(n) + '.');
        }
        back(res, t.id);
    }));

    app.post('/bench/ticket/notify', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        const r = await notify.onReady(db, t, { force: true });
        if (r.status === 'sent' || r.status === 'failed') await event(db, t.id, req, 'email', notify.describe(r));
        flash(req, notify.describe(r) || 'Email alerts are not set up yet.', r.status !== 'sent');
        back(res, t.id);
    }));

    app.post('/bench/ticket/delete', wrap(async (req, res) => {
        const db = await gate(req, res); if (!db) return;
        if (req.session.admin !== 1) { flash(req, 'Only managers can delete a ticket.', true); return back(res, req.body && req.body.id); }
        const t = await getTicket(db, req.body && req.body.id); if (!t) return res.redirect('/bench/queue');
        await L.removePhotos(db, t.id);
        await db.run('DELETE FROM ticket_events WHERE ticket_id = ?', [t.id]);
        await db.run('DELETE FROM repair_tickets WHERE id = ?', [t.id]);
        flash(req, 'Ticket #' + t.id + ' deleted.');
        res.redirect('/bench/queue');
    }));
}

module.exports = mount;
module.exports.STATUSES = STATUSES;
