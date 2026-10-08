// 1.0 Import tools
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const setupDb = require('./database');
const { visibleSql, canManage, manageableAccounts, allowedUnits } = require('./scope');
const path = require('path');
const ui = require('./ui');

// 2.0 Configure server application
const app = express();

// 2.05 Health check (before sessions) - handy for uptime pingers
app.get('/health', (req, res) => res.send('ok'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));  // app.css
app.set('view engine', 'ejs');

// 2.1 Secure session memory
// Set SESSION_SECRET in Render's environment; the fallback keeps the app working until you do.
const { SqliteStore } = require('./foundation');
app.use(session({
    store: new SqliteStore(() => db),
    secret: process.env.SESSION_SECRET || 'techbench_secure_portal_key_2026',
    resave: false,
    saveUninitialized: false
}));

// 2.2 Lets async routes pass errors to the error handler instead of hanging or crashing
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 2.2b Keep the signed-in person's name and role current, so promotions and removals apply immediately
app.use(wrap(async (req, res, next) => {
    if (req.session.userID) {
        const u = await db.get('SELECT name, is_admin, is_district FROM employees WHERE id = ?', [req.session.userID]);
        if (!u) return req.session.destroy(() => res.redirect('/'));
        if (u.is_admin !== req.session.admin || u.is_district !== req.session.district) {
            req.session.admin = u.is_admin;
            req.session.district = u.is_district;
            delete req.session.theme;
        }
        req.session.name = u.name;
    }
    next();
}));

// 2.25 Menu information available to every page
app.use(wrap(async (req, res, next) => {
    let resources = false, bench = false, benchReady = false;
    if (req.session.userID) {
        try { resources = await require('./education').hasResources(db, req.session); } catch (e) { resources = false; }
        try { bench = await require('./bench').hasBench(db, req.session); benchReady = bench && require('./bench').ready(); } catch (e) { bench = false; }
    }
    res.locals.nav = {
        resources, bench, benchReady,
        loggedIn: !!req.session.userID,
        admin: req.session.admin === 1,
        district: req.session.district === 1,
        name: req.session.name || '',
        path: req.path
    };
    next();
}));

// 2.3 Logins created before this version get their district flag filled in
app.use(wrap(async (req, res, next) => {
    if (req.session.userID && req.session.district === undefined) {
        const u = await db.get('SELECT is_district FROM employees WHERE id = ?', [req.session.userID]);
        req.session.district = u ? u.is_district : 0;
    }
    next();
}));

// 2.4 School-color theme: logged-in people get their site's colors, visitors get the one in the link or cookie
app.use(wrap(async (req, res, next) => {
    let key = 'district';
    if (req.session.userID) {
        if (req.session.district === 1 && req.query.theme !== undefined) {   // district admins can preview: ?theme=glacier (or ?theme=district to reset)
            req.session.themePreview = ui.THEMES[req.query.theme] ? req.query.theme : null;
        }
        if (req.session.themePreview) {
            key = req.session.themePreview;
        } else {
            if (!req.session.theme || Date.now() - (req.session.themeAt || 0) > 5 * 60 * 1000) {
                let found = 'district';
                if (req.session.district !== 1) {
                    const rows = await db.all(
                        `SELECT DISTINCT s.name FROM sites s WHERE s.id IN
                           (SELECT site_id FROM memberships WHERE employee_id = ?
                            UNION SELECT site_id FROM scopes WHERE employee_id = ?)`,
                        [req.session.userID, req.session.userID]
                    );
                    if (rows.length === 1 && ui.SITE_THEME[rows[0].name]) found = ui.SITE_THEME[rows[0].name];
                }
                req.session.theme = found;
                req.session.themeAt = Date.now();
            }
            key = req.session.theme;
        }
    } else {
        const fromCookie = (/(?:^|;\s*)site=(\w+)/.exec(req.headers.cookie || '') || [])[1];
        const fromHost = ui.themeKeyForHost(req.hostname);   // a school's own web address wins over the cookie
        const wanted = typeof req.query.site === 'string' ? req.query.site : (fromHost || fromCookie);
        if (ui.THEMES[wanted]) key = wanted;
        res.locals.hostLocked = !!fromHost && typeof req.query.site !== 'string';   // school's own address: hide the school switcher
        if (typeof req.query.site === 'string' && ui.THEMES[req.query.site] && !fromHost) {
            res.cookie('site', req.query.site, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
        }
    }
    const theme = ui.themeFor(key);
    res.locals.theme = theme;
    res.locals.navHtml = ui.navHtml(res.locals.nav, theme);
    res.locals.headTags = ui.headTags + ui.themeStyle(theme);
    next();
}));

// Log stray errors instead of killing the whole server
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// 3.0 Database handle (set once the database is ready, before the server starts listening)
let db;

// 3.1 Helper: turn an ordered list of punches into completed shifts
function pairShifts(logs, rate) {
    const shifts = [];
    for (let i = 0; i < logs.length; i++) {
        if (logs[i].action === 'CLOCK_IN' && logs[i + 1] && logs[i + 1].action === 'CLOCK_OUT') {
            const inTime = new Date(logs[i].timestamp);
            const outTime = new Date(logs[i + 1].timestamp);
            const hours = (outTime - inTime) / (1000 * 60 * 60);
            shifts.push({
                inTime,
                shift: {
                    date: inTime.toLocaleDateString(),
                    time: `${inTime.toLocaleTimeString()} - ${outTime.toLocaleTimeString()}`,
                    hours: hours.toFixed(2),
                    amount: (hours * rate).toFixed(2)
                }
            });
            i++;
        }
    }
    return shifts;
}

// 3.2 Helper: Month Name and Year label for archive grouping
const getPayPeriodLabel = dateObj =>
    dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

// 4.0 Initial entry screen
app.get('/', (req, res) => {
    if (req.session.userID) {
        return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
});

// 5.0 Login submission handshake
app.post('/login', wrap(async (req, res) => {
    const { username, password } = req.body;
    const badLogin = 'Either the username or password you have provided is invalid.';

    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.render('login', { error: badLogin });
    }

    const user = await db.get('SELECT * FROM employees WHERE username = ?', [username]);

    if (user && await bcrypt.compare(password, user.password_hash)) {
        req.session.userID = user.id;
        req.session.name = user.name;
        req.session.admin = user.is_admin;
        req.session.district = user.is_district;
        return res.redirect('/dashboard');
    }
    res.render('login', { error: badLogin });
}));

// 6.0 Unified portal dashboard
app.get('/dashboard', wrap(async (req, res) => {
    if (!req.session.userID) return res.redirect('/');

    if (req.session.admin === 1) {
        // 6.1 Master admin view - every log in the system
        const scope = visibleSql(req.session, 'employees');
        const rawLogs = await db.all(`
            SELECT logs.id, logs.action, datetime(logs.timestamp, 'localtime') AS timestamp,
                   employees.name, employees.hourly_rate
            FROM logs
            JOIN employees ON logs.employee_id = employees.id
            WHERE ${scope.sql}
            ORDER BY employees.name ASC, logs.timestamp ASC, logs.id ASC
        `, scope.params);

        // Pair punches into completed shifts
        const pairedShifts = [];
        let totalBillableHours = 0;
        let totalCompanyPayout = 0;

        for (let i = 0; i < rawLogs.length; i++) {
            if (
                rawLogs[i].action === 'CLOCK_IN' &&
                rawLogs[i + 1] &&
                rawLogs[i + 1].action === 'CLOCK_OUT' &&
                rawLogs[i].name === rawLogs[i + 1].name
            ) {
                const inTime = new Date(rawLogs[i].timestamp);
                const outTime = new Date(rawLogs[i + 1].timestamp);
                const shiftHours = (outTime - inTime) / (1000 * 60 * 60);
                const shiftAmount = shiftHours * rawLogs[i].hourly_rate;

                totalBillableHours += shiftHours;
                totalCompanyPayout += shiftAmount;

                pairedShifts.push({
                    name: rawLogs[i].name,
                    rate: rawLogs[i].hourly_rate,
                    date: inTime.toLocaleDateString(),
                    time: `${inTime.toLocaleTimeString()} - ${outTime.toLocaleTimeString()}`,
                    hours: parseFloat(shiftHours.toFixed(2)),
                    amount: parseFloat(shiftAmount.toFixed(2))
                });

                i++;
            }
        }

        const employeeList = (await manageableAccounts(db, req.session)).filter(u => u.id !== req.session.userID);
        const units = await allowedUnits(db, req.session);

        return res.render('admin_dashboard', {
            name: req.session.name,
            shifts: pairedShifts,
            totalHours: totalBillableHours.toFixed(2),
            totalPayout: totalCompanyPayout.toFixed(2),
            users: employeeList,
            units: units,
            isDistrict: req.session.district === 1
        });
    }

    // 6.2 Employee view - personal logs split by archive status
    const profile = await db.get('SELECT hourly_rate FROM employees WHERE id = ?', [req.session.userID]);
    if (!profile) {
        // Account was removed while the session was still active
        return req.session.destroy(() => res.redirect('/'));
    }

    const activeLogs = await db.all(
        "SELECT id, employee_id, action, datetime(timestamp, 'localtime') AS timestamp FROM logs WHERE employee_id = ? AND archived = 0 ORDER BY timestamp ASC, id ASC",
        [req.session.userID]
    );
    const archivedLogs = await db.all(
        "SELECT id, employee_id, action, datetime(timestamp, 'localtime') AS timestamp FROM logs WHERE employee_id = ? AND archived = 1 ORDER BY timestamp ASC, id ASC",
        [req.session.userID]
    );

    // Button state comes from the newest log entry (even if archived)
    let currentStatus = 'CLOCKED_OUT';
    const newestLog = await db.get(
        'SELECT action, timestamp FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
        [req.session.userID]
    );
    if (newestLog) currentStatus = newestLog.action;
    // When the current shift started (UTC text -> milliseconds) for the live timer
    let sinceMs = null;
    if (newestLog && newestLog.action === 'CLOCK_IN') {
        const t = Date.parse(String(newestLog.timestamp).replace(' ', 'T') + 'Z');
        if (!isNaN(t)) sinceMs = t;
    }

    // 6.3 Payment calculator and grouping engine
    const currentShifts = pairShifts(activeLogs, profile.hourly_rate).map(s => s.shift);

    const monthlyArchives = {};
    for (const { inTime, shift } of pairShifts(archivedLogs, profile.hourly_rate)) {
        const periodLabel = getPayPeriodLabel(inTime);
        if (!monthlyArchives[periodLabel]) monthlyArchives[periodLabel] = [];
        monthlyArchives[periodLabel].push(shift);
    }

    const totalBillableHours = currentShifts.reduce((sum, s) => sum + parseFloat(s.hours), 0);
    const totalCompanyPayout = currentShifts.reduce((sum, s) => sum + parseFloat(s.amount), 0);

    // One-time message left by /punch (e.g. duplicate punch)
    const error = req.session.error || null;
    delete req.session.error;

    res.render('employee_dashboard', {
        name: req.session.name,
        shifts: currentShifts,
        archives: monthlyArchives,
        rate: profile.hourly_rate.toFixed(2),
        totalHours: totalBillableHours.toFixed(2),
        totalPayout: totalCompanyPayout.toFixed(2),
        currentStatus: currentStatus,
        sinceMs: sinceMs,
        error: error
    });
}));

// 6.4 Handle timeclock button punches
app.post('/punch', wrap(async (req, res) => {
    if (!req.session.userID) return res.redirect('/');

    const { action } = req.body;
    if (action !== 'CLOCK_IN' && action !== 'CLOCK_OUT') {
        return res.redirect('/dashboard');
    }

    // Backend shield: refuse duplicate states (two clock-ins or two clock-outs in a row)
    const lastLog = await db.get(
        'SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
        [req.session.userID]
    );

    if (lastLog && lastLog.action === action) {
        req.session.error = 'Error: requested action is unable to be completed. 2 or more duplicate clock-in / clock out entries are present.';
        return res.redirect('/dashboard');
    }

    await db.run('INSERT INTO logs (employee_id, action) VALUES (?, ?)', [req.session.userID, action]);
    res.redirect('/dashboard');
}));

// 6.5 Secure session termination
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// 6.6 Admin panel - add an employee, manager or district administrator
app.post('/admin/users/add', wrap(async (req, res) => {
    if (req.session.admin !== 1) return res.redirect('/');
    const { username, password, name, hourly_rate, is_admin } = req.body;
    const unit = req.body.unit || (req.body.site_id + ':' + req.body.program_id);
    const isDistrict = req.session.district === 1;

    if (!username || !name || typeof password !== 'string' || !password) return res.redirect('/dashboard');

    // 0 = employee, 1 = manager, 2 = district administrator.
    // Only district administrators can create managers or other district administrators.
    const role = isDistrict ? Math.min(Math.max(parseInt(is_admin, 10) || 0, 0), 2) : 0;
    const chosen = (await allowedUnits(db, req.session)).find(u => u.value === unit);
    if (role < 2 && !chosen) return res.redirect('/dashboard');

    const hash = await bcrypt.hash(password, 10);
    await db.run('BEGIN');
    try {
        const added = await db.run(
            'INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin, is_district) VALUES (?, ?, ?, ?, ?, ?)',
            [username, hash, name, parseFloat(hourly_rate), role >= 1 ? 1 : 0, role === 2 ? 1 : 0]
        );
        if (role === 0) {
            await db.run('INSERT INTO memberships (employee_id, site_id, program_id) VALUES (?, ?, ?)',
                [added.lastID, chosen.site_id, chosen.program_id]);
        } else if (role === 1) {
            await db.run('INSERT INTO scopes (employee_id, site_id, program_id) VALUES (?, ?, ?)',
                [added.lastID, chosen.site_id, chosen.program_id]);
        }
        await db.run('COMMIT');
    } catch (err) {
        await db.run('ROLLBACK');
        console.error('Add user failed:', err.message);
    }
    res.redirect('/dashboard');
}));

// 6.7 Admin panel - remove an account (only accounts inside the admin's own areas)
app.post('/admin/users/remove', wrap(async (req, res) => {
    if (req.session.admin !== 1) return res.redirect('/');
    const employeeId = parseInt(req.body.employeeId, 10);

    // Never allow deleting your own active account
    if (!employeeId || employeeId === req.session.userID) return res.redirect('/dashboard');
    if (!(await canManage(db, req.session, employeeId))) return res.redirect('/dashboard');

    // Remove everything tied to the account together, or nothing at all
    await db.run('BEGIN');
    try {
        await db.run('DELETE FROM logs WHERE employee_id = ?', [employeeId]);
        await db.run('DELETE FROM time_requests WHERE employee_id = ?', [employeeId]);
        await db.run('DELETE FROM memberships WHERE employee_id = ?', [employeeId]);
        await db.run('DELETE FROM scopes WHERE employee_id = ?', [employeeId]);
        await db.run('DELETE FROM employees WHERE id = ?', [employeeId]);
        await db.run('COMMIT');
    } catch (err) {
        await db.run('ROLLBACK');
        throw err;
    }
    res.redirect('/dashboard');
}));

require('./extras')(app, () => db, wrap);

require('./foundation').mount(app, () => db, wrap);
require('./scope').mount(app, () => db, wrap);
require('./editing')(app, () => db, wrap);
require('./accounts')(app, () => db, wrap);
require('./education')(app, () => db, wrap, express);
require('./bench')(app, () => db, wrap);
require('./queue')(app, () => db, wrap);
require('./ticketphotos')(app, () => db, wrap, express);
require('./notify')(app, () => db, wrap);
require('./benchstats')(app, () => db, wrap);
require('./ticketimport')(app, () => db, wrap, express);
require('./printing').mount(app, () => db, wrap);

// 7.0 Error handler (must come after all routes)
app.use((err, req, res, next) => {
    console.error('Route error:', err);
    if (res.headersSent) return next(err);
    res.status(500).send('Something went wrong. Please go back and try again.');
});

// 8.0 Start the server only after the database is ready
const PORT = process.env.PORT || 3000;
setupDb()
    .then(database => {
        db = database;
        console.log('Timecard database connection active.');
        app.listen(PORT, () => {
            console.log(`Server engine live and listening on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
