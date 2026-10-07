// scope.js - sites, programs, and "who can manage whom".
//
// Account levels:
//   employee          is_admin = 0
//   manager           is_admin = 1, is_district = 0  -> limited to the site/program scopes assigned to them
//   district admin    is_admin = 1, is_district = 1  -> sees and manages everything
//
// A scope with program_id NULL means "every program at that site".
const ejs = require('ejs');

// SQL fragment limiting a query to the employees this session may see.
// `alias` is the employees table name or alias used in the query.
function visibleSql(session, alias) {
    if (session.district === 1) return { sql: '1=1', params: [] };
    if (session.admin !== 1) return { sql: alias + '.id = ?', params: [session.userID] };
    return {
        sql:
            alias + '.id IN (SELECT m.employee_id FROM memberships m ' +
            'JOIN scopes s ON s.employee_id = ? AND s.site_id = m.site_id ' +
            'AND (s.program_id IS NULL OR s.program_id = m.program_id))',
        params: [session.userID]
    };
}

// May this session manage the given account? (Own account is never "managed".)
async function canManage(db, session, targetId) {
    if (session.admin !== 1 || !targetId) return false;
    if (session.district === 1) {
        return !!(await db.get('SELECT 1 FROM employees WHERE id = ?', [targetId]));
    }
    const v = visibleSql(session, 'e');
    return !!(await db.get('SELECT 1 FROM employees e WHERE e.id = ? AND ' + v.sql, [targetId, ...v.params]));
}

// Accounts shown in the admin lists (reset, remove). Managers see only their own areas.
async function manageableAccounts(db, session) {
    const v = visibleSql(session, 'e');
    return db.all(
        'SELECT e.id, e.name, e.username, e.is_admin, e.is_district FROM employees e WHERE ' + v.sql + ' ORDER BY e.name',
        v.params
    );
}

// The site / program combinations this session may add accounts to.
async function allowedUnits(db, session) {
    if (session.admin !== 1) return [];
    let rows;
    if (session.district === 1) {
        rows = await db.all(
            'SELECT s.id AS site_id, s.name AS site_name, p.id AS program_id, p.name AS program_name ' +
            'FROM sites s CROSS JOIN programs p ORDER BY s.name, p.name'
        );
    } else {
        rows = await db.all(
            'SELECT DISTINCT s.id AS site_id, s.name AS site_name, p.id AS program_id, p.name AS program_name ' +
            'FROM scopes sc JOIN sites s ON s.id = sc.site_id ' +
            'JOIN programs p ON (sc.program_id IS NULL OR p.id = sc.program_id) ' +
            'WHERE sc.employee_id = ? ORDER BY s.name, p.name',
            [session.userID]
        );
    }
    return rows.map(r => ({
        value: r.site_id + ':' + r.program_id,
        label: r.site_name + ' / ' + r.program_name,
        site_id: r.site_id,
        program_id: r.program_id
    }));
}

// ---------- District-only page: sites, programs, assignments ----------
const { headTags } = require('./ui');
const ORG_TPL =
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Sites and assignments - Timecard Portal</title>' + headTags +
    '</head><body><%- navHtml %>' + `
<h1>Sites and assignments</h1>
<p class="sub">Set up schools and programs, and decide who works or manages where.</p>
<% if (message) { %><div class="msg" role="status"><%= message %></div><% } %>

<div class="grid2">
  <div class="panel">
    <h3>Sites</h3>
    <p><% sites.forEach(s => { %><span class="badge" style="margin:0 6px 6px 0;"><%= s.name %></span><% }) %></p>
    <form action="/admin/org/site" method="POST">
      <label for="siteName">New site</label>
      <input type="text" id="siteName" name="name" maxlength="80" required>
      <button type="submit">Add site</button>
    </form>
  </div>
  <div class="panel">
    <h3>Programs</h3>
    <p><% programs.forEach(p => { %><span class="badge" style="margin:0 6px 6px 0;"><%= p.name %></span><% }) %></p>
    <form action="/admin/org/program" method="POST">
      <label for="programName">New program</label>
      <input type="text" id="programName" name="name" maxlength="80" required>
      <button type="submit">Add program</button>
    </form>
  </div>
</div>

<div class="grid2">
  <div class="panel">
    <h3>Add an assignment</h3>
    <p class="hint">Employees can work in more than one site or program, and managers can oversee more than one. Choose "All programs" to give a manager a whole site.</p>
    <form action="/admin/org/assign" method="POST">
      <label for="accountId">Account</label>
      <select id="accountId" name="employeeId" required>
        <option value="">Choose an account</option>
        <% accounts.forEach(a => { %>
          <option value="<%= a.id %>"><%= a.name %> (<%= a.username %>) - <%= a.is_district ? 'District administrator' : (a.is_admin ? 'Manager' : 'Employee') %></option>
        <% }) %>
      </select>
      <label for="siteId">Site</label>
      <select id="siteId" name="site_id" required>
        <% sites.forEach(s => { %><option value="<%= s.id %>"><%= s.name %></option><% }) %>
      </select>
      <label for="programId">Program</label>
      <select id="programId" name="program_id" required>
        <option value="ALL">All programs (managers only)</option>
        <% programs.forEach(p => { %><option value="<%= p.id %>"><%= p.name %></option><% }) %>
      </select>
      <button type="submit">Add assignment</button>
    </form>
  </div>

  <div class="panel">
    <h3>Assign several accounts at once</h3>
    <% if (!unassigned.length) { %>
      <p class="hint">Every account is already assigned.</p>
    <% } else { %>
    <p class="hint">These accounts have no site or program yet. Tick the people, choose where they work, and assign them together.</p>
    <form action="/admin/org/bulk" method="POST">
      <% unassigned.forEach(a => { %>
        <label><input type="checkbox" name="employeeIds" value="<%= a.id %>"> <%= a.name %> (<%= a.username %>) - <%= a.is_admin ? 'Manager' : 'Employee' %></label>
      <% }) %>
      <label for="bulkSite">Site</label>
      <select id="bulkSite" name="site_id" required>
        <% sites.forEach(s => { %><option value="<%= s.id %>"><%= s.name %></option><% }) %>
      </select>
      <label for="bulkProgram">Program</label>
      <select id="bulkProgram" name="program_id" required>
        <option value="ALL">All programs (managers only)</option>
        <% programs.forEach(p => { %><option value="<%= p.id %>"><%= p.name %></option><% }) %>
      </select>
      <button type="submit">Assign selected accounts</button>
    </form>
    <% } %>
  </div>
</div>

<h3>Current assignments</h3>
<div class="table-wrap">
<table>
  <thead><tr><th>Account</th><th>Level</th><th>Site</th><th>Program</th></tr></thead>
  <tbody>
  <% assignments.forEach(r => { %>
    <tr><td><%= r.name %></td><td><%= r.level %></td><td><%= r.site_name %></td><td><%= r.program_name %></td></tr>
  <% }) %>
  <% if (!assignments.length) { %><tr><td colspan="4" class="empty">No assignments yet.</td></tr><% } %>
  </tbody>
</table>
</div>
</body></html>`;

const ORG_MESSAGES = {
    ok: 'Saved.',
    bad: 'That change could not be saved. Check the choices and try again.',
    dup: 'That name already exists.',
    all: '"All programs" can only be given to managers.'
};

function mount(app, getDb, wrap) {
    const needDistrict = (req, res) => {
        if (req.session.district !== 1) { res.redirect('/'); return true; }
        return false;
    };

    app.get('/admin/org', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb();
        const sites = await db.all('SELECT id, name FROM sites ORDER BY name');
        const programs = await db.all('SELECT id, name FROM programs ORDER BY name');
        const accounts = await db.all('SELECT id, name, username, is_admin, is_district FROM employees ORDER BY name');
        const unassigned = await db.all(`
            SELECT id, name, username, is_admin FROM employees
            WHERE is_district = 0
              AND id NOT IN (SELECT employee_id FROM memberships)
              AND id NOT IN (SELECT employee_id FROM scopes)
            ORDER BY name
        `);
        const assignments = await db.all(`
            SELECT e.name, 'Employee' AS level, s.name AS site_name, p.name AS program_name
              FROM memberships m JOIN employees e ON e.id = m.employee_id
              JOIN sites s ON s.id = m.site_id JOIN programs p ON p.id = m.program_id
            UNION ALL
            SELECT e.name, 'Manager', s.name, COALESCE(p.name, 'All programs')
              FROM scopes sc JOIN employees e ON e.id = sc.employee_id
              JOIN sites s ON s.id = sc.site_id LEFT JOIN programs p ON p.id = sc.program_id
            ORDER BY 1, 3, 4
        `);
        res.send(ejs.render(ORG_TPL, {
            navHtml: res.locals.navHtml,
            sites, programs, accounts, assignments, unassigned,
            message: ORG_MESSAGES[req.query.msg] || null
        }));
    }));

    const addName = (table) => wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const name = String(req.body.name || '').trim().slice(0, 80);
        if (!name) return res.redirect('/admin/org?msg=bad');
        try {
            await getDb().run('INSERT INTO ' + table + ' (name) VALUES (?)', [name]);
        } catch (err) {
            return res.redirect('/admin/org?msg=dup');
        }
        res.redirect('/admin/org?msg=ok');
    });
    app.post('/admin/org/site', addName('sites'));
    app.post('/admin/org/program', addName('programs'));

    app.post('/admin/org/bulk', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb();
        const ids = [].concat(req.body.employeeIds || []).map(n => parseInt(n, 10)).filter(Boolean);
        const siteId = parseInt(req.body.site_id, 10);
        const allPrograms = req.body.program_id === 'ALL';
        const programId = allPrograms ? null : parseInt(req.body.program_id, 10);

        const site = await db.get('SELECT id FROM sites WHERE id = ?', [siteId]);
        const prog = allPrograms ? true : await db.get('SELECT id FROM programs WHERE id = ?', [programId]);
        if (!ids.length || !site || !prog) return res.redirect('/admin/org?msg=bad');

        let skipped = false;
        await db.run('BEGIN');
        try {
            for (const id of ids) {
                const emp = await db.get('SELECT id, is_admin, is_district FROM employees WHERE id = ?', [id]);
                if (!emp || emp.is_district) continue;
                if (emp.is_admin) {
                    const exists = await db.get(
                        'SELECT 1 FROM scopes WHERE employee_id = ? AND site_id = ? AND program_id IS ?',
                        [id, siteId, programId]
                    );
                    if (!exists) await db.run('INSERT INTO scopes (employee_id, site_id, program_id) VALUES (?, ?, ?)', [id, siteId, programId]);
                } else if (allPrograms) {
                    skipped = true;
                } else {
                    await db.run('INSERT OR IGNORE INTO memberships (employee_id, site_id, program_id) VALUES (?, ?, ?)', [id, siteId, programId]);
                }
            }
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        res.redirect('/admin/org?msg=' + (skipped ? 'all' : 'ok'));
    }));

    app.post('/admin/org/assign', wrap(async (req, res) => {
        if (needDistrict(req, res)) return;
        const db = getDb();
        const employeeId = parseInt(req.body.employeeId, 10);
        const siteId = parseInt(req.body.site_id, 10);
        const allPrograms = req.body.program_id === 'ALL';
        const programId = allPrograms ? null : parseInt(req.body.program_id, 10);

        const emp = await db.get('SELECT id, is_admin, is_district FROM employees WHERE id = ?', [employeeId]);
        const site = await db.get('SELECT id FROM sites WHERE id = ?', [siteId]);
        const prog = allPrograms ? true : await db.get('SELECT id FROM programs WHERE id = ?', [programId]);
        if (!emp || !site || !prog) return res.redirect('/admin/org?msg=bad');
        if (emp.is_district) return res.redirect('/admin/org?msg=bad');

        if (emp.is_admin) {
            const exists = await db.get(
                'SELECT 1 FROM scopes WHERE employee_id = ? AND site_id = ? AND program_id IS ?',
                [employeeId, siteId, programId]
            );
            if (!exists) {
                await db.run('INSERT INTO scopes (employee_id, site_id, program_id) VALUES (?, ?, ?)', [employeeId, siteId, programId]);
            }
        } else {
            if (allPrograms) return res.redirect('/admin/org?msg=all');
            await db.run(
                'INSERT OR IGNORE INTO memberships (employee_id, site_id, program_id) VALUES (?, ?, ?)',
                [employeeId, siteId, programId]
            );
        }
        res.redirect('/admin/org?msg=ok');
    }));
}

module.exports = { visibleSql, canManage, manageableAccounts, allowedUnits, mount };
