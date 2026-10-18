// Menu collapsing. Remembers (in this browser only) which menu sections are folded and whether the whole menu is minimized.
(function () {
  var KEY_G = 'tb.nav.groups', KEY_M = 'tb.nav.min';
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: it just will not be remembered */ } }
  var root = document.documentElement;
  if (load(KEY_M, false) === true) root.classList.add('navmin');           // set before the page paints, so it does not flash open

  function setGroup(btn, folded) {
    var ul = btn.nextElementSibling; if (!ul || ul.tagName !== 'UL') return;
    ul.hidden = folded; btn.setAttribute('aria-expanded', folded ? 'false' : 'true'); btn.classList.toggle('folded', folded);
  }
  document.addEventListener('DOMContentLoaded', function () {
    var folded = load(KEY_G, {});
    document.querySelectorAll('.side .grp[data-grp]').forEach(function (b) {
      var hasActive = b.nextElementSibling && b.nextElementSibling.querySelector('a.active');
      setGroup(b, !!folded[b.getAttribute('data-grp')] && !hasActive);     // the section you are in always stays open
    });
    var m = document.querySelector('.side .sidemin');
    if (m) m.setAttribute('aria-pressed', root.classList.contains('navmin') ? 'true' : 'false');
  });
  document.addEventListener('click', function (e) {
    var g = e.target.closest && e.target.closest('.side .grp[data-grp]');
    if (g) {
      var now = g.getAttribute('aria-expanded') === 'true';               // currently open -> fold it
      setGroup(g, now);
      var s = load(KEY_G, {}); s[g.getAttribute('data-grp')] = now; save(KEY_G, s);
      return;
    }
    var m = e.target.closest && e.target.closest('.side .sidemin');
    if (m) {
      var on = root.classList.toggle('navmin');
      m.setAttribute('aria-pressed', on ? 'true' : 'false'); save(KEY_M, on);
    }
  });
})();
