// One-time clean-up: moves every ticket that is "Repaired - Ready for Pickup" to "Returned to Student" (closed).
//   node close_ready.js          shows what it WOULD change (changes nothing)
//   node close_ready.js --yes    does it
// Uses the same database as the portal (DB_PATH, or ./timecards.db).
const file = process.env.DB_PATH || './timecards.db';
const FROM = 'Repaired - Ready for Pickup', TO = 'Returned to Student';
const apply = process.argv.includes('--yes');

async function open() {
    try {
        const sqlite3 = require('sqlite3'), { open } = require('sqlite');
        const db = await open({ filename: file, driver: sqlite3.Database });
        return { all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p), exec: s => db.exec(s), close: () => db.close() };
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
        const { DatabaseSync } = require('node:sqlite'), d = new DatabaseSync(file);
        return { all: async (s, p = []) => d.prepare(s).all(...p), run: async (s, p = []) => d.prepare(s).run(...p), exec: async s => d.exec(s), close: async () => d.close() };
    }
}

(async () => {
    const db = await open();
    const rows = await db.all('SELECT id, model, serial, student_first, student_last FROM repair_tickets WHERE status = ? ORDER BY id', [FROM]);
    console.log(rows.length + ' ticket(s) are "' + FROM + '":');
    rows.forEach(t => console.log('  #' + t.id + '  ' + t.model + (t.serial ? ' (' + t.serial + ')' : '') + (t.student_first ? '  - ' + t.student_first + ' ' + t.student_last : '')));
    if (!rows.length) return db.close();
    if (!apply) { console.log('\nNothing changed. Run again with --yes to move these to "' + TO + '".'); return db.close(); }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.exec('BEGIN');
    try {
        for (const t of rows) {
            await db.run('UPDATE repair_tickets SET status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?', [TO, now, t.id, FROM]);
            await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, null, 'Clean-up script', 'status', FROM + ' → ' + TO]);
            await db.run('INSERT INTO ticket_events (ticket_id, user_id, user_name, kind, text) VALUES (?,?,?,?,?)', [t.id, null, 'Clean-up script', 'note', 'Closed in bulk (one-time clean-up of ready-for-pickup tickets).']);
        }
        await db.exec('COMMIT');
    } catch (e) { await db.exec('ROLLBACK'); throw e; }
    console.log('\nDone. ' + rows.length + ' ticket(s) are now "' + TO + '".');
    await db.close();
})().catch(e => { console.error('Failed, nothing was changed:', e.message); process.exit(1); });
