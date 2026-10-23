// Certifications: who holds which certification, the page that shows and awards them,
// and the rules other pages use (which repair guides a person may open, which tickets they may be given).
const { canManage, manageableAccounts } = require('./scope');

// Keys never change (awards are stored by key), so renaming a certification keeps everyone's awards.
// required: every student must earn it. rank: repair level (Tier 1-3), used for guides and ticket assignment.
const CERTS = [
    { key: 'repair_basic', short: 'Tier 1', name: 'Tier 1 — Basic Repair', group: 'Required', required: true, rank: 1, guide: 'Cert_Tier1_Basic_Repair.pdf',
      desc: 'Keyboards, trackpads, bezels, batteries, chargers and the software fixes. Can take Tier 1 tickets.' },
    { key: 'portal', short: 'Portal', name: 'Portal Basics', group: 'Required', required: true, desc: 'Able to use the Workforce portal efficiently.' },
    { key: 'foh', short: 'RA', name: 'RA — Reception Agent', group: 'Required', required: true, guide: 'Cert_RA_Reception_Agent.pdf',
      desc: 'Runs the front desk: the Workforce portal, Incident IQ for Chromebooks, Follett Destiny for accessories.' },
    { key: 'repair_senior', short: 'Tier 2', name: 'Tier 2 — Challenging Repair', group: 'Repair', rank: 2, guide: 'Cert_Tier2_Challenging_Repair.pdf',
      desc: 'Screens, cameras, hinges, palm rests and display cables. Can take Tier 1–2 tickets.' },
    { key: 'repair_master', short: 'Tier 3', name: 'Tier 3 — Advanced Repair', group: 'Repair', rank: 3, guide: 'Cert_Tier3_Advanced_Repair.pdf',
      desc: 'System boards, daughterboards, heat sinks, liquid damage and transplants. Can take every ticket.' },
    { key: 'aplus', short: 'A+', name: 'CompTIA A+ Certification', group: 'CompTIA', desc: 'Holds the CompTIA A+ certification.' },
    { key: 'netplus', short: 'Network+', name: 'CompTIA Network+ Certification', group: 'CompTIA', desc: 'Holds the CompTIA Network+ certification.' },
    { key: 'techplus', short: 'Tech+', name: 'CompTIA Tech+ Expanding Knowledge Certification', group: 'CompTIA', desc: 'Holds the CompTIA Tech+ certification.' },
    { key: 'mgmt', short: 'Mgmt', name: 'Management Course', group: 'Other', desc: 'Demonstrates advanced management skills and is able to hold a management position.' }
];
const REQUIRED = CERTS.filter(c => c.required);
const GROUPS = [...new Set(CERTS.map(c => c.group))].map(g => ({ name: g, n: CERTS.filter(c => c.group === g).length }));
// Study guides for earning certifications (PDFs in learn-pdfs). Evaluator keys are served to managers only.
const GUIDES = [
    { title: 'Tier 1 — Basic Repair', file: 'Cert_Tier1_Basic_Repair.pdf', key: 'Cert_Tier1_Basic_Repair_Evaluator_Key.pdf', desc: 'Keyboards, trackpads, bezels, batteries, chargers and the software fixes.' },
    { title: 'Tier 2 — Challenging Repair', file: 'Cert_Tier2_Challenging_Repair.pdf', key: 'Cert_Tier2_Challenging_Repair_Evaluator_Key.pdf', desc: 'Screens, cameras, hinges, palm rests, display cables.' },
    { title: 'Tier 3 — Advanced Repair', file: 'Cert_Tier3_Advanced_Repair.pdf', key: 'Cert_Tier3_Advanced_Repair_Evaluator_Key.pdf', desc: 'System boards, daughterboards, heat sinks, liquid damage, transplants.' },
    { title: 'RA — Reception Agent', file: 'Cert_RA_Reception_Agent.pdf', key: 'Cert_RA_Reception_Agent_Evaluator_Key.pdf', desc: 'Front desk: the Workforce portal, Incident IQ and Follett Destiny.' }
];
const BY_KEY = Object.fromEntries(CERTS.map(c => [c.key, c]));
const REPAIR = CERTS.filter(c => c.rank);
const nameOf = k => BY_KEY[k] ? BY_KEY[k].name : k;

// Highest repair rank in a set of held certification keys (0 = none).
const repairRank = held => REPAIR.reduce((m, c) => held.has(c.key) ? Math.max(m, c.rank) : m, 0);
// Repair certification needed for a ticket tier: Tier 1 -> Tier 1, Tier 2 -> Tier 2, Tier 3 and 4 -> Tier 3.
const rankForTier = n => n >= 3 ? 3 : n === 2 ? 2 : n === 1 ? 1 : 0;
// Required certifications a person is missing (names).
const missingFor = held => REQUIRED.filter(c => !held.has(c.key)).map(c => c.short);
const certForRank = r => REPAIR.find(c => c.rank === r);
// Guide setting: '' (everyone) or one of the repair certification keys.
const cleanGate = v => (BY_KEY[v] && BY_KEY[v].rank) ? v : '';

let ensured = null;
function ensure(db) {
    if (!ensured) ensured = db.exec(`
        CREATE TABLE IF NOT EXISTS certifications (
          employee_id INTEGER NOT NULL, cert TEXT NOT NULL,
          awarded_by INTEGER, awarded_name TEXT DEFAULT '', awarded_at TEXT DEFAULT CURRENT_TIMESTAMP, note TEXT DEFAULT '',
          PRIMARY KEY (employee_id, cert));
        CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT,
          target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);`).catch(e => { ensured = null; throw e; });
    return ensured;
}
async function heldBy(db, id) {
    await ensure(db);
    return new Set((await db.all('SELECT cert FROM certifications WHERE employee_id = ?', [id])).map(r => r.cert));
}

// May this person open a guide that needs `gate`? Managers always can.
async function canOpen(db, session, gate) {
    if (!gate || !BY_KEY[gate] || session.admin === 1) return true;
    return repairRank(await heldBy(db, session.userID)) >= BY_KEY[gate].rank;
}

// Ticket assignment: when "tickets need a matching certification" is on, is this person certified for the ticket's tier?
async function ticketCheck(db, tierNum, assigneeId) {
    const need = rankForTier(tierNum || 0);
    if (!need) return { ok: true };
    const have = repairRank(await heldBy(db, assigneeId));
    if (have >= need) return { ok: true };
    return { ok: false, need: certForRank(need).name };
}

// People this session sees on the page. Managers: the accounts they manage (plus themselves). Everyone else: people in their programs.
async function visiblePeople(db, s, programId) {
    let rows;
    if (s.admin === 1) {
        rows = await manageableAccounts(db, s);
        if (!rows.some(r => r.id === s.userID)) rows.push(await db.get('SELECT id, name, username, is_admin, is_district FROM employees WHERE id = ?', [s.userID]));
        if (programId) {
            const ids = new Set((await db.all('SELECT DISTINCT employee_id FROM memberships WHERE program_id = ?', [programId])).map(r => r.employee_id));
            rows = rows.filter(r => ids.has(r.id));
        }
    } else {
        rows = await db.all(`SELECT DISTINCT e.id, e.name, e.is_admin FROM employees e JOIN memberships m ON m.employee_id = e.id
            WHERE m.program_id IN (SELECT program_id FROM memberships WHERE employee_id = ?) OR e.id = ? ORDER BY e.name`, [s.userID, s.userID]);
        if (!rows.length) rows = await db.all('SELECT id, name, is_admin FROM employees WHERE id = ?', [s.userID]);
    }
    return rows.filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function mount(app, getDb, wrap) {
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    // Managers may award to accounts they manage. District administrators may also award to themselves.
    const mayAward = async (db, s, id) => s.admin === 1 && (id === s.userID ? s.district === 1 : await canManage(db, s, id));

    app.get('/certifications', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb(); await ensure(db);
        const s = req.session, admin = s.admin === 1;
        const programs = admin ? await db.all('SELECT id, name FROM programs ORDER BY name') : [];
        const programId = admin ? (parseInt(req.query.program, 10) || 0) : 0;
        const people = await visiblePeople(db, s, programId);
        const ids = people.map(p => p.id);
        const held = new Map();
        if (ids.length) {
            (await db.all(`SELECT employee_id, cert, awarded_name, awarded_at, note FROM certifications WHERE employee_id IN (${ids.map(() => '?').join(',')})`, ids))
                .forEach(r => { if (!held.has(r.employee_id)) held.set(r.employee_id, new Map()); held.get(r.employee_id).set(r.cert, r); });
        }
        // Students (employees, student general managers, student managers) must hold the required certifications.
        const codes = await require('./roles').codesFor(db, people.map(p => ({ id: p.id, is_admin: p.is_admin, is_district: p.is_district }))).catch(() => new Map());
        const rows = [];
        for (const p of people) {
            const h = held.get(p.id) || new Map(), code = codes.has(p.id) ? codes.get(p.id) : (p.is_admin ? 1 : 0);
            const student = [0, 3, 4].includes(code);
            rows.push({ id: p.id, name: p.name, held: h, student, missing: student ? missingFor(h) : [], editable: admin && await mayAward(db, s, p.id) });
        }
        const meRow = rows.find(r => r.id === s.userID);
        const myMissing = meRow ? meRow.missing : missingFor(new Set((await db.all('SELECT cert FROM certifications WHERE employee_id = ?', [s.userID])).map(r => r.cert)));
        const onlyMissing = req.query.missing === '1';
        const mine = (await db.all('SELECT cert, awarded_name, awarded_at FROM certifications WHERE employee_id = ? ORDER BY awarded_at', [s.userID]))
            .filter(r => BY_KEY[r.cert]).map(r => ({ name: nameOf(r.cert), by: r.awarded_name, when: String(r.awarded_at || '').slice(0, 10) }));
        const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
        res.render('certifications', {
            flash: takeFlash(req), certs: CERTS, groups: GROUPS, required: REQUIRED, admin, programs, programId, q, mine, guides: GUIDES, myMissing, onlyMissing,
            students: rows.filter(r => r.student).length, complete: rows.filter(r => r.student && !r.missing.length).length,
            guidesOk: await require('./education').hasResources(db, s).catch(() => false),
            rows: rows.filter(r => (!q || String(r.name).toLowerCase().includes(q)) && (!onlyMissing || r.missing.length)),
            counts: Object.fromEntries(CERTS.map(c => [c.key, rows.filter(r => r.held.has(c.key)).length]))
        });
    }));

    app.post('/certifications/toggle', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb(); await ensure(db);
        const s = req.session, id = parseInt(req.body.employee, 10) || 0, cert = String(req.body.cert || '');
        // The page sends X-Requested-With: fetch so it can update the box in place (no reload, no jump to the top).
        const ajax = req.get('X-Requested-With') === 'fetch';
        const back = () => res.redirect('/certifications' + (req.body.back && /^\?[\w=&%.+-]*$/.test(req.body.back) ? req.body.back : ''));
        const fail = (msg, code) => { if (ajax) return res.status(code || 400).json({ ok: false, msg }); flash(req, msg, true); return back(); };
        if (!BY_KEY[cert]) return fail('Unknown certification.');
        if (!(await mayAward(db, s, id))) return fail('Only a manager of that account can change its certifications.', 403);
        const p = await db.get('SELECT id, name FROM employees WHERE id = ?', [id]);
        if (!p) return fail('That account no longer exists.', 404);
        const had = await db.get('SELECT 1 AS x FROM certifications WHERE employee_id = ? AND cert = ?', [id, cert]);
        const note = String(req.body.note || '').trim().slice(0, 200);
        if (had) await db.run('DELETE FROM certifications WHERE employee_id = ? AND cert = ?', [id, cert]);
        else await db.run('INSERT INTO certifications (employee_id, cert, awarded_by, awarded_name, note) VALUES (?,?,?,?,?)', [id, cert, s.userID, s.name || '', note]);
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
            [s.userID, s.name || '', p.id, p.name, had ? 'CERT_REVOKE' : 'CERT_AWARD', (had ? 'Removed ' : 'Awarded ') + nameOf(cert), note]);
        const msg = (had ? 'Removed ' : 'Awarded ') + nameOf(cert) + (had ? ' from ' : ' to ') + p.name + '.';
        const nowHeld = new Set((await db.all('SELECT cert FROM certifications WHERE employee_id = ?', [id])).map(r => r.cert));
        if (ajax) return res.json({ ok: true, held: !had, msg, missing: missingFor(nowHeld),
            tip: had ? nameOf(cert) + ' — not held' : nameOf(cert) + ' — awarded ' + new Date().toISOString().slice(0, 10) + (s.name ? ' by ' + s.name : '') });
        flash(req, msg);
        back();
    }));
}

module.exports = mount;
Object.assign(module.exports, { REQUIRED, missingFor, CERTS, BY_KEY, REPAIR, nameOf, repairRank, rankForTier, cleanGate, ensure, heldBy, canOpen, ticketCheck });
