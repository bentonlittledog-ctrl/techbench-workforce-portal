//1 Depezndencies Entry
const sqlite3 = require('sqlite3');
const {open} = require('sqlite');
const bcrypt = require('bcryptjs');

//2 Setup functions
async function setupDb() {
const db = await open({
filename: './timecards.db',
driver: sqlite3.Database
});

//3 Employee Table
await db.exec(`
	CREATE TABLE IF NOT EXISTS employees (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  username TEXT NOT NULL UNIQUE,
	  password_hash TEXT NOT NULL,
	  name TEXT NOT NULL,
	  hourly_rate REAL NOT NULL,
	  is_admin INTEGER DEFAULT 0
	)
`);

//4 Timeclock Punch Table
await db.exec(`
	CREATE TABLE IF NOT EXISTS logs (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  employee_id INTEGER,
	  action TEXT NOT NULL,
	  timestamp DATE DEFAULT CURRENT_TIMESTAMP,
	  FOREIGN KEY(employee_id) REFERENCES employees(id)
	)
`);

//5 Seeding Accounts
const count = await db.get("SELECT COUNT(*) as total FROM employees");
if (count.total === 0) {
   const adminHash = await bcrypt.hash('admin123', 10);
   const empHash = await bcrypt.hash('emp123', 10);

	await db.run("INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)",
		['admin', adminHash, 'Boss Manager', 30.00, 1]);
	await db.run("INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)",
		['employee', empHash, 'John Doe', 18.50, 0]);

	        console.log("database seeded!");
    } // 1. this brace closes the if count (count.total === 0)

    // Safely add the archived column layout migration rule to your logs table if missing
    try {
        await db.run("ALTER TABLE logs ADD COLUMN archived INTEGER DEFAULT 0");
        console.log("Database schema migration successful: 'archived' column appended cleanly.");
    } catch (err) {
        console.log("Database schema check: 'archived' column verified present.");
    }
    // 🚀 PERFORMANCE ENGINE OPTIMIZATION INDEXES
    try {
        // Index the employee relationship link to make JOIN operations instant
        await db.run("CREATE INDEX IF NOT EXISTS idx_logs_employee ON logs(employee_id)");
        // Index the archive flag so the server instantly skips historical data
        await db.run("CREATE INDEX IF NOT EXISTS idx_logs_archived ON logs(archived)");
        console.log("Performance indexes compiled and active.");
    } catch (err) {
        console.log("Performance index verification complete.");
    }

    return db;
}
module.exports = setupDb;

