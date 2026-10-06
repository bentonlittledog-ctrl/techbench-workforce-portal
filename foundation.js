// foundation.js - restart-proof logins, daily backups, and admin password reset.
// Wired into index.js with two one-line edits (see install steps).
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const ejs = require('ejs');

const SESSION_HOURS = 12;   // how long a login lasts
const BACKUP_KEEP = 14;     // how many daily backups to keep on the disk

// ---------- 1. Login sessions stored in the same SQLite database ----------
class SqliteStore extends session.Store {
    constructor(getDb) {
        super();
        this.getDb = getDb;
        this.ready = null;
    }

    async table() {
        const db = this.getDb();
        if (!this.ready) {
            this.ready = db.exec(
                'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)'
            ).catch(err => { this.ready = null; throw err; });
        }
        await this.ready;
        return db;
    }

    get(sid, cb) {
        this.table()
            .then(db => db.get('SELECT sess FROM sessions WHERE sid = ? AND expires > ?', [sid, Date.now()]))
            .then(row => cb(null, row ? JSON.parse(row.sess) : null))
            .catch(err => cb(err));
    }

    set(sid, sess, cb) {
        const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
        this.table()
            .then(db => db.run('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)', [sid, JSON.stringify(sess), expires]))
            .then(() => cb && cb(null))
            .catch(err => cb && cb(err));
    }

    touch(sid, sess, cb) {
        const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
        this.table()
            .then(db => db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid]))
            .then(() => cb && cb(null))
            .catch(err => cb && cb(err));
    }

    destroy(sid, cb) {
        this.table()
            .then(db => db.run('DELETE FROM sessions WHERE sid = ?', [sid]))
            .then(() => cb && cb(null))
            .catch(err => cb && cb(err));
    }
}

// ---------- 2. Backups ----------
function backupDir() {
    return path.join(path.dirname(path.resolve(process.env.DB_PATH || './timecards.db')), 'backups');
}

async function runDailyBackup(db) {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'timecards-' + new Date().toISOString().slice(0, 10) + '.db');
    if (!fs.existsSync(file)) {
        await db.run('VACUUM INTO ?', [file]);
        console.log('Daily backup written:', file);
    }
    const files = fs.readdirSync(dir).filter(f => /^timecards-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - BACKUP_KEEP)).forEach(f => fs.unlinkSync(path.join(dir, f)));
}

// Removes live login sessions from a copy of the database before it is downloaded
function scrubSessions(file) {
    return new Promise(resolve => {
        const copy = new sqlite3.Database(file, err => {
            if (err) return resolve();
            copy.run('DELETE FROM sessions', () => copy.close(() => resolve()));
        });
    });
}

// ---------- 3. Password reset page ----------
const RESET_TPL =
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Reset a Password</title>' +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css">' +
    '</head><body><p><a href="/dashboard">&larr; Back to dashboard</a></p>' + `
<h2>Reset an Account Password</h2>
<% if (message) { %><p><strong><%= message %></strong></p><% } %>
<form action="/admin/users/reset" method="POST">
  <label for="employeeId">Account</label>
  <select id="employeeId" name="employeeId" required>
    <option value="">-- Choose account --</option>
    <% users.forEach(u => { %>
      <option value="<%= u.id %>"><%= u.name %> (<%= u.username %>)</option>
    <% }) %>
  </select>
  <label for="password">New temporary password (at least 8 characters)</label>
  <input type="password" id="password" name="password" minlength="8" required>
  <label for="confirm">Type it again</label>
  <input type="password" id="confirm" name="confirm" minlength="8" required>
  <button type="submit">Reset Password</button>
</form>
<p>Give the person their new password in person. Accounts can't change their own password yet.</p>
</body></html>`;

const RESET_MESSAGES = {
    ok: 'Password updated.',
    short: 'Passwords must be at least 8 characters.',
    mismatch: 'The two passwords did not match.',
    none: 'Please choose an account.'
};

function mount(app, getDb, wrap) {
    // Permission hook: later this will check the manager's site/program scope.
    const canManage = (req, targetId) => req.session.admin === 1;

    // Daily backup (first check 15 seconds after start, then hourly) and old-session cleanup
    const tick = async () => {
        try {
            const db = getDb();
            if (!db) return;
            await runDailyBackup(db);
            await db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {});
        } catch (err) {
            console.error('Backup failed:', err.message);
        }
    };
    setTimeout(tick, 15000).unref();
    setInterval(tick, 60 * 60 * 1000).unref();

    // Download a fresh copy of the whole database (admins only)
    app.get('/admin/backup', wrap(async (req, res) => {
        if (req.session.admin !== 1) return res.redirect('/');
        const db = getDb();
        const tmp = path.join(os.tmpdir(), 'timecards-download-' + Date.now() + '.db');
        await db.run('VACUUM INTO ?', [tmp]);
        await scrubSessions(tmp);
        const name = 'timecards-' + new Date().toISOString().slice(0, 10) + '.db';
        res.download(tmp, name, () => fs.unlink(tmp, () => {}));
    }));

    // Admin password reset
    app.get('/admin/users/reset', wrap(async (req, res) => {
        if (req.session.admin !== 1) return res.redirect('/');
        const users = await getDb().all('SELECT id, name, username FROM employees ORDER BY name');
        res.send(ejs.render(RESET_TPL, {
            users,
            message: RESET_MESSAGES[req.query.msg] || null
        }));
    }));

    app.post('/admin/users/reset', wrap(async (req, res) => {
        if (req.session.admin !== 1) return res.redirect('/');
        const db = getDb();
        const id = parseInt(req.body.employeeId, 10);
        const password = String(req.body.password || '');
        const confirm = String(req.body.confirm || '');

        if (!id) return res.redirect('/admin/users/reset?msg=none');
        if (password.length < 8) return res.redirect('/admin/users/reset?msg=short');
        if (password !== confirm) return res.redirect('/admin/users/reset?msg=mismatch');

        const target = await db.get('SELECT id FROM employees WHERE id = ?', [id]);
        if (!target || !canManage(req, id)) return res.redirect('/admin/users/reset?msg=none');

        const hash = await bcrypt.hash(password, 10);
        await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [hash, id]);
        console.log('Password reset for account ' + id + ' by account ' + req.session.userID);
        res.redirect('/admin/users/reset?msg=ok');
    }));
}

module.exports = { SqliteStore, mount };
