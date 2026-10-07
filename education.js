// education.js - repair guides, videos, quick references and the Quick Links page.
// Anyone signed in can read. Managers and district administrators can add and edit.
// Pictures uploaded into guides are stored next to the database (on Render's persistent disk).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { esc } = require('./ui');

const HARDWARE = ['LCD Screen Repair', 'LCD Cable Repair', 'Camera Board Replacement', 'Camera Cable Replacement', 'Motherboard Replacement',
    'Daughterboard Replacement', 'Battery Replacement', 'Bottom Assembly Replacement', 'Midframe Assembly', 'Top Assembly',
    'Network Board Replacement', 'Keyboard Replacement', 'Trackpad Replacement', 'Trackpad Cable Replacement', 'Hinge Replacement',
    'Bezel Replacement', 'Speaker Replacement', 'Heatsink Replacement'];
const SOFTWARE = ['Device Powerwash', 'Wifi Technical Difficulties', 'Keyboard International Registration', 'Diagnostics'];
const AREAS = ['IncidentIQ', 'Hardware repair', 'Software repair', 'Parts & ordering', 'General'];
const KINDS = { repair: 'Repair guide', video: 'Video', reference: 'Quick reference' };

const DEVICES = [
    'Acer Chromebook 511 (C741L/C741LT)', 'Acer Chromebook 311 (C722/C722T)', 'Acer Chromebook Spin 514', 'Acer Chromebook 514',
    'ASUS Chromebook CX34 Flip (CX3401/3401FBA)', 'ASUS Chromebook Enterprise CB34 Flip (CB3401)', 'ASUS Chromebook C204',
    'CTL Chromebook Plus PX141GX / PX141GXT', 'CTL Chromebook Enterprise/PX14E/PX14EX/PX14EXT', 'CTL Chromebook PX121E', 'CTL Chromebook NL73',
    'HP Chromebook 11MK G9 EE', 'HP Chromebook 11 G9 EE', 'HP Chromebook 11 G8 EE', 'HP Chromebook 11A G8 EE', 'HP Chromebook 11 G7 EE',
    'HP Chromebook 11A G6 EE', 'HP Elite c640 14 inch G3 Chromebook', 'HP Pro c640 Chromebook + Enterprise',
    'HP Fortis G1i 14 Chromebook + Enterprise', 'HP Fortis 14 G10 Chromebook',
    'Lenovo 14e Chromebook Gen 3', 'Lenovo Chromebook Duet EDU G2', 'Lenovo 500e Chromebook', 'Lenovo 300e/N23 Yoga/Flex 11 Chromebook',
    'Lenovo 100e Chromebook Gen 4 (Intel)', 'Lenovo 100e Gen 2 AST', 'Lenovo 100e Gen 2', 'Lenovo 100e Chromebook'
];
const brandOf = name => { const w = String(name).trim().split(/\s+/)[0]; return w || 'Other'; };

// ---------- Text helpers (exported for tests) ----------
function inline(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
const safeImg = u => /^\/learn\/file\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u);

// Plain-text guide format:  ## Heading   1. Step   - bullet   > note   ![caption](picture)   **bold**
function renderBody(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let html = '', list = null;
    const close = () => { if (list) { html += '</' + list + '>'; list = null; } };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { close(); continue; }
        let m;
        if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) {
            close();
            if (safeImg(m[2])) html += '<figure><img src="' + esc(m[2]) + '" alt="' + esc(m[1]) + '" loading="lazy">' + (m[1] ? '<figcaption>' + esc(m[1]) + '</figcaption>' : '') + '</figure>';
            continue;
        }
        if ((m = line.match(/^##\s+(.*)$/))) { close(); html += '<h3>' + inline(m[1]) + '</h3>'; continue; }
        if ((m = line.match(/^>\s?(.*)$/))) { close(); html += '<div class="callout">' + inline(m[1]) + '</div>'; continue; }
        if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) {
            if (list !== 'ol') { close(); html += '<ol class="steps" start="' + parseInt(m[1], 10) + '">'; list = 'ol'; }
            html += '<li>' + inline(m[2]) + '</li>';
            continue;
        }
        if ((m = line.match(/^[-*]\s+(.*)$/))) {
            if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
            html += '<li>' + inline(m[1]) + '</li>';
            continue;
        }
        close();
        html += '<p>' + inline(line) + '</p>';
    }
    close();
    return html;
}

// Web address typed by an admin: '' if blank, null if not a usable http(s) address.
function cleanUrl(s) {
    s = String(s || '').trim();
    if (!s) return '';
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
}

// Address that can be shown inside the page (YouTube or a Google Drive video), otherwise null.
function embedOf(url) {
    let u;
    try { u = new URL(String(url || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.replace(/^www\./, '');
    const ok = id => id && /^[\w-]{6,}$/.test(id);
    if (h === 'youtube.com' || h === 'm.youtube.com') {
        let id = u.searchParams.get('v');
        if (!id) { const m = u.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)/); id = m && m[1]; }
        if (ok(id)) return 'https://www.youtube-nocookie.com/embed/' + id;
    }
    if (h === 'youtu.be') { const id = u.pathname.slice(1); if (ok(id)) return 'https://www.youtube-nocookie.com/embed/' + id; }
    if (h === 'drive.google.com') {
        const m = u.pathname.match(/^\/file\/d\/([\w-]+)/);
        if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    }
    return null;
}

function sniff(b) {
    if (!Buffer.isBuffer(b) || b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
    return null;
}

// Which programs' resources this person may see: { all: true } or { ids: [...] }.
// Employees: their programs. Managers: the programs they manage (a site-wide scope means every program). District: everything.
async function programAccess(db, s) {
    if (!s || !s.userID) return { all: false, ids: [] };
    if (s.district === 1) return { all: true, ids: [] };
    let rows;
    if (s.admin === 1) {
        if (await db.get('SELECT 1 FROM scopes WHERE employee_id = ? AND program_id IS NULL', [s.userID])) return { all: true, ids: [] };
        rows = await db.all('SELECT DISTINCT program_id FROM scopes WHERE employee_id = ?', [s.userID]);
    } else {
        rows = await db.all('SELECT DISTINCT program_id FROM memberships WHERE employee_id = ?', [s.userID]);
    }
    return { all: false, ids: rows.map(r => r.program_id).filter(x => x != null) };
}
const hasResources = async (db, s) => { const a = await programAccess(db, s); return a.all || a.ids.length > 0; };
const sees = (acc, pid) => acc.all || pid == null || acc.ids.includes(pid);
// SQL condition limiting a table (by alias) to what the person can see
const visSql = (acc, a) => acc.all ? { sql: '1=1', params: [] }
    : { sql: '(' + a + '.program_id IS NULL' + (acc.ids.length ? ' OR ' + a + '.program_id IN (' + acc.ids.map(() => '?').join(',') + ')' : '') + ')', params: acc.ids };

function mount(app, getDb, wrap, express) {
    const uploadDir = path.join(path.dirname(path.resolve(process.env.DB_PATH || './timecards.db')), 'learn-uploads');
    let ready = null;
    async function database() {
        const db = getDb();
        if (!ready) {
            ready = (async () => {
                await db.exec(`
                    CREATE TABLE IF NOT EXISTS devices (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                      brand TEXT NOT NULL,
                      program_id INTEGER
                    );
                    CREATE TABLE IF NOT EXISTS guides (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      kind TEXT NOT NULL,
                      device_id INTEGER,
                      program_id INTEGER,
                      topic TEXT NOT NULL DEFAULT '',
                      area TEXT NOT NULL DEFAULT '',
                      title TEXT NOT NULL,
                      body TEXT NOT NULL DEFAULT '',
                      video_url TEXT NOT NULL DEFAULT '',
                      link_url TEXT NOT NULL DEFAULT '',
                      updated_by TEXT NOT NULL DEFAULT '',
                      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE INDEX IF NOT EXISTS idx_guides_device ON guides(device_id);
                    CREATE TABLE IF NOT EXISTS quick_links (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      group_name TEXT NOT NULL,
                      title TEXT NOT NULL,
                      url TEXT NOT NULL,
                      note TEXT NOT NULL DEFAULT '',
                      audience TEXT NOT NULL DEFAULT 'all',
                      sort INTEGER NOT NULL DEFAULT 0,
                      program_id INTEGER
                    );
                `);
                // The existing content belongs to the Student Tech Work Bench program.
                const tb = await db.get(`SELECT id FROM programs WHERE name = 'Student Tech Work Bench'`);
                const tbId = tb ? tb.id : null;
                for (const t of ['devices', 'guides', 'quick_links']) {
                    const cols = await db.all('PRAGMA table_info(' + t + ')');
                    if (!cols.some(c => c.name === 'program_id')) {
                        await db.exec('ALTER TABLE ' + t + ' ADD COLUMN program_id INTEGER');
                        if (tbId) await db.run('UPDATE ' + t + ' SET program_id = ?', [tbId]);
                    }
                }
                const n = await db.get('SELECT COUNT(*) AS n FROM devices');
                if (!n.n) for (const name of DEVICES) await db.run('INSERT OR IGNORE INTO devices (name, brand, program_id) VALUES (?, ?, ?)', [name, brandOf(name), tbId]);
                const l = await db.get('SELECT COUNT(*) AS n FROM quick_links');
                if (!l.n) {
                    await db.run('INSERT INTO quick_links (group_name, title, url, note, audience, sort, program_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        ['Admin', 'Master Administrative Sheet', 'https://docs.google.com/spreadsheets/d/1irEPQWWmxiwcHXBbnp0n-p4AoVtV-XCxZPz7OSNYLBA/edit',
                            'Part ordering, part usage, inventory and repair logging.', 'admin', 0, tbId]);
                }
            })().catch(err => { ready = null; throw err; });
        }
        await ready;
        return db;
    }

    const loggedIn = (req, res) => { if (!req.session.userID) { res.redirect('/'); return false; } return true; };
    const isAdmin = req => req.session.admin === 1;
    const needAdmin = (req, res) => { if (!loggedIn(req, res)) return true; if (!isAdmin(req)) { res.redirect('/learn'); return true; } return false; };
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const likeEsc = s => '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';

    const canEditProgram = (acc, req, pid) => pid == null ? req.session.district === 1 : (acc.all || acc.ids.includes(pid));
    // Programs this person may add pages to (name list for the forms)
    async function myPrograms(db, acc) {
        const all = await db.all('SELECT id, name FROM programs ORDER BY name');
        return acc.all ? all : all.filter(p => acc.ids.includes(p.id));
    }

    // ---------- Hub ----------
    app.get('/learn', wrap(async (req, res) => {
        if (!loggedIn(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const vg = visSql(acc, 'g'), vd = visSql(acc, 'd');
        const q = String(req.query.q || '').trim().slice(0, 80);
        let results = null;
        if (q) {
            const p = likeEsc(q);
            results = await db.all(
                `SELECT g.id, g.kind, g.title, g.topic, g.area, d.name AS device_name FROM guides g LEFT JOIN devices d ON d.id = g.device_id
                 WHERE (g.title LIKE ? ESCAPE '\\' OR g.topic LIKE ? ESCAPE '\\' OR g.body LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\') AND ${vg.sql}
                 ORDER BY g.kind, g.title LIMIT 60`, [p, p, p, p, ...vg.params]);
            results = results.map(r => ({ ...r, kindName: KINDS[r.kind] || r.kind }));
        }
        const devices = await db.all(
            `SELECT d.id, d.name, d.brand, (SELECT COUNT(*) FROM guides x WHERE x.device_id = d.id AND x.kind = 'repair') AS n FROM devices d WHERE ${vd.sql} ORDER BY d.brand, d.name`, vd.params);
        const brands = [];
        devices.forEach(d => {
            let b = brands.find(x => x.brand === d.brand);
            if (!b) { b = { brand: d.brand, devices: [] }; brands.push(b); }
            b.devices.push(d);
        });
        const general = (await db.get(`SELECT COUNT(*) AS n FROM guides g WHERE g.kind = 'repair' AND g.device_id IS NULL AND ${vg.sql}`, vg.params)).n;
        const videos = await db.all(`SELECT g.id, g.title, g.area FROM guides g WHERE g.kind = 'video' AND ${vg.sql} ORDER BY g.area, g.title`, vg.params);
        const refs = await db.all(`SELECT g.id, g.title, g.area FROM guides g WHERE g.kind = 'reference' AND ${vg.sql} ORDER BY g.area, g.title`, vg.params);
        res.render('learn_hub', { flash: takeFlash(req), isAdmin: isAdmin(req), q, results, brands, general, videos, refs });
    }));

    // ---------- One device ----------
    app.get('/learn/device', wrap(async (req, res) => {
        if (!loggedIn(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const vg = visSql(acc, 'g');
        const id = parseInt(req.query.id, 10) || 0;
        let device = { id: 0, name: 'General (all devices)' };
        if (id) {
            device = await db.get('SELECT id, name, program_id FROM devices WHERE id = ?', [id]);
            if (!device || !sees(acc, device.program_id)) return res.redirect('/learn');
        }
        const rows = id
            ? await db.all(`SELECT g.id, g.topic, g.title FROM guides g WHERE g.kind = 'repair' AND g.device_id = ? AND ${vg.sql} ORDER BY g.title`, [id, ...vg.params])
            : await db.all(`SELECT g.id, g.topic, g.title FROM guides g WHERE g.kind = 'repair' AND g.device_id IS NULL AND ${vg.sql} ORDER BY g.title`, vg.params);
        const section = (label, topics) => ({
            label,
            items: topics.map(t => ({ topic: t, guides: rows.filter(r => r.topic === t) }))
        });
        const sections = [section('Hardware repair', HARDWARE), section('Software repair', SOFTWARE)];
        const known = new Set(HARDWARE.concat(SOFTWARE));
        const other = rows.filter(r => !known.has(r.topic));
        const others = await db.all(`SELECT g.id, g.kind, g.title FROM guides g WHERE g.kind != 'repair' AND g.device_id ${id ? '= ?' : 'IS NULL'} AND ${vg.sql} ORDER BY g.title`,
            id ? [id, ...vg.params] : vg.params);
        res.render('learn_device', {
            flash: takeFlash(req), isAdmin: isAdmin(req) && (id ? canEditProgram(acc, req, device.program_id) : true), device, sections, other,
            others: others.map(o => ({ ...o, kindName: KINDS[o.kind] }))
        });
    }));

    // ---------- One guide ----------
    app.get('/learn/guide', wrap(async (req, res) => {
        if (!loggedIn(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const g = await db.get(
            `SELECT g.*, d.name AS device_name, p.name AS program_name FROM guides g LEFT JOIN devices d ON d.id = g.device_id
             LEFT JOIN programs p ON p.id = g.program_id WHERE g.id = ?`, [parseInt(req.query.id, 10) || 0]);
        if (!g || !sees(acc, g.program_id)) return res.redirect('/learn');
        res.render('learn_guide', {
            flash: takeFlash(req), isAdmin: isAdmin(req) && canEditProgram(acc, req, g.program_id), g, kindName: KINDS[g.kind] || g.kind,
            bodyHtml: renderBody(g.body), embed: embedOf(g.video_url), updated: String(g.updated_at || '').slice(0, 10)
        });
    }));

    // ---------- Edit form / save / delete ----------
    app.get('/learn/edit', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const vd = visSql(acc, 'd');
        const devices = await db.all(`SELECT d.id, d.name, d.program_id FROM devices d WHERE ${vd.sql} ORDER BY d.brand, d.name`, vd.params);
        const progs = await myPrograms(db, acc);
        const id = parseInt(req.query.id, 10) || 0;
        let g;
        if (id) {
            g = await db.get('SELECT * FROM guides WHERE id = ?', [id]);
            if (!g || !canEditProgram(acc, req, g.program_id)) return res.redirect('/learn');
        } else {
            const kind = KINDS[req.query.kind] ? req.query.kind : 'repair';
            const dev = devices.find(d => d.id === (parseInt(req.query.device, 10) || 0));
            const topic = HARDWARE.concat(SOFTWARE).includes(req.query.topic) ? req.query.topic : '';
            g = { id: 0, kind, device_id: dev ? dev.id : null, program_id: dev ? dev.program_id : (progs[0] ? progs[0].id : null), topic, area: '', title: topic, body: '', video_url: '', link_url: '' };
        }
        res.render('learn_edit', { flash: takeFlash(req), g, devices, progs, canEveryone: req.session.district === 1, HARDWARE, SOFTWARE, AREAS, KINDS, isNew: !id });
    }));

    app.post('/learn/save', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const b = req.body || {};
        const id = parseInt(b.id, 10) || 0;
        const back = id ? '/learn/edit?id=' + id : '/learn/edit?kind=' + encodeURIComponent(b.kind || 'repair');
        const fail = msg => { flash(req, msg, true); return res.redirect(back); };

        const kind = KINDS[b.kind] ? b.kind : null;
        if (!kind) return fail('Choose what kind of page this is.');
        let programId = b.program_id === '' || b.program_id === undefined ? null : (parseInt(b.program_id, 10) || null);
        let deviceId = parseInt(b.device_id, 10) || null;
        if (deviceId) {
            const dv = await db.get('SELECT id, program_id FROM devices WHERE id = ?', [deviceId]);
            if (!dv || !sees(acc, dv.program_id)) deviceId = null;
            else programId = dv.program_id;   // a device's pages belong to the device's program
        }
        if (programId && !(await db.get('SELECT 1 FROM programs WHERE id = ?', [programId]))) programId = null;
        if (!canEditProgram(acc, req, programId)) return fail('Choose which program this page is for.');
        if (id) {
            const old = await db.get('SELECT program_id FROM guides WHERE id = ?', [id]);
            if (!old) return res.redirect('/learn');
            if (!canEditProgram(acc, req, old.program_id)) return res.redirect('/learn');
        }

        let topic = '', area = '';
        if (kind === 'repair') {
            topic = String(b.topic || '');
            if (!HARDWARE.concat(SOFTWARE).includes(topic)) return fail('Choose which repair this guide covers.');
            area = HARDWARE.includes(topic) ? 'Hardware repair' : 'Software repair';
        } else {
            area = AREAS.includes(b.area) ? b.area : 'General';
        }
        let title = String(b.title || '').trim().replace(/\s+/g, ' ');
        if (!title && kind === 'repair') title = topic;
        if (title.length < 3 || title.length > 120) return fail('Give the page a title (3 to 120 characters).');
        const body = String(b.body || '').replace(/\r/g, '').slice(0, 20000);
        const video = cleanUrl(b.video_url), link = cleanUrl(b.link_url);
        if (video === null) return fail('The video address is not a valid web address.');
        if (link === null) return fail('The link address is not a valid web address.');
        if (kind === 'video' && !video) return fail('Paste the video address (YouTube or Google Drive).');
        if (kind === 'reference' && !body.trim() && !link) return fail('Add some text or a link to the reference.');
        if (kind === 'repair' && !body.trim() && !video && !link) return fail('Add the steps, a video, or a link.');

        let gid = id;
        if (id) {
            await db.run(
                `UPDATE guides SET kind=?, device_id=?, program_id=?, topic=?, area=?, title=?, body=?, video_url=?, link_url=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
                [kind, deviceId, programId, topic, area, title, body, video, link, req.session.name || '', id]);
        } else {
            const r = await db.run(
                `INSERT INTO guides (kind, device_id, program_id, topic, area, title, body, video_url, link_url, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [kind, deviceId, programId, topic, area, title, body, video, link, req.session.name || '']);
            gid = r.lastID;
        }
        flash(req, 'Saved.');
        res.redirect('/learn/guide?id=' + gid);
    }));

    app.post('/learn/delete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const g = await db.get('SELECT id, kind, device_id, program_id FROM guides WHERE id = ?', [parseInt(req.body.id, 10) || 0]);
        if (g && canEditProgram(acc, req, g.program_id)) {
            await db.run('DELETE FROM guides WHERE id = ?', [g.id]);
            flash(req, 'Deleted.');
            return res.redirect(g.kind === 'repair' ? '/learn/device?id=' + (g.device_id || 0) : '/learn');
        }
        res.redirect('/learn');
    }));

    // ---------- Devices ----------
    app.get('/learn/devices', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const vd = visSql(acc, 'd');
        const devices = await db.all(
            `SELECT d.id, d.name, d.brand, d.program_id, p.name AS program_name, (SELECT COUNT(*) FROM guides g WHERE g.device_id = d.id) AS n
             FROM devices d LEFT JOIN programs p ON p.id = d.program_id WHERE ${vd.sql} ORDER BY d.brand, d.name`, vd.params);
        res.render('learn_devices', {
            flash: takeFlash(req), progs: await myPrograms(db, acc),
            devices: devices.map(d => ({ ...d, editable: canEditProgram(acc, req, d.program_id) }))
        });
    }));

    app.post('/learn/devices/add', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
        const pid = parseInt(req.body.program_id, 10) || null;
        if (name.length < 3 || name.length > 100) flash(req, 'Enter the device name (3 to 100 characters).', true);
        else if (!pid || !canEditProgram(acc, req, pid)) flash(req, 'Choose which program this device belongs to.', true);
        else if (await db.get('SELECT 1 FROM devices WHERE name = ?', [name])) flash(req, 'That device is already in the list.', true);
        else { await db.run('INSERT INTO devices (name, brand, program_id) VALUES (?, ?, ?)', [name, brandOf(name), pid]); flash(req, 'Added ' + name + '.'); }
        res.redirect('/learn/devices');
    }));

    app.post('/learn/devices/rename', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const id = parseInt(req.body.id, 10) || 0;
        const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
        const dv = await db.get('SELECT id, program_id FROM devices WHERE id = ?', [id]);
        if (!dv || !canEditProgram(acc, req, dv.program_id)) flash(req, 'That device is not available to you.', true);
        else if (name.length < 3 || name.length > 100) flash(req, 'Enter the device name (3 to 100 characters).', true);
        else if (await db.get('SELECT 1 FROM devices WHERE name = ? AND id != ?', [name, id])) flash(req, 'Another device already has that name.', true);
        else { await db.run('UPDATE devices SET name = ?, brand = ? WHERE id = ?', [name, brandOf(name), id]); flash(req, 'Renamed.'); }
        res.redirect('/learn/devices');
    }));

    app.post('/learn/devices/delete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const id = parseInt(req.body.id, 10) || 0;
        const dv = await db.get('SELECT id, program_id FROM devices WHERE id = ?', [id]);
        const n = await db.get('SELECT COUNT(*) AS n FROM guides WHERE device_id = ?', [id]);
        if (!dv || !canEditProgram(acc, req, dv.program_id)) flash(req, 'That device is not available to you.', true);
        else if (n.n) flash(req, 'That device still has pages. Delete or move them first.', true);
        else { await db.run('DELETE FROM devices WHERE id = ?', [id]); flash(req, 'Device removed.'); }
        res.redirect('/learn/devices');
    }));

    // ---------- Pictures ----------
    const adminOnlyJson = (req, res, next) => {
        if (!req.session.userID || req.session.admin !== 1) return res.status(403).json({ error: 'Not allowed.' });
        next();
    };
    const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '8mb' });
    app.post('/learn/upload', adminOnlyJson, rawImage, wrap(async (req, res) => {
        const ext = sniff(req.body);
        if (!ext) return res.status(400).json({ error: 'Choose a JPG, PNG, WebP or GIF picture (8 MB or less).' });
        await fs.promises.mkdir(uploadDir, { recursive: true });
        const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
        await fs.promises.writeFile(path.join(uploadDir, name), req.body);
        res.json({ url: '/learn/file/' + name });
    }));

    app.get('/learn/file/:name', (req, res) => {
        if (!req.session.userID) return res.status(403).end();
        if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(req.params.name)) return res.status(404).end();
        res.sendFile(path.join(uploadDir, req.params.name), { headers: { 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } },
            err => { if (err && !res.headersSent) res.status(404).end(); });
    });

    // ---------- Quick links ----------
    app.get('/links', wrap(async (req, res) => {
        if (!loggedIn(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const v = visSql(acc, 'l');
        const rows = await db.all(
            `SELECT l.*, p.name AS program_name FROM quick_links l LEFT JOIN programs p ON p.id = l.program_id
             WHERE ${v.sql} ${isAdmin(req) ? '' : `AND l.audience = 'all'`} ORDER BY l.group_name, l.sort, l.title`, v.params);
        const groups = [];
        rows.forEach(r => {
            let g = groups.find(x => x.name === r.group_name);
            if (!g) { g = { name: r.group_name, items: [] }; groups.push(g); }
            g.items.push({ ...r, editable: isAdmin(req) && canEditProgram(acc, req, r.program_id) });
        });
        res.render('links', {
            flash: takeFlash(req), isAdmin: isAdmin(req), groups, groupNames: groups.map(g => g.name),
            progs: isAdmin(req) ? await myPrograms(db, acc) : [], canEveryone: req.session.district === 1
        });
    }));

    app.post('/links/save', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const b = req.body || {};
        const id = parseInt(b.id, 10) || 0;
        const group = String(b.group_name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const title = String(b.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const url = cleanUrl(b.url);
        const note = String(b.note || '').trim().slice(0, 200);
        const audience = b.audience === 'admin' ? 'admin' : 'all';
        let pid = b.program_id === '' || b.program_id === undefined ? null : (parseInt(b.program_id, 10) || null);
        if (pid && !(await db.get('SELECT 1 FROM programs WHERE id = ?', [pid]))) pid = null;
        const old = id ? await db.get('SELECT program_id FROM quick_links WHERE id = ?', [id]) : null;
        if (!group || title.length < 2) flash(req, 'Give the link a group and a title.', true);
        else if (!url) flash(req, 'Enter a full web address starting with https://', true);
        else if (!canEditProgram(acc, req, pid) || (old && !canEditProgram(acc, req, old.program_id))) flash(req, 'Choose which program this link is for.', true);
        else if (id && old) {
            await db.run('UPDATE quick_links SET group_name=?, title=?, url=?, note=?, audience=?, program_id=? WHERE id=?', [group, title, url, note, audience, pid, id]);
            flash(req, 'Link updated.');
        } else if (!id) {
            await db.run('INSERT INTO quick_links (group_name, title, url, note, audience, program_id) VALUES (?,?,?,?,?,?)', [group, title, url, note, audience, pid]);
            flash(req, 'Link added.');
        }
        res.redirect('/links');
    }));

    app.post('/links/delete', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const acc = await programAccess(db, req.session);
        const l = await db.get('SELECT id, program_id FROM quick_links WHERE id = ?', [parseInt(req.body.id, 10) || 0]);
        if (l && canEditProgram(acc, req, l.program_id)) { await db.run('DELETE FROM quick_links WHERE id = ?', [l.id]); flash(req, 'Link removed.'); }
        res.redirect('/links');
    }));
}

module.exports = mount;
module.exports.programAccess = programAccess;
module.exports.hasResources = hasResources;
module.exports.renderBody = renderBody;
module.exports.embedOf = embedOf;
module.exports.cleanUrl = cleanUrl;
module.exports.sniff = sniff;
