// Photos on repair tickets (damage at check-in, work in progress, finished repair).
// Stored on the persistent disk next to the database, served only to signed-in Tech Bench members.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bench = require('./bench');
const L = require('./ticketlib');
const { sniff } = require('./education');

const MAX_PER_TICKET = 12;

function mount(app, getDb, wrap, express) {
    async function gate(req, res, json) {
        if (!req.session.userID) { json ? res.status(401).json({ ok: false, error: 'Please sign in again.' }) : res.status(403).end(); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { json ? res.status(403).json({ ok: false, error: 'Not allowed.' }) : res.status(403).end(); return null; }
        return db;
    }
    const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '8mb' });

    app.post('/bench/ticket/photo', rawImage, wrap(async (req, res) => {
        const db = await gate(req, res, true); if (!db) return;
        const id = parseInt(req.query.id, 10);
        const t = await db.get('SELECT id FROM repair_tickets WHERE id = ?', [id || 0]);
        if (!t) return res.status(404).json({ ok: false, error: 'That ticket was not found.' });
        const ext = sniff(req.body);
        if (!ext) return res.status(400).json({ ok: false, error: 'Choose a JPG, PNG, WebP or GIF picture (8 MB or less).' });
        const n = (await db.get('SELECT COUNT(*) AS n FROM ticket_photos WHERE ticket_id = ?', [t.id])).n;
        if (n >= MAX_PER_TICKET) return res.status(400).json({ ok: false, error: 'A ticket can hold ' + MAX_PER_TICKET + ' photos. Remove one first.' });
        await fs.promises.mkdir(L.uploadDir(), { recursive: true });
        const file = crypto.randomBytes(12).toString('hex') + '.' + ext;
        await fs.promises.writeFile(path.join(L.uploadDir(), file), req.body);
        const caption = L.one(req.query.caption, 80);
        const r = await db.run('INSERT INTO ticket_photos (ticket_id, file, caption, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?)', [t.id, file, caption, req.session.userID, req.session.name || '']);
        await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, req.session.userID, req.session.name || '', 'photo', 'Added a photo' + (caption ? ': ' + caption : '')]);
        await db.run('UPDATE repair_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
        res.json({ ok: true, id: r.lastID });
    }));

    app.get('/bench/photo/:file', wrap(async (req, res) => {
        const db = await gate(req, res, false); if (!db) return;
        if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(req.params.file)) return res.status(404).end();
        const row = await db.get('SELECT id FROM ticket_photos WHERE file = ?', [req.params.file]);
        if (!row) return res.status(404).end();
        res.sendFile(path.join(L.uploadDir(), req.params.file), { headers: { 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } },
            err => { if (err && !res.headersSent) res.status(404).end(); });
    }));

    app.post('/bench/ticket/photo/delete', wrap(async (req, res) => {
        const db = await gate(req, res, false); if (!db) return;
        const p = await db.get('SELECT * FROM ticket_photos WHERE id = ?', [parseInt((req.body || {}).id, 10) || 0]);
        if (!p) return res.redirect('/bench/queue');
        if (req.session.admin === 1 || p.uploaded_by === req.session.userID) {
            await fs.promises.unlink(path.join(L.uploadDir(), p.file)).catch(() => {});
            await db.run('DELETE FROM ticket_photos WHERE id = ?', [p.id]);
            await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [p.ticket_id, req.session.userID, req.session.name || '', 'photo', 'Removed a photo']);
            req.session.flash = { msg: 'Photo removed.', bad: false };
        } else req.session.flash = { msg: 'Only the person who added a photo, or a manager, can remove it.', bad: true };
        res.redirect('/bench/ticket?id=' + p.ticket_id);
    }));
}

module.exports = mount;
