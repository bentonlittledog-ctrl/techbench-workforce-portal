// Security hardening: browser security headers, a same-site check on every form post, login lockout, password rules,
// forced password change for starter/temporary passwords, and ending a person's other sessions when their password changes.
const bcrypt = require('bcryptjs');

const WINDOW_MS = 15 * 60 * 1000;
const USER_LIMIT = 5;        // wrong passwords for one username before it is locked
const IP_LIMIT = 100;        // wrong passwords from one address (high, because a whole school can share one public address)
const LOCK_MS = 15 * 60 * 1000;
// A throwaway hash so a login for a username that does not exist takes as long as a real one.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), 10);

// ---------- Browser security headers ----------
// 'unsafe-inline' stays for scripts and styles because several pages have small inline scripts; everything else is locked to this site.
// If a page ever looks broken after this update, set CSP_OFF=1 in Render to turn the content policy off (the other headers stay).
function csp() {
    const anc = String(process.env.CSP_FRAME_ANCESTORS || "'self'").replace(/[;\r\n]/g, '');
    return ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob: https:", 'frame-src https:', "connect-src 'self'",
        "media-src 'self' https:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", 'frame-ancestors ' + anc].join('; ');
}
function headers(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (!process.env.CSP_FRAME_ANCESTORS) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    if (process.env.CSP_OFF !== '1') res.setHeader('Content-Security-Policy', csp());
    res.setHeader('Cache-Control', 'no-store');      // pages hold personal data; file routes set their own caching afterwards
    next();
}

// ---------- Forged-form protection ----------
// A browser always sends Origin (or at least Referer) with a form post. If it names a different website, the post did not come from our pages.
function sameSiteOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const hosts = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map(h => String(h).split(',')[0].trim().toLowerCase());
    const origin = req.get('origin');
    if (origin === 'null') return res.status(403).type('text').send('Blocked: this request did not come from the portal. Go back, reload the page and try again.');
    const src = origin || req.get('referer');
    if (!src) return next();
    let host = '';
    try { host = new URL(src).host.toLowerCase(); } catch (e) { host = ''; }
    if (host && hosts.includes(host)) return next();
    return res.status(403).type('text').send('Blocked: this request came from a different website. Go back, reload the portal and try again.');
}

// ---------- Passwords ----------
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyui', 'letmein1', 'welcome1', 'welcome123',
    'admin123', 'emp123', 'changeme', 'iloveyou', 'abc12345', 'timecard', 'kalispell', 'glacier1', 'flathead']);
// Returns '' when fine, otherwise a sentence telling the person what is wrong.
function passwordProblem(pw, username) {
    pw = String(pw == null ? '' : pw);
    if (pw.length < 8) return 'Use at least 8 characters.';
    if (Buffer.byteLength(pw) > 72) return 'Use 72 characters or fewer.';
    const low = pw.toLowerCase();
    if (username && low === String(username).toLowerCase()) return 'The password can not be the same as the username.';
    if (COMMON.has(low)) return 'That password is too easy to guess. Pick something harder.';
    if (/^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Pick something harder.';
    return '';
}

// ---------- Login lockout ----------
let ready = null;
async function ensure(db) {
    if (!ready) ready = db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (k TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT, action TEXT NOT NULL, details TEXT, reason TEXT);`).catch(e => { ready = null; throw e; });
    return ready;
}
const userKey = u => 'u:' + String(u || '').toLowerCase().slice(0, 80);
const ipKey = ip => 'i:' + String(ip || 'unknown').slice(0, 64);
const lockMessage = () => 'Too many sign-in attempts. Wait 15 minutes and try again, or ask your supervisor to reset your password.';

// Returns a message if this username or address is locked right now, otherwise ''.
async function loginLocked(db, ip, username, now = Date.now()) {
    await ensure(db);
    const rows = await db.all('SELECT locked_until FROM login_attempts WHERE k IN (?, ?)', [userKey(username), ipKey(ip)]);
    return rows.some(r => r.locked_until > now) ? lockMessage() : '';
}
async function bump(db, key, limit, now) {
    const r = await db.get('SELECT fails, first_at FROM login_attempts WHERE k = ?', [key]);
    let fails = 1, first = now;
    if (r && now - r.first_at <= WINDOW_MS) { fails = r.fails + 1; first = r.first_at; }
    const lockedUntil = fails >= limit ? now + LOCK_MS : 0;
    await db.run('INSERT OR REPLACE INTO login_attempts (k, fails, first_at, locked_until) VALUES (?,?,?,?)', [key, fails, first, lockedUntil]);
    return lockedUntil > 0;
}
async function loginFailed(db, ip, username, now = Date.now()) {
    await ensure(db);
    const lockedUser = await bump(db, userKey(username), USER_LIMIT, now);
    await bump(db, ipKey(ip), IP_LIMIT, now);
    if (lockedUser) await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (NULL, ?, NULL, ?, ?, ?, ?)',
        ['System', String(username || '').slice(0, 80), 'LOGIN_LOCKOUT', 'Too many wrong passwords. Sign-in for this username is paused for 15 minutes.', '']);
    if (Math.random() < 0.02) await db.run('DELETE FROM login_attempts WHERE first_at < ? AND locked_until < ?', [now - 24 * 3600 * 1000, now]);
}
async function loginSucceeded(db, username) { await ensure(db); await db.run('DELETE FROM login_attempts WHERE k = ?', [userKey(username)]); }

// ---------- Forced password change ----------
const flagKey = id => 'pwchange_' + id;
async function mustChange(db, id) { await ensure(db); return !!(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', [flagKey(id)])); }
async function setMustChange(db, id, on, who) {
    await ensure(db);
    if (on) await db.run('INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,CURRENT_TIMESTAMP,?)', [flagKey(id), '1', who || '']);
    else await db.run('DELETE FROM app_settings WHERE key = ?', [flagKey(id)]);
}
// Sends someone who still has a starter or temporary password to the change-password page first.
function forceChange(getDb) {
    const open = p => p === '/profile/password' || p === '/logout' || p === '/health' || p.startsWith('/status/');
    return async (req, res, next) => {
        try {
            if (!req.session || !req.session.userID || open(req.path)) return next();
            if (req.session.pwOK !== true) {
                if (await mustChange(getDb(), req.session.userID)) return res.redirect('/profile/password?first=1');
                req.session.pwOK = true;
            }
            next();
        } catch (e) { next(e); }
    };
}

// Ends every login of one person (optionally keeping the current one).
async function endSessions(db, id, keepSid) {
    const rows = await db.all('SELECT sid, sess FROM sessions');
    let n = 0;
    for (const r of rows) {
        if (keepSid && r.sid === keepSid) continue;
        let uid = null; try { uid = JSON.parse(r.sess).userID; } catch (e) { uid = null; }
        if (uid === id) { await db.run('DELETE FROM sessions WHERE sid = ?', [r.sid]); n++; }
    }
    return n;
}

// Accounts still using the starter passwords from the first install.
async function defaultAccounts(db) {
    const found = [];
    for (const [username, pw] of [['admin', 'admin123'], ['employee', 'emp123']]) {
        const u = await db.get('SELECT id, name FROM employees WHERE username = ?', [username]);
        if (u && await bcrypt.compare(pw, (await db.get('SELECT password_hash AS h FROM employees WHERE id = ?', [u.id])).h)) found.push({ id: u.id, username, name: u.name });
    }
    return found;
}
// Run once at start-up: anyone still on a starter password must change it at their next page.
async function lockDownDefaults(db) {
    await ensure(db);
    let sessionsOk = true;
    try { await db.get('SELECT 1 FROM sessions LIMIT 1'); } catch (e) { sessionsOk = false; }
    const list = await defaultAccounts(db);
    for (const a of list) {
        if (!(await mustChange(db, a.id))) {
            await setMustChange(db, a.id, true, 'System');
            if (sessionsOk) await endSessions(db, a.id);
            await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
                ['System', a.id, a.name, 'DEFAULT_PASSWORD', 'The "' + a.username + '" account was still using the starter password. It must be changed at the next sign-in.', '']);
            console.warn('SECURITY: account "' + a.username + '" still has the starter password. It will be forced to change it.');
        }
    }
    return list;
}

// ---------- "Change my password" ----------
function mount(app, getDb, wrap) {
    app.get('/profile/password', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const forced = await mustChange(getDb(), req.session.userID);
        res.render('password_change', { error: null, ok: null, first: forced });
    }));
    app.post('/profile/password', wrap(async (req, res) => {
        if (!req.session.userID) return res.redirect('/');
        const db = getDb(), b = req.body || {};
        const forced = await mustChange(db, req.session.userID);
        const fail = (msg, code) => res.status(code || 400).render('password_change', { error: msg, ok: null, first: forced });
        const me = await db.get('SELECT id, username, password_hash FROM employees WHERE id = ?', [req.session.userID]);
        if (!me) return res.redirect('/');
        const lock = await loginLocked(db, req.ip, me.username);
        if (lock) return fail(lock, 429);
        const cur = String(b.current || ''), next = String(b.password || ''), again = String(b.confirm || '');
        if (!(await bcrypt.compare(cur, me.password_hash))) { await loginFailed(db, req.ip, me.username); return fail('Your current password is not right.'); }
        if (next !== again) return fail('The two new passwords did not match.');
        if (next === cur) return fail('Pick a new password that is different from the current one.');
        const problem = passwordProblem(next, me.username);
        if (problem) return fail(problem);
        await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [await bcrypt.hash(next, 10), me.id]);
        await loginSucceeded(db, me.username);
        await setMustChange(db, me.id, false);
        const others = await endSessions(db, me.id, req.sessionID);
        req.session.pwOK = true;
        await db.run('INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?,?,?,?,?,?,?)',
            [me.id, req.session.name || '', me.id, req.session.name || '', 'PASSWORD_CHANGE', 'Changed their own password' + (others ? ' (signed out ' + others + ' other login' + (others === 1 ? '' : 's') + ')' : ''), '']);
        if (forced) return res.redirect('/dashboard');
        res.render('password_change', { error: null, ok: 'Your password was changed.' + (others ? ' Any other devices you were signed in on were signed out.' : ''), first: false });
    }));
}

module.exports = { headers, sameSiteOnly, passwordProblem, loginLocked, loginFailed, loginSucceeded, mustChange, setMustChange, forceChange, endSessions, defaultAccounts, lockDownDefaults, mount, ensure, DUMMY_HASH, lockMessage, csp };
