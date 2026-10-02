// 1.0 Import tools
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const setupDb = require('./database');

// 2.0 Configure server application
const app = express();

// 2.05 Health check (before sessions) - handy for uptime pingers
app.get('/health', (req, res) => res.send('ok'));

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// 2.1 Secure session memory
// Set SESSION_SECRET in Render's environment; the fallback keeps the app working until you do.
app.use(session({
    secret: process.env.SESSION_SECRET || 'techbench_secure_portal_key_2026',
    resave: false,
    saveUninitialized: false
}));

// 2.2 Lets async routes pass errors to the error handler instead of hanging or crashing
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
        return res.redirect('/dashboard');
    }
    res.render('login', { error: badLogin });
}));

// 6.0 Unified portal dashboard
app.get('/dashboard', wrap(async (req, res) => {
    if (!req.session.userID) return res.redirect('/');

    if (req.session.admin === 1) {
        // 6.1 Master admin view - every log in the system
        const rawLogs = await db.all(`
            SELECT logs.id, logs.action, datetime(logs.timestamp, 'localtime') AS timestamp,
                   employees.name, employees.hourly_rate
            FROM logs
            JOIN employees ON logs.employee_id = employees.id
            ORDER BY employees.name ASC, logs.timestamp ASC, logs.id ASC
        `);

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

        const employeeList = await db.all(
            'SELECT id, name, username, is_admin FROM employees WHERE id != ?',
            [req.session.userID]
        );

        return res.render('admin_dashboard', {
            name: req.session.name,
            shifts: pairedShifts,
            totalHours: totalBillableHours.toFixed(2),
            totalPayout: totalCompanyPayout.toFixed(2),
            users: employeeList
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
        'SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
        [req.session.userID]
    );
    if (newestLog) currentStatus = newestLog.action;

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

// 6.6 Admin panel - add a new employee or administrator
app.post('/admin/users/add', wrap(async (req, res) => {
    if (req.session.admin !== 1) return res.redirect('/');
    const { username, password, name, hourly_rate, is_admin } = req.body;

    try {
        const hash = await bcrypt.hash(password, 10);
        const adminBit = parseInt(is_admin) === 1 ? 1 : 0;

        await db.run(
            'INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)',
            [username, hash, name, parseFloat(hourly_rate), adminBit]
        );
    } catch (err) {
        console.error('Add user failed:', err.message);
    }
    res.redirect('/dashboard');
}));

// 6.7 Admin panel - remove an employee or administrator
app.post('/admin/users/remove', wrap(async (req, res) => {
    if (req.session.admin !== 1) return res.redirect('/');
    const employeeId = parseInt(req.body.employeeId);

    // Never allow deleting your own active account
    if (!employeeId || employeeId === req.session.userID) return res.redirect('/dashboard');

    // Delete logs and profile together so a failure can't leave half the data behind
    await db.run('BEGIN');
    try {
        await db.run('DELETE FROM logs WHERE employee_id = ?', [employeeId]);
        await db.run('DELETE FROM employees WHERE id = ?', [employeeId]);
        await db.run('COMMIT');
    } catch (err) {
        await db.run('ROLLBACK');
        throw err;
    }
    res.redirect('/dashboard');
}));

require('./extras')(app, () => db, wrap);

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
