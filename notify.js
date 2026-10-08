// Email alerts: tells the student (or whoever is on the ticket) when a repair is ready for pickup.
// Sends through the Resend email service (https://resend.com): set RESEND_API_KEY and MAIL_FROM on Render.
const https = require('https');
const http = require('http');
const bench = require('./bench');
const L = require('./ticketlib');

const apiUrl = () => process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const configured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const ccList = () => String(process.env.NOTIFY_CC || '').split(/[,;\s]+/).filter(L.isEmail);

function send({ to, subject, text }) {
    return new Promise(resolve => {
        let u; try { u = new URL(apiUrl()); } catch (e) { return resolve({ ok: false, error: 'The email service address is not valid.' }); }
        const body = JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text });
        const mod = u.protocol === 'http:' ? http : https;
        const req = mod.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 8000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + process.env.RESEND_API_KEY } }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
                let msg = ''; try { const j = JSON.parse(d); msg = j.message || j.error || ''; } catch (e) {}
                resolve({ ok: false, error: 'The email service said no (' + res.statusCode + ')' + (msg ? ': ' + String(msg).slice(0, 160) : '.') });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'The email service did not answer in time.' }); });
        req.on('error', e => resolve({ ok: false, error: 'Could not reach the email service (' + e.message + ').' }));
        req.end(body);
    });
}

const recipients = t => [...new Set([t.notify_email, ...ccList()].filter(L.isEmail))];
const message = t => ({
    subject: 'Ready for pickup: ' + t.model,
    text: 'Hi ' + (t.student_first || 'there') + ',\n\n' +
        'Your ' + t.model + (t.serial ? ' (serial / asset ID ' + t.serial + ')' : '') + ' has been repaired and is ready for pickup from the Student Tech Work Bench.\n\n' +
        'Ticket number: ' + t.id + '\n' +
        (process.env.PICKUP_NOTE ? '\n' + process.env.PICKUP_NOTE + '\n' : '') +
        '\nThank you,\nStudent Tech Work Bench'
});

// Called when a ticket moves to "Repaired - Ready for Pickup". Never throws.
async function onReady(db, t, opts) {
    try {
        if (!configured()) return { status: 'disabled' };
        const to = recipients(t);
        if (!to.length) return { status: 'skipped' };
        const last = L.parse(t.notified_at);
        if (!(opts && opts.force) && last && Date.now() - last < 10 * 60 * 1000) return { status: 'recent' };
        const m = message(t);
        const r = await send({ to, subject: m.subject, text: m.text });
        if (r.ok) { await db.run('UPDATE repair_tickets SET notified_at = ? WHERE id = ?', [L.sqlNow(), t.id]); return { status: 'sent', to }; }
        return { status: 'failed', to, error: r.error };
    } catch (e) { return { status: 'failed', error: e.message }; }
}
const describe = r => r.status === 'sent' ? 'Email sent to ' + r.to.join(', ') + '.' : r.status === 'failed' ? 'Email could not be sent: ' + (r.error || 'unknown error') :
    r.status === 'skipped' ? 'No email sent (no address on this ticket).' : r.status === 'recent' ? 'Email already sent a moment ago.' : '';

function mount(app, getDb, wrap) {
    const flash = (req, msg, bad) => { req.session.flash = { msg, bad: !!bad }; };
    async function gate(req, res) {
        if (!req.session.userID) { res.redirect('/'); return null; }
        const db = getDb(); await L.ensureSchema(db);
        if (!(await bench.hasBench(db, req.session))) { res.redirect('/dashboard'); return null; }
        if (req.session.admin !== 1) { res.redirect('/bench/queue'); return null; }
        return db;
    }
    app.get('/bench/email', wrap(async (req, res) => {
        if (!(await gate(req, res))) return;
        const f = req.session.flash || null; delete req.session.flash;
        res.render('bench_email', { flash: f, configured: configured(), from: process.env.MAIL_FROM || '', cc: ccList(), pickup: process.env.PICKUP_NOTE || '', keySet: !!process.env.RESEND_API_KEY, fromSet: !!process.env.MAIL_FROM });
    }));
    app.post('/bench/email/test', wrap(async (req, res) => {
        if (!(await gate(req, res))) return;
        const to = String((req.body || {}).to || '').trim();
        if (!configured()) flash(req, 'Email is not set up yet (see the steps below).', true);
        else if (!L.isEmail(to)) flash(req, 'Enter a valid email address to send the test to.', true);
        else {
            const r = await send({ to: [to], subject: 'Tech Bench test email', text: 'This is a test from the Student Tech Work Bench portal. If you can read this, ready-for-pickup emails will work.' });
            flash(req, r.ok ? 'Test email sent to ' + to + '. Check the inbox (and spam).' : r.error, !r.ok);
        }
        res.redirect('/bench/email');
    }));
}

module.exports = mount;
module.exports.configured = configured;
module.exports.onReady = onReady;
module.exports.describe = describe;
module.exports.recipients = recipients;
module.exports.send = send;
