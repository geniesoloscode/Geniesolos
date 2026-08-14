/* Theme toggle for terms.html: the same behavior as the homepage's, in its
   own file rather than inline because the CloudFront CSP is script-src 'self'
   plus one hash, so any other inline script is blocked by the browser. */
(function () {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;

  var meta = document.getElementById('themeColor');
  var root = document.documentElement;

  function apply(name, persist) {
    if (name === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');

    btn.setAttribute('aria-checked', String(name === 'dark'));
    btn.setAttribute('aria-label', name === 'dark' ? 'Light theme' : 'Dark theme');
    if (meta) meta.setAttribute('content', name === 'dark' ? '#060807' : '#FAF5EC');

    if (persist) {
      try { localStorage.setItem('gs-theme', name); } catch (e) { /* private mode */ }
    }
  }

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  apply(current(), false);
  btn.addEventListener('click', function () {
    apply(current() === 'dark' ? 'light' : 'dark', true);
  });

  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var onSystem = function (e) {
    var chosen = null;
    try { chosen = localStorage.getItem('gs-theme'); } catch (err) { /* ignore */ }
    if (!chosen) apply(e.matches ? 'dark' : 'light', false);
  };
  if (mq.addEventListener) mq.addEventListener('change', onSystem);
  else if (mq.addListener) mq.addListener(onSystem);
})();
