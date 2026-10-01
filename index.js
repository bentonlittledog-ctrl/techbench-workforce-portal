// 1.0 Import tools
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const setupDb = require('./database');

// 2.0 Congfigure Server Application
const app = express();
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// 2.1 Secure session memory
app.use(session({
	secret: 'techbench_secure_portal_key_2026',
	resave: false,
	saveUninitialized: false
}));

// 3.0 Database Communication
let db;
setupDb().then(database => {
db = database;
console.log("Timecard database connection active.");
});

// 4.0 Initial Entry Screen
app.get('/', (req, res) => {
	if (req.session.userID){
		return res.redirect('/dashboard');
	}
	res.render('login', { error: null });
});

// 5.0 Login Submission Handshake
app.post('/login', async (req, res) => {
	const {username, password } = req.body;
	const user = await db.get("SELECT * FROM employees WHERE username = ?", [username]);

if (user && await bcrypt.compare(password, user.password_hash)) {
	req.session.userID = user.id;
	req.session.name = user.name;
	req.session.admin =user.is_admin;
	return res.redirect ('/dashboard');
}
	res.render('login', { error: 'Either the username or password you have provided is invalid.' });
});

// 6.0 Unified Portal Dashboard
app.get('/dashboard', async (req, res) => {
        if (!req.session.userID) return res.redirect('/');

        if (req.session.admin === 1) {
                // 6.1 Master Admin view - to retrieve every log in the system
                const rawLogs = await db.all(`
                        SELECT logs.id, logs.action, datetime(logs.timestamp, 'localtime') AS timestamp, employees.name, employees.hourly_rate
                        FROM logs
                        JOIN employees on logs.employee_id = employees.id
                        ORDER BY employees.name ASC, logs.timestamp ASC
                `);

                // Group separates punches into completed shifts matching their paper form
                let pairedShifts = [];
                let totalBillableHours = 0;
                let totalCompanyPayout = 0;

                for (let i = 0; i < rawLogs.length; i++) {
                        if (rawLogs[i].action === 'CLOCK_IN' && rawLogs[i+1] && rawLogs[i+1].action === 'CLOCK_OUT' && rawLogs[i].name === rawLogs[i+1].name) {
                                let inTime = new Date(rawLogs[i].timestamp);
                                let outTime = new Date(rawLogs[i+1].timestamp);
                                let shiftHours = (outTime - inTime) / (1000 * 60 * 60);
                                let shiftAmount = shiftHours * rawLogs[i].hourly_rate;

                                // Accumulate running totals for the table summary footer
                                totalBillableHours += shiftHours;
                                totalCompanyPayout += shiftAmount;

                                pairedShifts.push({
                        		name: rawLogs[i].name,
                        		rate: rawLogs[i].hourly_rate, // Keep this a raw number here
                       		 	date: inTime.toLocaleDateString(),
                        		time: `${inTime.toLocaleTimeString()} - ${outTime.toLocaleTimeString()}`,
                        		hours: parseFloat(shiftHours.toFixed(2)),   // Change from text string to actual float number
                        		amount: parseFloat(shiftAmount.toFixed(2)) // Change from text string to actual float number
               			 });


                                i++;
                        }
             	}

                const employeeList = await db.all("SELECT id, name, username, is_admin FROM employees WHERE id != ?", [req.session.userID]);

                        res.render('admin_dashboard', {
                        	name: req.session.name,
                        	shifts: pairedShifts,
                        	totalHours: totalBillableHours.toFixed(2),
                        	totalPayout: totalCompanyPayout.toFixed(2),
                        	users: employeeList
                });
        } else {
                // 6.2 Employee view - pull personal logs splitting them by archive status
                const activeLogs = await db.all("SELECT id, employee_id, action, datetime(timestamp, 'localtime') AS timestamp FROM logs WHERE employee_id = ? AND archived = 0 ORDER BY timestamp ASC", [req.session.userID]);
                const archivedLogs = await db.all("SELECT id, employee_id, action, datetime(timestamp, 'localtime') AS timestamp FROM logs WHERE employee_id = ? AND archived = 1 ORDER BY timestamp ASC", [req.session.userID]);
                const profile = await db.get("SELECT hourly_rate FROM employees where id = ?", [req.session.userID]);

                // Track button states from absolute newest log entry (even if archived)
                let currentStatus = 'CLOCKED_OUT';
                const newestLog = await db.get("SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1", [req.session.userID]);
                if (newestLog) currentStatus = newestLog.action;

                // 6.3 Dynamic Payment Calculator & Grouping Engine
                let currentShifts = [];
                let monthlyArchives = {}; // Container to group past shifts by month

                // Helper function to extract Month Name and Year
                const getPayPeriodLabel = (dateObj) => {
                        return dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                };

                for (let i = 0; i < activeLogs.length; i++) {
                        if (activeLogs[i].action === 'CLOCK_IN' && activeLogs[i+1] && activeLogs[i+1].action === 'CLOCK_OUT') {
                                let inTime = new Date(activeLogs[i].timestamp);
                                let outTime = new Date(activeLogs[i+1].timestamp);
                                let shiftHours = (outTime - inTime) / (1000 * 60 * 60);
                                let shiftAmount = shiftHours * profile.hourly_rate;

                                currentShifts.push({
                                        date: inTime.toLocaleDateString(),
                                        time: `${inTime.toLocaleTimeString()} - ${outTime.toLocaleTimeString()}`,
                                        hours: shiftHours.toFixed(2),
                                        amount: shiftAmount.toFixed(2)
                                });
                                i++;
                        }
                }

                for (let i = 0; i < archivedLogs.length; i++) {
                        if (archivedLogs[i].action === 'CLOCK_IN' && archivedLogs[i+1] && archivedLogs[i+1].action === 'CLOCK_OUT') {
                                let inTime = new Date(archivedLogs[i].timestamp);
                                let outTime = new Date(archivedLogs[i+1].timestamp);
                                let shiftHours = (outTime - inTime) / (1000 * 60 * 60);
                                let shiftAmount = shiftHours * profile.hourly_rate;

                                let periodLabel = getPayPeriodLabel(inTime);
                                if (!monthlyArchives[periodLabel]) {
                                        monthlyArchives[periodLabel] = [];
                                }

                                monthlyArchives[periodLabel].push({
                                        date: inTime.toLocaleDateString(),
                                        time: `${inTime.toLocaleTimeString()} - ${outTime.toLocaleTimeString()}`,
                                        hours: shiftHours.toFixed(2),
                                        amount: shiftAmount.toFixed(2)
                                });
                                i++;
                        }
                }

                // Calculate current period running totals dynamically
                let totalBillableHours = currentShifts.reduce((sum, s) => sum + parseFloat(s.hours), 0);
                let totalCompanyPayout = currentShifts.reduce((sum, s) => sum + parseFloat(s.amount), 0);

                res.render('employee_dashboard', {
                        name: req.session.name,
                        shifts: currentShifts,
                        archives: monthlyArchives, // Pass grouped monthly map down to dashboard
                        rate: profile.hourly_rate.toFixed(2),
                        totalHours: totalBillableHours.toFixed(2),
                        totalPayout: totalCompanyPayout.toFixed(2),
                        currentStatus: currentStatus,
                        error: null
                });
        }
}); // Correctly closes the entire master app.get('/dashboard') block


// 6.4 Handle timeclock Button Punches
app.post('/punch', async (req, res) => {
if (!req.session.userID) return res.redirect('/');
 const { action } = req.body;

// Backend Shield: Check the last punch to prevent duplicate states
const lastLog = await db.get("SELECT action FROM logs WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1", [req.session.userID]);

if (lastLog && lastLog.action === action) {
// If they attempt to create duplicate logs, it will deny
const myLogs = await db.all("SELECT * FROM logs WHERE employee_id = ? ORDER BY timestamp desc", [req.session.userID]);
const profile = await db.get("SELECT hourly_rate from employees where id = ?", [req.session.userID]);

let totalHours = 0;
for (let i=0; i < myLogs.length -1; i++) {
	if (myLogs[i].action === 'CLOCK_OUT' && myLogs[i+1].action === 'CLOCK_IN') {
		let outTime = new Date(myLogs[i].timestamp);
		let inTime = new Date(myLogs[i+1].timestamp);
		totalHours += (outTime - inTime) / (1000 * 60 * 60);
	}
}
const estimatedPay = totalHours * profile.hourly_rate;

res.render('employee_dashboard', {
		name: req.session.name,
		logs: myLogs,
		rate: profile.hourly_rate,
		hours: totalHours.toFixed(2),
		pay: estimatedPay.toFixed(2),
		currentStatus: lastLog.action,
		error: "Error: requested action is unable to be completed. 2 or more duplicate clock-in / clock out entries are present."
	});
}

await db.run("INSERT INTO logs (employee_id, action) VALUES (?, ?) ", [req.session.userID, action]);
res.redirect('/dashboard');

});

//6.5 Secure Session Termination
app.get('/logout', (req, res) => {
	req.session.destroy();
	res.redirect('/');
});

// 6.6 Administrative Panel - Add a New Employee or Administrator Account
app.post('/admin/users/add', async (req, res) => {
        if (req.session.admin !== 1) return res.redirect('/');
        const { username, password, name, hourly_rate, is_admin } = req.body;

        try {
                const hash = await bcrypt.hash(password, 10);
                // Convert the dropdown selection value string ("1" or "0") to a true numeric database bit
                const adminBit = parseInt(is_admin) === 1 ? 1 : 0;

                await db.run("INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)", 
                        [username, hash, name, parseFloat(hourly_rate), adminBit]);
                res.redirect('/dashboard');
        } catch (err) {
                res.redirect('/dashboard');
        }
});


// 6.7 Administrative Panel - Remove an Employee or Administrator profile
app.post('/admin/users/remove', async (req, res) => {
        if (req.session.admin !== 1) return res.redirect('/');
        const { employeeId } = req.body;

        // Safety Shield: Strictly prevent deleting your own active session account profile
        if (parseInt(employeeId) === req.session.userID) return res.redirect('/dashboard');

        // Delete their logs first to maintain relational integrity, then clear the user profile
        await db.run("DELETE FROM logs WHERE employee_id = ?", [employeeId]);
        await db.run("DELETE FROM employees WHERE id = ?", [employeeId]);
        res.redirect('/dashboard');

});


// X App Testing
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
        console.log(`Server engine live and listening on port ${PORT}`);
});
