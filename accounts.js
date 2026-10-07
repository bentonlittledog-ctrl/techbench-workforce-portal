// accounts.js - edit existing accounts: name, username, pay rate, role (promotions), and site/program assignments.
// Every change is written to the audit log. Mounted from index.js.
const { visibleSql, canManage, allowedUnits } = require('./scope');

const ROLE_NAMES = ['Employee', 'Manager', 'District administrator'];
const roleOf = e => (e.is_district ? 2 : (e.is_admin ? 1 : 0));

module.exports = function (app, getDb, wrap) {
    let ready = null;
    async function database() {
        const db = getDb();
        if (!ready) {
            ready = db.exec(`
                CREATE TABLE IF NOT EXISTS audit_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  at TEXT DEFAULT CURRENT_TIMESTAMP,
                  actor_id INTEGER, actor_name TEXT, target_id INTEGER, target_name TEXT,
                  action TEXT NOT NULL, details TEXT, reason TEXT
                )
            `).catch(err => { ready = null; throw err; });
        }
        await ready;
        return db;
    }
    const needAdmin = (req, res) => { if (req.session.admin !== 1) { res.redirect('/'); return true; } return false; };
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    const takeFlash = req => { const f = req.session.flash || null; delete req.session.flash; return f; };
    const audit = (db, req, target, action, details) => db.run(
        'INSERT INTO audit_log (actor_id, actor_name, target_id, target_name, action, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.session.userID, req.session.name || '', target.id, target.name, action, details, '']
    );
    const back = id => '/admin/accounts/edit?id=' + id;

    // May this session open this account? Managers: employees in their areas. District: anyone. Everyone: themselves (name/username only).
    async function openable(db, req, id) {
        if (!id) return false;
        if (id === req.session.userID) return true;
        return canManage(db, req.session, id);
    }

    async function assignmentsOf(db, id) {
        const memberships = await db.all(
            `SELECT m.id, m.site_id, m.program_id, s.name AS site_name, p.name AS program_name
             FROM memberships m JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id
             WHERE m.employee_id = ? ORDER BY s.name, p.name`, [id]);
        const scopes = await db.all(
            `SELECT sc.id, sc.site_id, sc.program_id, s.name AS site_name, COALESCE(p.name, 'All programs') AS program_name
             FROM scopes sc JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id
             WHERE sc.employee_id = ? ORDER BY s.name, p.name`, [id]);
        return { memberships, scopes };
    }

    // ---------- List ----------
    app.get('/admin/accounts', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const v = visibleSql(req.session, 'e');
        const people = await db.all(
            'SELECT e.id, e.name, e.username, e.hourly_rate, e.is_admin, e.is_district FROM employees e WHERE ' + v.sql + ' ORDER BY e.name',
            v.params
        );
        const ids = people.map(p => p.id);
        const where = ids.length ? ids.map(() => '?').join(',') : 'NULL';
        const m = await db.all(
            `SELECT m.employee_id, s.name AS site_name, p.name AS program_name FROM memberships m
             JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id WHERE m.employee_id IN (${where})`, ids);
        const sc = await db.all(
            `SELECT sc.employee_id, s.name AS site_name, COALESCE(p.name, 'All programs') AS program_name FROM scopes sc
             JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id WHERE sc.employee_id IN (${where})`, ids);
        const by = {};
        [...m, ...sc].forEach(r => { (by[r.employee_id] = by[r.employee_id] || []).push(r.site_name + ' / ' + r.program_name); });
        res.render('admin_accounts', {
            flash: takeFlash(req),
            people: people.map(p => ({
                id: p.id, name: p.name, username: p.username, rate: Number(p.hourly_rate || 0).toFixed(2),
                role: roleOf(p), roleName: ROLE_NAMES[roleOf(p)], areas: by[p.id] || [], self: p.id === req.session.userID
            }))
        });
    }));

    // ---------- Edit form ----------
    app.get('/admin/accounts/edit', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const id = parseInt(req.query.id, 10);
        if (!(await openable(db, req, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT id, name, username, hourly_rate, is_admin, is_district FROM employees WHERE id = ?', [id]);
        if (!emp) return res.redirect('/admin/accounts');
        const role = roleOf(emp);
        const isSelf = id === req.session.userID;
        const isDistrict = req.session.district === 1;
        const { memberships, scopes } = await assignmentsOf(db, id);

        // Which areas this admin may add, and which existing ones they may remove
        const units = await allowedUnits(db, req.session);
        const unitSet = new Set(units.map(u => u.value));
        let addOptions = units.map(u => ({ value: u.value, label: u.label }));
        if (role === 1 && isDistrict) {
            const sites = await db.all('SELECT id, name FROM sites ORDER BY name');
            addOptions = sites.map(s => ({ value: s.id + ':ALL', label: s.name + ' / All programs' })).concat(addOptions);
        }
        res.render('admin_account_edit', {
            flash: takeFlash(req),
            emp: { id: emp.id, name: emp.name, username: emp.username, rate: Number(emp.hourly_rate || 0).toFixed(2) },
            role, roleName: ROLE_NAMES[role], isSelf, isDistrict,
            memberships: memberships.map(a => ({ ...a, removable: unitSet.has(a.site_id + ':' + a.program_id) })),
            scopes: scopes.map(a => ({ ...a, removable: isDistrict })),
            addOptions: (role === 2 || isSelf) ? [] : addOptions
        });
    }));

    // ---------- Save name / username / rate / role ----------
    app.post('/admin/accounts/save', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const id = parseInt(req.body.id, 10);
        if (!(await openable(db, req, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT id, name, username, hourly_rate, is_admin, is_district FROM employees WHERE id = ?', [id]);
        if (!emp) return res.redirect('/admin/accounts');
        const isSelf = id === req.session.userID;
        const isDistrict = req.session.district === 1;
        const oldRole = roleOf(emp);

        const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
        const username = String(req.body.username || '').trim();
        if (name.length < 2 || name.length > 80) { flash(req, 'Enter the full name (2 to 80 characters).', true); return res.redirect(back(id)); }
        if (!/^[^\s]{3,40}$/.test(username)) { flash(req, 'Usernames are 3 to 40 characters with no spaces.', true); return res.redirect(back(id)); }
        const clash = await db.get('SELECT id FROM employees WHERE lower(username) = lower(?) AND id != ?', [username, id]);
        if (clash) { flash(req, 'That username is already taken.', true); return res.redirect(back(id)); }

        let rate = Number(emp.hourly_rate || 0);
        if (!isSelf && req.body.hourly_rate !== undefined) {
            const r = parseFloat(req.body.hourly_rate);
            if (!isFinite(r) || r < 0 || r > 500) { flash(req, 'Enter an hourly rate between 0 and 500.', true); return res.redirect(back(id)); }
            rate = Math.round(r * 100) / 100;
        }

        let newRole = oldRole;
        if (isDistrict && !isSelf && req.body.role !== undefined) {
            newRole = Math.min(Math.max(parseInt(req.body.role, 10) || 0, 0), 2);
        }
        if (oldRole === 2 && newRole !== 2) {
            const others = await db.get('SELECT COUNT(*) AS n FROM employees WHERE is_district = 1 AND id != ?', [id]);
            if (!others.n) { flash(req, 'There must always be at least one district administrator.', true); return res.redirect(back(id)); }
        }

        const changes = [];
        if (name !== emp.name) changes.push('name "' + emp.name + '" to "' + name + '"');
        if (username !== emp.username) changes.push('username "' + emp.username + '" to "' + username + '"');
        if (rate !== Number(emp.hourly_rate || 0)) changes.push('rate $' + Number(emp.hourly_rate || 0).toFixed(2) + ' to $' + rate.toFixed(2));
        if (newRole !== oldRole) changes.push('role ' + ROLE_NAMES[oldRole] + ' to ' + ROLE_NAMES[newRole]);
        if (!changes.length) { flash(req, 'Nothing was changed.'); return res.redirect(back(id)); }

        let note = '';
        await db.run('BEGIN');
        try {
            await db.run('UPDATE employees SET name = ?, username = ?, hourly_rate = ?, is_admin = ?, is_district = ? WHERE id = ?',
                [name, username, rate, newRole >= 1 ? 1 : 0, newRole === 2 ? 1 : 0, id]);

            // Keep the assignment rules consistent: only employees have site/program memberships; managers have scopes.
            if (newRole !== oldRole) {
                if (oldRole === 0 && newRole === 1) {
                    await db.run('INSERT INTO scopes (employee_id, site_id, program_id) SELECT employee_id, site_id, program_id FROM memberships WHERE employee_id = ?', [id]);
                    await db.run('DELETE FROM memberships WHERE employee_id = ?', [id]);
                } else if (oldRole === 0 && newRole === 2) {
                    await db.run('DELETE FROM memberships WHERE employee_id = ?', [id]);
                } else if (oldRole === 1 && newRole === 0) {
                    await db.run('INSERT OR IGNORE INTO memberships (employee_id, site_id, program_id) SELECT employee_id, site_id, program_id FROM scopes WHERE employee_id = ? AND program_id IS NOT NULL', [id]);
                    const dropped = await db.get('SELECT COUNT(*) AS n FROM scopes WHERE employee_id = ? AND program_id IS NULL', [id]);
                    await db.run('DELETE FROM scopes WHERE employee_id = ?', [id]);
                    if (dropped.n) note = ' Site-wide manager access was removed. Add the site and program this employee works in.';
                } else if (oldRole === 1 && newRole === 2) {
                    await db.run('DELETE FROM scopes WHERE employee_id = ?', [id]);
                } else if (oldRole === 2 && newRole === 1) {
                    note = ' Add the site or sites this manager oversees, or they will not see anyone.';
                } else if (oldRole === 2 && newRole === 0) {
                    note = ' Add the site and program this employee works in.';
                }
            }
            await audit(db, req, { id, name }, 'ACCOUNT_EDIT', changes.join('; '));
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        if (isSelf) req.session.name = name;
        flash(req, 'Saved: ' + changes.join(', ') + '.' + note);
        res.redirect(back(id));
    }));

    // ---------- Add an assignment ----------
    app.post('/admin/accounts/assign', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const id = parseInt(req.body.id, 10);
        if (!id || id === req.session.userID || !(await canManage(db, req.session, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT id, name, is_admin, is_district FROM employees WHERE id = ?', [id]);
        if (!emp) return res.redirect('/admin/accounts');
        const role = roleOf(emp);
        if (role === 2) { flash(req, 'District administrators see everything and need no assignment.', true); return res.redirect(back(id)); }

        const value = String(req.body.unit || '');
        const [siteId, prog] = value.split(':');
        const site = await db.get('SELECT id, name FROM sites WHERE id = ?', [parseInt(siteId, 10)]);
        if (!site) { flash(req, 'Choose a school and program.', true); return res.redirect(back(id)); }

        if (role === 1) {
            if (req.session.district !== 1) return res.redirect('/admin/accounts');
            const programId = prog === 'ALL' ? null : parseInt(prog, 10);
            let progName = 'All programs';
            if (programId !== null) {
                const p = await db.get('SELECT id, name FROM programs WHERE id = ?', [programId]);
                if (!p) { flash(req, 'Choose a school and program.', true); return res.redirect(back(id)); }
                progName = p.name;
            }
            const exists = await db.get('SELECT 1 FROM scopes WHERE employee_id = ? AND site_id = ? AND program_id IS ?', [id, site.id, programId]);
            if (!exists) {
                await db.run('INSERT INTO scopes (employee_id, site_id, program_id) VALUES (?, ?, ?)', [id, site.id, programId]);
                await audit(db, req, emp, 'ACCOUNT_ADD_ASSIGNMENT', 'manager of ' + site.name + ' / ' + progName);
            }
        } else {
            const chosen = (await allowedUnits(db, req.session)).find(u => u.value === value);
            if (!chosen) { flash(req, 'You can only assign people to areas you manage.', true); return res.redirect(back(id)); }
            await db.run('INSERT OR IGNORE INTO memberships (employee_id, site_id, program_id) VALUES (?, ?, ?)', [id, chosen.site_id, chosen.program_id]);
            await audit(db, req, emp, 'ACCOUNT_ADD_ASSIGNMENT', 'works in ' + chosen.label);
        }
        flash(req, 'Assignment added.');
        res.redirect(back(id));
    }));

    // ---------- Remove an assignment ----------
    app.post('/admin/accounts/unassign', wrap(async (req, res) => {
        if (needAdmin(req, res)) return;
        const db = await database();
        const id = parseInt(req.body.id, 10);
        if (!id || id === req.session.userID || !(await canManage(db, req.session, id))) return res.redirect('/admin/accounts');
        const emp = await db.get('SELECT id, name FROM employees WHERE id = ?', [id]);
        if (!emp) return res.redirect('/admin/accounts');
        const kind = req.body.kind === 'scope' ? 'scope' : 'membership';
        const rowId = parseInt(req.body.rowId, 10);

        if (kind === 'scope') {
            if (req.session.district !== 1) return res.redirect('/admin/accounts');
            const row = await db.get(
                `SELECT sc.id, s.name AS site_name, COALESCE(p.name, 'All programs') AS program_name FROM scopes sc
                 JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id WHERE sc.id = ? AND sc.employee_id = ?`, [rowId, id]);
            if (!row) return res.redirect(back(id));
            await db.run('DELETE FROM scopes WHERE id = ?', [rowId]);
            await audit(db, req, emp, 'ACCOUNT_REMOVE_ASSIGNMENT', 'no longer manages ' + row.site_name + ' / ' + row.program_name);
        } else {
            const row = await db.get(
                `SELECT m.id, m.site_id, m.program_id, s.name AS site_name, p.name AS program_name FROM memberships m
                 JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id WHERE m.id = ? AND m.employee_id = ?`, [rowId, id]);
            if (!row) return res.redirect(back(id));
            const ok = (await allowedUnits(db, req.session)).some(u => u.value === row.site_id + ':' + row.program_id);
            if (!ok) { flash(req, 'You can only remove assignments in areas you manage.', true); return res.redirect(back(id)); }
            await db.run('DELETE FROM memberships WHERE id = ?', [rowId]);
            await audit(db, req, emp, 'ACCOUNT_REMOVE_ASSIGNMENT', 'no longer works in ' + row.site_name + ' / ' + row.program_name);
        }
        flash(req, 'Assignment removed.');
        res.redirect(back(id));
    }));
};
