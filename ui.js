// ui.js - builds the sidebar menu once so every page (view files and built-in pages) shares it.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
    home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    print: '<path d="M7 9V3h10v6M7 18H4v-7h16v7h-3M7 14h10v7H7z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    log: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
    org: '<path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/>',
    db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 010 7M18 14c2.2.6 3.5 2.6 3.5 6"/>',
    book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 21h15M8 7h7"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const svg = k => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>';

// ---------- Site themes (school colors) ----------
// Each theme only sets color tokens; app.css does the rest. "lit" is the bright version used on dark surfaces.
const THEMES = {
    district: { key: 'district', name: 'Kalispell School District No. 5', short: 'District', tagline: 'Real Careers Start Before Graduation.',
        logo: '/logos/district.png', badge: '/logos/district.png',
        light: { ink: '#0d1624', ink2: '#16233a', accent: '#2a5bff', soft: '#e6edff', lit: '#5b82ff', hero: 'linear-gradient(135deg,#0d1624 0%,#0d1624 55%,#1d3fb3 150%)' },
        dark: { ink: '#070d17', ink2: '#101c31', accent: '#5b82ff', soft: '#172448' } },
    glacier: { key: 'glacier', name: 'Glacier High School', short: 'Glacier', tagline: 'Strength in the Pack, Precision on the Bench.',
        logo: '/logos/glacier-wolf.png', badge: '/logos/glacier-wolf.png',
        light: { ink: '#0a1b3d', ink2: '#12294f', accent: '#12843f', soft: '#dcf3e5', lit: '#35d07a', hero: 'linear-gradient(135deg,#0d2557 0%,#0a1b3d 55%,#0f6a3a 150%)' },
        dark: { ink: '#06112a', ink2: '#0d1f40', accent: '#3ccf78', soft: '#0f2d1d' } },
    flathead: { key: 'flathead', name: 'Flathead High School', short: 'Flathead', tagline: 'Crafted on the Bench, Ready for the Field.',
        logo: '/logos/flathead-spear.png', badge: '/logos/flathead-spear.png',
        light: { ink: '#121110', ink2: '#201c19', accent: '#d9480f', soft: '#fde8dc', lit: '#ff8a2a', hero: 'linear-gradient(135deg,#1a1512 0%,#121110 55%,#8a3409 150%)' },
        dark: { ink: '#0b0a09', ink2: '#1a1613', accent: '#ff8a4c', soft: '#3a1e10' } },
    linderman: { key: 'linderman', name: 'Linderman Education Center', short: 'Linderman', tagline: 'Finding Your Direction, Building Your Future.',
        logo: '/logos/linderman.png', badge: '/logos/linderman.png',
        light: { ink: '#160d28', ink2: '#221542', accent: '#6b3fb0', soft: '#ece4fa', lit: '#a77bff', hero: 'linear-gradient(135deg,#21124a 0%,#160d28 55%,#52308f 150%)' },
        dark: { ink: '#0d0719', ink2: '#190f33', accent: '#b08cff', soft: '#2a1a4d' } }
};
const SITE_THEME = { 'Glacier High School': 'glacier', 'Flathead High School': 'flathead', 'Linderman Education Center': 'linderman' };
// Which school a web address belongs to.
// 1) PORTAL_HOSTS on Render, e.g.  ghs.example.org=glacier,fhs.example.org=flathead,lec.example.org=linderman,portal.example.org=district
// 2) Otherwise the first part of the address is used: ghs./glacier. -> Glacier, fhs./flathead. -> Flathead, lec./linderman. -> Linderman
const HOST_MAP = {};
String(process.env.PORTAL_HOSTS || '').split(',').forEach(pair => {
    const [h, k] = pair.split('=').map(x => (x || '').trim().toLowerCase());
    if (h && THEMES[k]) HOST_MAP[h] = k;
});
const PREFIX_THEME = { ghs: 'glacier', glacier: 'glacier', fhs: 'flathead', flathead: 'flathead', lec: 'linderman', linderman: 'linderman', district: 'district' };
function themeKeyForHost(hostname) {
    const h = String(hostname || '').toLowerCase().split(':')[0];
    if (HOST_MAP[h]) return HOST_MAP[h];
    const first = h.split('.')[0];
    return h.indexOf('.') > 0 && PREFIX_THEME[first] ? PREFIX_THEME[first] : null;
}
const themeFor = key => THEMES[key] || THEMES.district;

function themeStyle(t) {
    const l = t.light, d = t.dark;
    return '<style>:root{--ink:' + l.ink + ';--ink-2:' + l.ink2 + ';--accent:' + l.accent + ';--accent-soft:' + l.soft + ';--lit:' + l.lit + ';--hero:' + l.hero + '}' +
        '@media (prefers-color-scheme:dark){:root{--ink:' + d.ink + ';--ink-2:' + d.ink2 + ';--accent:' + d.accent + ';--accent-soft:' + d.soft + ';--accent-ink:#06100a}}</style>';
}

function navHtml(nav, theme) {
    nav = nav || {};
    theme = theme || THEMES.district;
    const path = nav.path || '';
    const item = (href, icon, label, active) =>
        '<li><a href="' + href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + svg(icon) + label + '</a></li>';
    const starts = p => path.indexOf(p) === 0;

    let h = '<aside class="side"><a class="brand" href="/dashboard">' +
        (theme.badge ? '<span class="mark logo"><img src="' + theme.badge + '" alt=""></span>' : '<span class="mark">' + svg('clock') + '</span>') +
        '<span class="bt">Timecard Portal<small>' + esc(theme.key === 'district' ? 'District office' : theme.name) + '</small></span></a>' +
        '<input type="checkbox" id="navToggle" aria-label="Menu"><label for="navToggle" class="burger">Menu</label><nav>';

    h += '<div class="grp">My time</div><ul>' +
        item('/dashboard', 'home', 'Dashboard', path === '/dashboard') +
        (nav.admin ? '' : item('/requests/new', 'plus', 'Request missed hours', starts('/requests'))) +
        item('/timecards', 'list', 'Past timecards', path === '/timecards') +
        item('/timecards/print', 'print', 'Print timecard', path === '/timecards/print') + '</ul>';

    if (nav.resources) {
        h += '<div class="grp">Resources</div><ul>' +
            item('/learn', 'book', 'Learn', starts('/learn')) +
            item('/links', 'link', 'Quick links', starts('/links')) + '</ul>';
    }

    if (nav.admin) {
        h += '<div class="grp">Manage</div><ul>' +
            item('/admin/requests', 'inbox', 'Pending requests', starts('/admin/requests')) +
            item('/admin/accounts', 'users', 'Accounts', starts('/admin/accounts')) +
            item('/admin/shifts', 'edit', 'Edit timecards', starts('/admin/shifts')) +
            item('/admin/users/reset', 'key', 'Reset password', path === '/admin/users/reset') + '</ul>';
    }
    if (nav.district) {
        h += '<div class="grp">District</div><ul>' +
            item('/admin/org', 'org', 'Sites &amp; assignments', path === '/admin/org') +
            item('/admin/audit', 'log', 'Audit log', path === '/admin/audit') +
            item('/admin/backup', 'db', 'Download backup', false) + '</ul>';
    }

    const role = nav.district ? 'District administrator' : (nav.admin ? 'Manager' : 'Employee');
    h += '</nav><div class="user"><strong>' + esc(nav.name) + '</strong>' + role + ' &middot; <a href="/logout">Log out</a></div></aside>';
    return h;
}

// Font + stylesheet tags used by built-in pages
const headTags =
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">' +
    '<link rel="stylesheet" href="/app.css">';

module.exports = { navHtml, headTags, themeStyle, themeFor, themeKeyForHost, THEMES, SITE_THEME, esc };
