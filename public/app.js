/* bip.ad client: countdowns, 3:12 <-> BIP morph, board tabs, live board polling with FLIP reorder,
   impression beacons, copy buttons, mobile menu and the ribbon background.
   Progressive enhancement only: every page works without this file. No innerHTML anywhere. */
(() => {
  'use strict';
  const DAY = 86400e3;
  const ICT = 7 * 3600e3;
  const TOP = 10;
  const POLL_MS = 30e3;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const pad = (n) => String(n).padStart(2, '0');
  const money = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clockICT = (now) => { const t = new Date(now + ICT); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; };

  /* ------------------------------------------------------------ countdowns
     Each [data-countdown] holds the ISO time of the next 03:12 ICT lock. ICT has no daylight saving,
     so once a lock passes the next one is exactly 24 hours later. */
  const targetOf = (el, now) => {
    let t = Date.parse(el.dataset.countdown || '');
    if (!Number.isFinite(t)) return NaN;
    while (t <= now) t += DAY;
    return t;
  };
  const tick = () => {
    const now = Date.now();
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const target = targetOf(el, now);
      if (!Number.isFinite(target)) return;
      const s = Math.max(0, Math.floor((target - now) / 1000));
      el.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    });
  };
  tick();
  setInterval(tick, 1000);

  /* ------------------------------------------------------------ 3:12 <-> BIP morph
     Loops while visible, holds BIP on mouse hover, toggle button for explicit control. */
  document.querySelectorAll('[data-morph]').forEach((m) => {
    const btn = m.querySelector('[data-morph-toggle]');
    let timer = 0, visible = true, hover = false;
    const set = (on) => { m.classList.toggle('is-bip', on); if (btn) btn.setAttribute('aria-pressed', String(on)); };
    const loop = () => {
      clearTimeout(timer);
      if (reduce.matches || !visible || hover || document.hidden) return;
      timer = setTimeout(() => { set(!m.classList.contains('is-bip')); loop(); }, m.classList.contains('is-bip') ? 3400 : 2400);
    };
    if (btn) btn.addEventListener('click', () => { set(!m.classList.contains('is-bip')); loop(); });
    const stage = m.querySelector('[data-morph-stage]') || m;
    stage.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'mouse') return; hover = true; clearTimeout(timer); set(true); });
    stage.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') return; hover = false; loop(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; loop(); }).observe(m);
    document.addEventListener('visibilitychange', loop);
    reduce.addEventListener('change', loop);
    loop();
  });

  /* ------------------------------------------------------------ segment digits (mirrors src/views/components.ts) */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SEG = { S: 8, T: 2.6, GAP: 1.4, SPACING: 3.4 };
  const GEO = [['a', SEG.S / 2, 0, false], ['b', SEG.S, SEG.S / 2, true], ['c', SEG.S, 1.5 * SEG.S, true], ['d', SEG.S / 2, 2 * SEG.S, false], ['e', 0, 1.5 * SEG.S, true], ['f', 0, SEG.S / 2, true], ['g', SEG.S / 2, SEG.S, false]];
  const r3 = (n) => String(Math.round(n * 1000) / 1000);
  const segDigits = (text) => {
    const L = SEG.S - SEG.GAP;
    const svg = document.createElementNS(SVG_NS, 'svg');
    const width = text.length * SEG.S + (text.length - 1) * SEG.SPACING + SEG.T;
    const height = 2 * SEG.S + SEG.T;
    svg.setAttribute('class', 'rank-seg');
    svg.setAttribute('viewBox', `${r3(-SEG.T / 2)} ${r3(-SEG.T / 2)} ${r3(width)} ${r3(height)}`);
    svg.setAttribute('width', r3(width));
    svg.setAttribute('height', r3(height));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    [...text].forEach((ch, i) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'sd');
      g.setAttribute('data-d', ch);
      g.setAttribute('transform', `translate(${r3(i * (SEG.S + SEG.SPACING))} 0)`);
      GEO.forEach(([name, cx, cy, vert]) => {
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('class', `s-${name}`);
        r.setAttribute('x', r3(-L / 2)); r.setAttribute('y', r3(-SEG.T / 2));
        r.setAttribute('width', r3(L)); r.setAttribute('height', r3(SEG.T)); r.setAttribute('rx', r3(SEG.T / 2));
        r.setAttribute('transform', `translate(${r3(cx)} ${r3(cy)})${vert ? ' rotate(90)' : ''}`);
        g.append(r);
      });
      svg.append(g);
    });
    return svg;
  };

  /* ------------------------------------------------------------ live boards */
  const ticker = document.querySelector('[data-ticker]');
  const say = (...nodes) => { if (ticker) ticker.replaceChildren(...nodes); };
  const el = (tag, text, attrs) => { const n = document.createElement(tag); if (text) n.textContent = text; if (attrs) Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };

  const tierOf = (rank, paid, main) => (!main ? 'free' : rank === 1 ? 'lead' : rank <= 3 ? 'podium' : rank <= TOP ? 'top' : paid ? 'standby' : 'free');

  const setRank = (li, rank) => {
    const text = String(rank).padStart(2, '0');
    const badge = li.querySelector('.rank');
    const old = badge && badge.querySelector('.rank-seg');
    if (old) {
      const cells = old.querySelectorAll('.sd');
      if (cells.length === text.length) cells.forEach((c, i) => c.setAttribute('data-d', text[i]));
      else old.replaceWith(segDigits(text));
    }
    const label = li.querySelector('[data-rank-text]');
    if (label) label.textContent = `Rank ${rank}`;
    li.dataset.rank = String(rank);
  };

  const validRow = (r) => r && typeof r.productId === 'string' && Number.isFinite(r.rank) && Number.isFinite(r.activeRankUnits);

  const boards = new Map();
  document.querySelectorAll('[data-poll]').forEach((panel) => {
    const main = panel.querySelector('.list-main');
    const free = panel.querySelector('.list-free');
    boards.set(panel, { key: panel.dataset.poll, panel, main, free, freeSec: panel.querySelector('[data-free-sec]'), cutoff: panel.querySelector('[data-cutoff]'), last: 0, busy: false, stale: false });
  });

  const applyRows = (b, rows) => {
    if (!b.main || !b.free) { if (rows.length) markStale(b); return; }
    const items = new Map([...b.panel.querySelectorAll('.item[data-product-id]')].map((li) => [li.dataset.productId, li]));
    const seen = new Set();
    let changed = 0;
    rows.forEach((r) => {
      const li = items.get(r.productId);
      if (!li) { markStale(b); return; }
      seen.add(r.productId);
      const bid = Math.max(0, Math.trunc(r.activeRankUnits));
      if (Number(li.dataset.bid) !== bid || Number(li.dataset.rank) !== r.rank) changed += 1;
      li.dataset.bid = String(bid);
      li._rank = r.rank;
      const amt = li.querySelector('[data-amt]');
      if (amt) amt.textContent = bid > 0 ? money(bid) : 'Free';
      const label = li.querySelector('[data-bid-label]');
      if (label) label.textContent = bid > 0 ? 'Active bid' : 'Listing';
    });
    // Products that left the board (bids expired out of the list, unpublished) are removed.
    items.forEach((li, id) => { if (!seen.has(id)) { li.remove(); items.delete(id); changed += 1; } });
    if (!changed) return 0;

    const ordered = [...items.values()].sort((x, y) => x._rank - y._rank);
    const moving = [...ordered, b.cutoff].filter(Boolean);
    const animate = !reduce.matches && !b.panel.hidden;
    const first = animate ? new Map(moving.map((n) => [n, n.getBoundingClientRect()])) : null;

    let mainCount = 0, cutoffPlaced = false, freeStart = 0;
    ordered.forEach((li) => {
      const rank = li._rank, paid = Number(li.dataset.bid) > 0, inMain = rank <= TOP || paid;
      if (inMain) { b.main.append(li); mainCount += 1; } else { if (!freeStart) freeStart = rank; b.free.append(li); }
      setRank(li, rank);
      li.dataset.tier = tierOf(rank, paid, inMain);
      if (inMain && rank === TOP && b.cutoff) { b.main.append(b.cutoff); cutoffPlaced = true; }
    });
    if (b.cutoff && !cutoffPlaced) {
      b.main.append(b.cutoff);
      const p = b.cutoff.querySelector('p');
      const left = Math.max(0, TOP - mainCount);
      if (p) p.textContent = left > 0 ? `${left === 1 ? 'One seat is' : `${left} seats are`} still open in tonight's Top 10.` : "The ten before this card go into tonight's video.";
    }
    if (b.freeSec) b.freeSec.hidden = b.free.children.length === 0;
    if (freeStart) b.free.setAttribute('start', String(freeStart));

    const mainItems = [...b.main.querySelectorAll('.item')];
    mainItems.forEach((li, i) => {
      const bid = li.dataset.bid;
      const tie = bid !== '0' && ((mainItems[i - 1] && mainItems[i - 1].dataset.bid === bid) || (mainItems[i + 1] && mainItems[i + 1].dataset.bid === bid));
      li.toggleAttribute('data-tie', Boolean(tie));
    });

    if (first) {
      moving.forEach((n) => {
        const a = first.get(n), z = n.getBoundingClientRect();
        if (!a) return;
        const dx = a.left - z.left, dy = a.top - z.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 760, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      });
    }
    return changed;
  };

  function markStale(b) {
    if (b.stale) return;
    b.stale = true;
    const a = el('a', 'Reload', { href: location.pathname + location.search });
    say('New listings arrived on this board. ', a, ' to see them.');
  }

  const poll = async (b) => {
    if (b.busy || b.panel.hidden || document.hidden) return;
    b.busy = true;
    b.last = Date.now();
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(b.key)}`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !Array.isArray(data.rows)) return;
      const rows = data.rows.filter(validRow);
      if (b.panel.querySelector('[data-empty]')) { if (rows.length) markStale(b); return; }
      const changed = applyRows(b, rows);
      if (changed && !b.stale) say(el('time', clockICT(Date.now()) + ' ICT'), ' ', el('b', 'Board updated.'), ' Ranks move the moment a payment is confirmed.');
    } catch {
      /* Network errors are ignored; the next poll retries. */
    } finally {
      b.busy = false;
    }
  };
  if (boards.size && 'fetch' in window) {
    setInterval(() => boards.forEach((b) => { if (Date.now() - b.last >= POLL_MS - 500) poll(b); }), POLL_MS);
    boards.forEach((b) => { b.last = Date.now(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) boards.forEach((b) => { if (Date.now() - b.last >= POLL_MS) poll(b); });
    });
  }

  /* ------------------------------------------------------------ tabs (homepage)
     Server renders plain links to /daily, /weekly, /monthly plus all three panels; this upgrades them. */
  const tabsNav = document.querySelector('[data-tabs]');
  if (tabsNav) {
    const tabs = [...tabsNav.querySelectorAll('.tab[data-panel]')];
    const panels = tabs.map((t) => document.getElementById(t.dataset.panel));
    if (tabs.length && panels.every(Boolean)) {
      const lockClock = document.querySelector('.board-sec .lock [data-countdown]');
      tabsNav.setAttribute('role', 'tablist');
      tabs.forEach((t, i) => {
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-controls', t.dataset.panel);
        panels[i].setAttribute('role', 'tabpanel');
        panels[i].setAttribute('aria-labelledby', t.id);
      });
      const select = (tab, focus) => {
        tabs.forEach((t, i) => {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.removeAttribute('aria-current');
          t.tabIndex = on ? 0 : -1;
          panels[i].hidden = !on;
        });
        if (focus) tab.focus();
        const panel = panels[tabs.indexOf(tab)];
        if (lockClock && panel.dataset.nextCutoff) { lockClock.dataset.countdown = panel.dataset.nextCutoff; lockClock.setAttribute('datetime', panel.dataset.nextCutoff); tick(); }
        const b = boards.get(panel);
        if (b && Date.now() - b.last >= POLL_MS) poll(b);
      };
      const initial = tabs.find((t, i) => !panels[i].hidden) || tabs[0];
      select(initial, false);
      tabs.forEach((t) => t.addEventListener('click', (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let "open in new tab" work
        e.preventDefault();
        select(t, false);
      }));
      tabsNav.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const map = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
        if (!(e.key in map)) return;
        e.preventDefault();
        select(tabs[map[e.key]], true);
      });
    }
  }

  /* ------------------------------------------------------------ impression beacons
     A product card counts once per page load after it is at least 50% visible for one second. */
  if ('IntersectionObserver' in window && navigator.sendBeacon) {
    const timers = new Map();
    const sent = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const card = entry.target;
        const id = card.dataset.productId;
        if (!id || sent.has(id)) { io.unobserve(card); return; }
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (timers.has(card)) return;
          timers.set(card, setTimeout(() => {
            timers.delete(card);
            if (document.hidden || sent.has(id)) return;
            sent.add(id);
            io.unobserve(card);
            try { navigator.sendBeacon('/api/events', JSON.stringify({ type: 'product_card_impression', productId: id })); } catch { /* best effort */ }
          }, 1000));
        } else if (timers.has(card)) {
          clearTimeout(timers.get(card));
          timers.delete(card);
        }
      });
    }, { threshold: [0, 0.5, 1] });
    document.querySelectorAll('.item[data-product-id]').forEach((card) => io.observe(card));
    document.addEventListener('visibilitychange', () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (document.hidden) return;
      // Re-observing delivers a fresh intersection entry, so cards already on screen start a new 1s timer.
      document.querySelectorAll('.item[data-product-id]').forEach((card) => { if (!sent.has(card.dataset.productId)) { io.unobserve(card); io.observe(card); } });
    });
  }

  /* ------------------------------------------------------------ copy buttons */
  document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const target = document.querySelector(btn.dataset.copy);
    if (!target) return;
    const status = btn.parentElement && btn.parentElement.querySelector('[data-copy-status]');
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      btn.textContent = 'Copied';
      if (status) status.textContent = 'Copied to clipboard';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      btn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { btn.textContent = label; if (status) status.textContent = ''; }, 2000);
  }));

  /* ------------------------------------------------------------ mobile menu */
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { if (menu.hidePopover) { try { menu.hidePopover(); } catch { /* not open */ } } }));

  /* ------------------------------------------------------------ ribbon background
     Twisted gradient bands drift like the logo; the pointer pushes them aside, a click plucks a wave.
     Static under prefers-reduced-motion, paused while the tab is hidden. */
  (() => {
    const cv = document.querySelector('[data-bg]');
    const ctx = cv && cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    const root = document.documentElement;
    const N = 64;
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    if (!octx) return;
    const STOPS = [[0, 170, 251], [47, 98, 255], [138, 18, 252]];
    const SHADES = [0, 0.14, 0.28, 0.44, 0.6];
    let W = 0, H = 0, ribbons = [], raf = 0, t = 0, grads = [];
    const ptr = { x: 0, y: 0, lx: 0, ly: 0, vx: 0, vy: 0, on: false };
    const build = () => {
      const count = W < 700 ? 4 : 6;
      ribbons = Array.from({ length: count }, (_, i) => ({
        base: H * (0.1 + (i / (count - 1)) * 0.8),
        amp: 24 + Math.random() * 46,
        k: ((1 + Math.random() * 1.1) * Math.PI * 2) / W,
        speed: 0.25 + Math.random() * 0.35,
        ph: Math.random() * Math.PI * 2,
        tk: ((0.5 + Math.random() * 0.8) * Math.PI * 2) / W,
        tph: Math.random() * Math.PI * 2,
        half: (W < 700 ? 16 : 26) + Math.random() * 20,
        alpha: 0.16 + Math.random() * 0.1,
        oy: new Float32Array(N),
        vy: new Float32Array(N),
      }));
    };
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth; H = innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      off.width = cv.width; off.height = cv.height;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grads = SHADES.map((m) => {
        const g = octx.createLinearGradient(0, 0, W, 0);
        STOPS.forEach((c, i) => g.addColorStop([0, 0.45, 1][i], `rgb(${c.map((v) => Math.round(v + (255 - v) * m)).join(',')})`));
        return g;
      });
      build();
    };
    const xs = (j) => -60 + (j * (W + 120)) / (N - 1);
    const step = () => {
      const R = Math.max(120, Math.min(200, W * 0.13)), R2 = R * R;
      ptr.vx = ptr.vx * 0.8 + (ptr.x - ptr.lx) * 0.2; ptr.vy = ptr.vy * 0.8 + (ptr.y - ptr.ly) * 0.2;
      ptr.lx = ptr.x; ptr.ly = ptr.y;
      for (const r of ribbons) {
        for (let j = 0; j < N; j++) {
          const x = xs(j), y = r.base + r.amp * Math.sin(x * r.k + t * r.speed + r.ph) + r.oy[j];
          const lap = (j > 0 ? r.oy[j - 1] : 0) + (j < N - 1 ? r.oy[j + 1] : 0) - 2 * r.oy[j];
          let acc = lap * 0.14 - r.oy[j] * 0.016;
          if (ptr.on) {
            const dx = x - ptr.x, dy = y - ptr.y, d2 = dx * dx + dy * dy;
            if (d2 < R2) { const f = 1 - Math.sqrt(d2) / R; acc += (dy >= 0 ? 1 : -1) * f * f * 2.4 + ptr.vy * f * 0.06; }
          }
          r.vy[j] = (r.vy[j] + acc) * 0.93;
        }
        for (let j = 0; j < N; j++) r.oy[j] = Math.max(-180, Math.min(180, r.oy[j] + r.vy[j]));
      }
    };
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const r of ribbons) {
        octx.clearRect(0, 0, W, H);
        let px = 0, py = 0, ph = 0;
        for (let j = 0; j < N; j++) {
          const x = xs(j);
          const y = r.base + r.amp * Math.sin(x * r.k + t * r.speed + r.ph) + r.oy[j];
          const c = Math.cos(x * r.tk + t * 0.35 + r.tph);
          const h = r.half * c;
          if (j > 0) {
            const a = Math.abs(c);
            // Front face is bright where it faces the viewer; the back face is paler, like the inside of the logo ribbon.
            const shade = (ph + h) >= 0 ? (a > 0.66 ? 0 : a > 0.33 ? 1 : 2) : (a > 0.5 ? 3 : 4);
            octx.fillStyle = grads[shade];
            octx.beginPath();
            octx.moveTo(px - 0.5, py - ph); octx.lineTo(x + 0.5, y - h); octx.lineTo(x + 0.5, y + h); octx.lineTo(px - 0.5, py + ph);
            octx.closePath(); octx.fill();
          }
          px = x; py = y; ph = h;
        }
        // Opaque shading offscreen, one translucent composite per ribbon: no seams between slices.
        ctx.globalAlpha = r.alpha;
        ctx.drawImage(off, 0, 0, W, H);
      }
      ctx.globalAlpha = 1;
    };
    const frame = () => { t += 1 / 60; step(); draw(); raf = requestAnimationFrame(frame); };
    const run = () => {
      cancelAnimationFrame(raf);
      if (reduce.matches) { draw(); return; }
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    let rz = 0;
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { resize(); run(); }, 150); });
    addEventListener('pointermove', (e) => {
      if (!ptr.on) { ptr.lx = ptr.x = e.clientX; ptr.ly = ptr.y = e.clientY; }
      ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true;
      if (!reduce.matches) { root.style.setProperty('--mx', `${e.clientX}px`); root.style.setProperty('--my', `${e.clientY}px`); }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { ptr.on = false; });
    addEventListener('blur', () => { ptr.on = false; });
    addEventListener('pointerdown', (e) => {
      if (reduce.matches) return;
      for (const r of ribbons) {
        for (let j = 0; j < N; j++) {
          const x = xs(j), dx = Math.abs(x - e.clientX);
          const y = r.base + r.amp * Math.sin(x * r.k + t * r.speed + r.ph) + r.oy[j];
          if (dx < 160 && Math.abs(y - e.clientY) < 260) r.vy[j] += (y >= e.clientY ? 1 : -1) * 16 * (1 - dx / 160);
        }
      }
    }, { passive: true });
    document.addEventListener('visibilitychange', run);
    reduce.addEventListener('change', run);
    resize();
    run();
  })();
})();
