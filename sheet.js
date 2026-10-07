// sheet.js - talks to the Google Apps Script web app attached to the master sheet.
// Settings (Render environment): SHEET_WEBAPP_URL = the web app address (ends in /exec), SHEET_TOKEN = the shared password.
const https = require('https');
const http = require('http');

const configured = () => !!(process.env.SHEET_WEBAPP_URL && process.env.SHEET_TOKEN);

function request(urlStr, method, body, hops, timeoutMs) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(new Error('The sheet address is not valid.')); }
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(u, {
            method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}, timeout: timeoutMs
        }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (hops >= 5) return reject(new Error('Too many redirects from the sheet.'));
                const next = new URL(res.headers.location, u).href;
                const keep = res.statusCode === 307 || res.statusCode === 308;
                return resolve(request(next, keep ? method : 'GET', keep ? body : null, hops + 1, timeoutMs));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; if (data.length > 2e6) req.destroy(new Error('Reply too large.')); });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('timeout', () => req.destroy(new Error('The sheet took too long to answer.')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Returns the script's reply ({ ok: true, ... }) or throws an Error with a plain-language message.
async function call(action, values) {
    if (!configured()) throw new Error('The sheet connection is not set up yet.');
    const payload = JSON.stringify({ token: process.env.SHEET_TOKEN, action, values: values || {} });
    const res = await request(process.env.SHEET_WEBAPP_URL, 'POST', payload, 0, 25000);
    let j;
    try { j = JSON.parse(res.body); } catch (e) { throw new Error('The sheet did not answer correctly (check that the web app is deployed with access set to Anyone).'); }
    if (!j.ok) throw new Error(j.error || 'The sheet refused the request.');
    return j;
}

module.exports = { configured, call };
