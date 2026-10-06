// 1 Dependencies
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');

// 2 Setup function
async function setupDb() {
    // DB_PATH lets you point the database at a persistent disk on Render
    // (e.g. /var/data/timecards.db). Falls back to the local file.
    const db = await open({
        filename: process.env.DB_PATH || './timecards.db',
        driver: sqlite3.Database
    });

    // Faster, safer concurrent access
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA busy_timeout = 5000;');

    // 3 Employee table
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

    // 4 Timeclock punch table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER,
          action TEXT NOT NULL,
          timestamp DATE DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(employee_id) REFERENCES employees(id)
        )
    `);

    // 5 Seed starter accounts (only when the employees table is empty)
    const count = await db.get('SELECT COUNT(*) AS total FROM employees');
    if (count.total === 0) {
        // Set ADMIN_PASSWORD in Render's environment before the first start
        // so the default 'admin123' is never used on a live system.
        const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
        const empHash = await bcrypt.hash('emp123', 10);

        await db.run(
            'INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)',
            ['admin', adminHash, 'Boss Manager', 30.0, 1]
        );
        await db.run(
            'INSERT INTO employees (username, password_hash, name, hourly_rate, is_admin) VALUES (?, ?, ?, ?, ?)',
            ['employee', empHash, 'John Doe', 18.5, 0]
        );
        console.log('Database seeded!');
    }

    // 6 Migration: add the archived column only if it is missing
    const logColumns = await db.all('PRAGMA table_info(logs)');
    if (!logColumns.some(col => col.name === 'archived')) {
        await db.run('ALTER TABLE logs ADD COLUMN archived INTEGER DEFAULT 0');
        console.log("Migration complete: 'archived' column added.");
    }

    // 7 Indexes that match how the app actually queries the logs
    await db.run('CREATE INDEX IF NOT EXISTS idx_logs_employee ON logs(employee_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_logs_emp_archived_ts ON logs(employee_id, archived, timestamp)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp)');

    // 8 Organization: sites, programs, who works where (memberships), who manages what (scopes)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS programs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL,
          site_id INTEGER NOT NULL,
          program_id INTEGER NOT NULL,
          UNIQUE (employee_id, site_id, program_id)
        );
        CREATE TABLE IF NOT EXISTS scopes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL,
          site_id INTEGER NOT NULL,
          program_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS time_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          note TEXT,
          status TEXT NOT NULL DEFAULT 'PENDING',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          reviewed_by INTEGER,
          reviewed_at TEXT
        );
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_memberships_emp ON memberships(employee_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_scopes_emp ON scopes(employee_id)');

    // 9 District administrator flag. Anyone who was an admin before this update keeps full access.
    const employeeColumns = await db.all('PRAGMA table_info(employees)');
    if (!employeeColumns.some(col => col.name === 'is_district')) {
        await db.run('ALTER TABLE employees ADD COLUMN is_district INTEGER DEFAULT 0');
        await db.run('UPDATE employees SET is_district = 1 WHERE is_admin = 1');
        console.log('Migration complete: existing administrators are now district administrators.');
    }

    // 10 Starter sites and programs (only when the lists are empty)
    const siteCount = await db.get('SELECT COUNT(*) AS n FROM sites');
    if (siteCount.n === 0) {
        for (const name of ['Glacier High School', 'Flathead High School', 'Linderman Education Center', 'Work-Based Learning', 'District Activities']) {
            await db.run('INSERT INTO sites (name) VALUES (?)', [name]);
        }
    }
    const programCount = await db.get('SELECT COUNT(*) AS n FROM programs');
    if (programCount.n === 0) {
        for (const name of ['Student Tech Work Bench', 'Paraprofessional', 'Aides', 'Student Internship', 'Special Activities']) {
            await db.run('INSERT INTO programs (name) VALUES (?)', [name]);
        }
    }

    return db;
}

module.exports = setupDb;
