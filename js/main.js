/* ═══════════════════════════════════════════════════════════════
   GENIESOLOS — portfolio runtime
   Boot sequence · flow-field canvas · generative portrait
   typewriter · scrollspy · reveals · counters · tilt
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $  = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp  = (a, b, t) => a + (b - a) * t;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ?still=1 — debug/screenshot mode. Renders the fully-settled page:
     no boot, no looping animation, all reveals and counters at final state. */
  const still = /(^|[?&])still=1\b/.test(location.search);
  if (still) {
    document.documentElement.classList.add('still');
    /* Bring the hash target to the top by shifting the document with a
       negative margin rather than scrolling. Headless Chrome under a
       virtual-time budget does not reliably repaint after a programmatic
       scroll, and margin (unlike transform) leaves fixed elements alone. */
    if (location.hash.length > 1) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) {
        const top = target.getBoundingClientRect().top + window.scrollY;
        document.body.style.marginTop = -(top - 20) + 'px';
      }
    }
  }

  const calm = reduced || still;   /* "don't run perpetual motion" */

  /* ─────────────────────────────────────────────────────────────
     1. BOOT SEQUENCE
     ───────────────────────────────────────────────────────────── */
  (function boot() {
    const el    = $('#boot');
    const lines = $('#bootLines');
    const bar   = $('#bootBar');
    if (!el) return;

    const finish = () => {
      el.classList.add('done');
      document.body.style.overflow = '';
      setTimeout(() => el.remove(), 700);
    };

    /* skip for reduced-motion, for ?noboot (testing), and on repeat
       views within the same tab session — the intro should delight once */
    let seen = false;
    try { seen = sessionStorage.getItem('gs-booted') === '1'; } catch (e) { /* private mode */ }

    if (calm || seen || /(^|[?&])noboot\b/.test(location.search)) { finish(); return; }
    try { sessionStorage.setItem('gs-booted', '1'); } catch (e) { /* ignore */ }

    document.body.style.overflow = 'hidden';

    const script = [
      ['initializing', 'geniesolos.core'],
      ['mounting /identity', 'GENE GARLAND'],
      ['verifying credentials', 'CISSP · 2024'],
      ['clearance check', 'SECRET — ACTIVE'],
      ['loading fleet telemetry', '500+ SYSTEMS'],
      ['render', 'PORTFOLIO']
    ];

    script.forEach(([label, val], i) => {
      const p = document.createElement('p');
      p.innerHTML = '<b>[ OK ]</b> ' + label +
        ' <span style="opacity:.35">' + '.'.repeat(Math.max(2, 26 - label.length)) + '</span> ' +
        '<i>' + val + '</i>';
      p.style.animationDelay = (i * 0.19) + 's';
      lines.appendChild(p);
    });

    const total = script.length * 190 + 380;
    const t0 = performance.now();
    (function tick(now) {
      const p = clamp((now - t0) / total, 0, 1);
      bar.style.width = (p * 100).toFixed(1) + '%';
      if (p < 1) requestAnimationFrame(tick); else finish();
    })(t0);

    const skip = () => finish();
    el.addEventListener('click', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
  })();

  /* ─────────────────────────────────────────────────────────────
     2. FLOW-FIELD PARTICLE CANVAS
     ───────────────────────────────────────────────────────────── */
  (function field() {
    const cv = $('#fx');
    if (!cv || reduced) return;

    const ctx = cv.getContext('2d', { alpha: true });
    let W = 0, H = 0, DPR = 1;
    let particles = [];
    const mouse = { x: -9999, y: -9999, active: false };

    /* cheap deterministic value noise */
    const hash = (x, y) => {
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return n - Math.floor(n);
    };
    const smooth = t => t * t * (3 - 2 * t);
    function noise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = smooth(xf), v = smooth(yf);
      return lerp(
        lerp(hash(xi, yi),     hash(xi + 1, yi),     u),
        lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u),
        v
      );
    }

    /* threads of brand colour drifting over the cream canvas */
    const PALETTE = [
      [21, 154, 92], [46, 196, 122],          /* greens  */
      [124, 58, 237], [150, 110, 240],        /* violets */
      [232, 158, 16]                          /* amber   */
    ];
    const CANVAS_BG = [250, 245, 236];        /* --cream, for the trail fade */

    function makeParticle(seed) {
      const c = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: 0, vy: 0,
        life: Math.random() * 260 + 90,
        age: seed ? Math.random() * 260 : 0,
        w: Math.random() < 0.14 ? 1.7 : 0.85,
        a: Math.random() * 0.3 + 0.14,
        c: c
      };
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width  = Math.floor(W * DPR);
      cv.height = Math.floor(H * DPR);
      cv.style.width  = W + 'px';
      cv.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = 'rgb(' + CANVAS_BG.join(',') + ')';
      ctx.fillRect(0, 0, W, H);

      const target = clamp(Math.round((W * H) / 13000), 40, 170);
      particles = Array.from({ length: target }, () => makeParticle(true));
    }

    let t = 0, frames = 0;
    function frame() {
      t += 0.0016;
      /* still mode: lay down a few hundred frames of trails, then freeze */
      if (still && ++frames > 300) { raf = 0; return; }

      /* trail fade — lower alpha = longer, more painterly trails */
      ctx.fillStyle = 'rgba(' + CANVAS_BG.join(',') + ', 0.05)';
      ctx.fillRect(0, 0, W, H);

      const SCALE = 0.0022;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const px = p.x, py = p.y;

        const ang = noise(p.x * SCALE, p.y * SCALE + t * 30) * Math.PI * 4;
        p.vx = p.vx * 0.88 + Math.cos(ang) * 0.62;
        p.vy = p.vy * 0.88 + Math.sin(ang) * 0.62;

        /* pointer repulsion */
        if (mouse.active) {
          const dx = p.x - mouse.x, dy = p.y - mouse.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 26000 && d2 > 0.5) {
            const f = (1 - d2 / 26000) * 2.4 / Math.sqrt(d2);
            p.vx += dx * f;
            p.vy += dy * f;
          }
        }

        p.x += p.vx;
        p.y += p.vy;
        p.age++;

        ctx.strokeStyle = 'rgba(' + p.c[0] + ',' + p.c[1] + ',' + p.c[2] + ',' + p.a + ')';
        ctx.lineWidth = p.w;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        if (p.age > p.life || p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30) {
          particles[i] = makeParticle(false);
        }
      }
      raf = requestAnimationFrame(frame);
    }

    let raf = 0;
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 180);
    });

    window.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
    }, { passive: true });
    window.addEventListener('pointerleave', () => { mouse.active = false; });

    /* pause when tab hidden */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) raf = requestAnimationFrame(frame);
    });

    resize();
    raf = requestAnimationFrame(frame);
  })();

  /* ─────────────────────────────────────────────────────────────
     3. GENERATIVE PORTRAIT  (slit-scan silhouette)
     ───────────────────────────────────────────────────────────── */
  (function avatar() {
    const cv = $('#avatar');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const S = 440;

    /* half-width of the figure at a given y — head, neck, shoulders */
    function halfWidth(y) {
      let hw = 0;
      const dy = y - 176;
      if (Math.abs(dy) < 66) hw = Math.sqrt(66 * 66 - dy * dy);          /* head  */
      if (y > 224) hw = Math.max(hw, 26 * clamp((y - 224) / 20, 0, 1));  /* neck  */
      if (y > 258) {                                                      /* torso */
        const t = clamp((y - 258) / 108, 0, 1);
        hw = Math.max(hw, 26 + 152 * (1 - Math.pow(1 - t, 2.1)));
      }
      return hw;
    }

    const TOP = 108, BOT = 372, STEP = 5;

    function draw(time) {
      ctx.clearRect(0, 0, S, S);

      /* backdrop rings */
      ctx.save();
      ctx.translate(S / 2, S / 2);
      ctx.rotate(time * 0.00012);
      for (let r = 74; r <= 206; r += 33) {
        ctx.strokeStyle = 'rgba(124,58,237,' + (0.26 - r / 1400) + ')';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 9]);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();

      /* dot matrix */
      ctx.fillStyle = 'rgba(124,58,237,0.13)';
      for (let x = 20; x < S; x += 22) {
        for (let y = 20; y < S; y += 22) { ctx.fillRect(x, y, 1.4, 1.4); }
      }

      /* travelling highlight band */
      const band = TOP + ((time * 0.055) % (BOT - TOP + 160)) - 80;

      for (let y = TOP; y <= BOT; y += STEP) {
        const hw = halfWidth(y);
        if (hw < 1) continue;

        /* green at the crown fading to violet at the shoulders */
        const k = (y - TOP) / (BOT - TOP);
        const r = Math.round(lerp(23, 124, k));
        const g = Math.round(lerp(161, 58, k));
        const b = Math.round(lerp(94, 237, k));

        /* glitch offset — deterministic per stripe, drifts with time */
        const seed = Math.sin(y * 12.9898 + Math.floor(time / 900) * 78.233) * 43758.5453;
        const rnd = seed - Math.floor(seed);
        const shift = rnd > 0.94 ? (rnd - 0.5) * 34 : 0;

        /* higher floor than the dark original — these are saturated inks
           on warm paper now, not glowing phosphor on black */
        const near = 1 - clamp(Math.abs(y - band) / 58, 0, 1);
        const alpha = 0.52 + near * 0.45;

        ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(3) + ')';
        ctx.fillRect(S / 2 - hw + shift, y, hw * 2, 2.1);

        /* leading edge ticks */
        if (rnd > 0.86) {
          ctx.fillStyle = 'rgba(240,163,26,' + (0.45 + near * 0.5).toFixed(3) + ')';
          ctx.fillRect(S / 2 + hw + 6 + shift, y, 10 + rnd * 22, 2.1);
          ctx.fillRect(S / 2 - hw - 16 - rnd * 22 + shift, y, 10 + rnd * 22, 2.1);
        }
      }

      /* outline glow */
      ctx.strokeStyle = 'rgba(124,58,237,0.34)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let y = TOP; y <= BOT; y += 2) {
        const hw = halfWidth(y);
        if (hw < 1) continue;
        ctx.lineTo(S / 2 + hw, y);
      }
      for (let y = BOT; y >= TOP; y -= 2) {
        const hw = halfWidth(y);
        if (hw < 1) continue;
        ctx.lineTo(S / 2 - hw, y);
      }
      ctx.stroke();

      /* corner reticles */
      ctx.strokeStyle = 'rgba(240,163,26,0.75)';
      ctx.lineWidth = 1.4;
      [[26, 26, 1, 1], [S - 26, 26, -1, 1], [26, S - 26, 1, -1], [S - 26, S - 26, -1, -1]]
        .forEach(([x, y, sx, sy]) => {
          ctx.beginPath();
          ctx.moveTo(x + 16 * sx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + 16 * sy);
          ctx.stroke();
        });
    }

    if (calm) { draw(2400); return; }

    let raf = 0, running = false;
    const loop = ts => { draw(ts); raf = requestAnimationFrame(loop); };

    /* only animate while visible */
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting && !running) { running = true; raf = requestAnimationFrame(loop); }
        else if (!en.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
      });
    }, { threshold: 0.05 });
    io.observe(cv);

    draw(0);
  })();

  /* ─────────────────────────────────────────────────────────────
     4. TYPEWRITER
     ───────────────────────────────────────────────────────────── */
  (function typer() {
    const el = $('#typed');
    if (!el) return;

    const roles = [
      'Systems Engineer, U.S. Federal Government',
      'Cybersecurity Specialist · CISSP',
      'Automation Architect',
      'M.S. Cybersecurity — Old Dominion University',
      'Web Designer for Small Business'
    ];

    if (calm) { el.textContent = roles[0]; return; }

    let i = 0, j = 0, deleting = false;

    (function step() {
      const word = roles[i];
      el.textContent = word.slice(0, j);

      let wait = deleting ? 26 : 52;
      if (!deleting && j === word.length) { deleting = true; wait = 1900; }
      else if (deleting && j === 0) { deleting = false; i = (i + 1) % roles.length; wait = 320; }
      else { j += deleting ? -1 : 1; }

      setTimeout(step, wait);
    })();
  })();

  /* ─────────────────────────────────────────────────────────────
     5. NAV — sticky, mobile toggle, scrollspy
     ───────────────────────────────────────────────────────────── */
  (function nav() {
    const bar    = $('#nav');
    const links  = $('#navLinks');
    const toggle = $('#navToggle');
    const items  = $$('[data-nav]');
    const secs   = items.map(a => $(a.getAttribute('href'))).filter(Boolean);

    toggle && toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    items.forEach(a => a.addEventListener('click', () => {
      links.classList.remove('open');
      toggle && toggle.setAttribute('aria-expanded', 'false');
    }));

    const progress = $('#scrollBar');
    const toTop    = $('#toTop');

    function onScroll() {
      const y = window.scrollY;
      bar.classList.toggle('stuck', y > 24);
      toTop && toTop.classList.toggle('show', y > 700);

      if (progress) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? (y / max) * 100 : 0) + '%';
      }

      const probe = y + window.innerHeight * 0.32;
      let current = -1;
      secs.forEach((s, idx) => { if (s.offsetTop <= probe) current = idx; });
      items.forEach((a, idx) => a.classList.toggle('active', idx === current));
    }

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { onScroll(); ticking = false; });
    }, { passive: true });
    onScroll();

    toTop && toTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     6. REVEALS · COUNTERS · SKILL BARS
     ───────────────────────────────────────────────────────────── */
  (function reveals() {
    const targets = $$('[data-reveal]');

    if (still || !('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('in'));
      $$('.bars b').forEach(b => { b.style.setProperty('--w', b.dataset.bar + '%'); b.classList.add('on'); });
      $$('.stat__num').forEach(n => { n.textContent = n.dataset.count + (n.dataset.suffix || ''); });
      return;
    }

    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        obs.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px' });

    /* stagger siblings inside a grid */
    targets.forEach(el => {
      const sibs = Array.from(el.parentElement ? el.parentElement.children : []);
      const idx = sibs.indexOf(el);
      el.style.transitionDelay = Math.min(idx, 6) * 70 + 'ms';
      io.observe(el);
    });

    /* skill bars */
    const barIO = new IntersectionObserver((entries, obs) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const b = en.target;
        b.style.setProperty('--w', b.dataset.bar + '%');
        setTimeout(() => b.classList.add('on'), 140);
        obs.unobserve(b);
      });
    }, { threshold: 0.4 });
    $$('.bars b').forEach(b => barIO.observe(b));

    /* counters */
    const countIO = new IntersectionObserver((entries, obs) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const el = en.target;
        const to = parseInt(el.dataset.count, 10);
        const suffix = el.dataset.suffix || '';
        obs.unobserve(el);

        if (calm) { el.textContent = to + suffix; return; }

        const dur = 1500, t0 = performance.now();
        (function tick(now) {
          const p = clamp((now - t0) / dur, 0, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(to * eased) + (p === 1 ? suffix : '');
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
      });
    }, { threshold: 0.5 });
    $$('.stat__num').forEach(n => countIO.observe(n));
  })();

  /* ─────────────────────────────────────────────────────────────
     7. POINTER GLOW + CARD TILT
     ───────────────────────────────────────────────────────────── */
  (function pointer() {
    if (calm || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    document.body.classList.add('has-pointer');
    const glow = $('#cursorGlow');
    let gx = 0, gy = 0, tx = 0, ty = 0;

    window.addEventListener('pointermove', e => { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function follow() {
      gx = lerp(gx, tx, 0.13);
      gy = lerp(gy, ty, 0.13);
      if (glow) glow.style.transform = 'translate(' + gx + 'px,' + gy + 'px)';
      requestAnimationFrame(follow);
    })();

    $$('[data-tilt]').forEach(card => {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        card.style.setProperty('--mx', (px * 100) + '%');
        card.style.setProperty('--my', (py * 100) + '%');
        card.style.transform =
          'perspective(900px) rotateX(' + ((0.5 - py) * 5).toFixed(2) + 'deg) ' +
          'rotateY(' + ((px - 0.5) * 5).toFixed(2) + 'deg) translateY(-5px)';
      });
      card.addEventListener('pointerleave', () => { card.style.transform = ''; });
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     8. HERO NAME GLITCH  (occasional, subtle)
     ───────────────────────────────────────────────────────────── */
  (function glitch() {
    const el = $('.hero__name');
    if (!el || calm) return;

    const targets = $$('span', el);
    const CHARS = '#@%$&*/\\<>[]{}0123456789';

    function fire() {
      const node = targets[Math.floor(Math.random() * targets.length)];
      const real = node.textContent;
      let frames = 0;

      const id = setInterval(() => {
        frames++;
        node.textContent = real.split('').map((ch, i) =>
          (Math.random() < 0.28 && ch !== ' ') ? CHARS[Math.floor(Math.random() * CHARS.length)] : real[i]
        ).join('');
        if (frames > 6) { clearInterval(id); node.textContent = real; }
      }, 48);

      setTimeout(fire, 4200 + Math.random() * 6500);
    }
    setTimeout(fire, 4200);
  })();

  /* ─────────────────────────────────────────────────────────────
     9. MISC
     ───────────────────────────────────────────────────────────── */
  const yr = $('#year');
  if (yr) yr.textContent = '© ' + new Date().getFullYear();

  /* console easter egg */
  if (window.console && console.log) {
    console.log(
      '%c GENIESOLOS %c Gene Garland — Systems Engineer · CISSP \n' +
      ' Looking under the hood? Good instinct. \n' +
      ' geniesolostech@gmail.com',
      'background:#7C3AED;color:#FAF5EC;font-weight:700;padding:4px 8px;border-radius:4px 0 0 4px',
      'background:#292437;color:#2ED47F;padding:4px 8px;border-radius:0 4px 4px 0'
    );
  }
})();
