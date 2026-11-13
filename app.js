// Hot Streak UI: renders engine snapshots, plays events as animations, handles input.
(function () {
  'use strict';
  const { Game, breakdown } = HotStreak;
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NUM_COLORS = ['#7c8798', '#e63946', '#f77f00', '#e0a400', '#5fae3e', '#12a36b', '#0fa3b1', '#2f80ed', '#5b4fe0', '#9b51e0', '#d63ab8', '#e8456b', '#8d5b2f'];
  const P_COLORS = ['#f0602b', '#1b8fd6', '#e0367a', '#2fa84f', '#8b5cf6', '#d99a00', '#0f9e8e', '#c2410c', '#3b5bdb', '#d6409f'];
  const pc = (i) => P_COLORS[i % P_COLORS.length];
  const SEAT_MAX = 3; // up to this many players, show everyone's cards at once

  const SAVE = 'hotstreak.save.v1';
  const PREFS = 'hotstreak.prefs.v1';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const prefs = Object.assign({ names: [], count: 2, target: 200 }, store.get(PREFS) || {});

  let game = null;
  let busy = false;
  let focusP = 0;
  let lastTurnP = null;
  let shownPts = { p: -1, v: 0 };
  let dealing = false;
  let undo = null; // { snap, timer, pending } after a CLOSE, until the next action

  // ---------------- card art ----------------
  const arm = (k) => `<g transform="rotate(${k * 60} 32 32)"><path d="M32 32V5M24.5 11.5L32 18l7.5-6.5M27 21l5 4 5-4"/></g>`;
  const ICONS = {
    freeze: `<svg viewBox="0 0 64 64" fill="none" stroke="#053a63" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">${[0, 1, 2, 3, 4, 5].map(arm).join('')}<circle cx="32" cy="32" r="4" fill="#fff"/></svg>`,
    flip3: `<svg viewBox="0 0 64 64"><g stroke="#6b4a00" stroke-width="2.5"><rect x="6" y="15" width="25" height="35" rx="5" transform="rotate(-16 18 32)" fill="#fff3b0"/><rect x="19.5" y="12" width="25" height="35" rx="5" fill="#fff9dc"/><rect x="33" y="15" width="25" height="35" rx="5" transform="rotate(16 46 32)" fill="#fff"/></g><text x="46" y="41" transform="rotate(16 46 32)" text-anchor="middle" font-size="22" font-weight="900" fill="#b07d00" font-family="ui-rounded, system-ui, sans-serif">3</text></svg>`,
    second: `<svg viewBox="0 0 64 64"><path d="M32 57C10 41 4 31 4 21 4 12 11 6 19 6c6 0 10 3 13 8 3-5 7-8 13-8 8 0 15 6 15 15 0 10-6 20-28 36z" fill="#fff" stroke="#a8221b" stroke-width="3.5"/><path d="M32 21v18M23 30h18" stroke="#c62a22" stroke-width="6.5" stroke-linecap="round"/></svg>`,
  };
  const ACTION_NAME = { freeze: 'Freeze', flip3: 'Flip Three', second: 'Second Chance' };

  function cardHTML(c, cls = '') {
    switch (c.kind) {
      case 'num':
        return `<div class="card num ${cls}" style="--c:${NUM_COLORS[c.value]}"><span class="corner tl">${c.value}</span><span class="big">${c.value}</span><span class="corner br">${c.value}</span></div>`;
      case 'mod':
        return `<div class="card mod ${cls}"><span class="big">+${c.value}</span><span class="lbl">BONUS</span></div>`;
      case 'x2':
        return `<div class="card x2 ${cls}"><span class="big">×2</span><span class="lbl">DOUBLE</span></div>`;
      case 'freeze':
        return `<div class="card freeze ${cls}"><div class="ic">${ICONS.freeze}</div><span class="lbl">FREEZE</span></div>`;
      case 'flip3':
        return `<div class="card flip3 ${cls}"><div class="ic">${ICONS.flip3}</div><span class="lbl">FLIP THREE</span></div>`;
      case 'second':
        return `<div class="card second ${cls}"><div class="ic">${ICONS.second}</div><span class="lbl">2ND CHANCE</span></div>`;
    }
    return '';
  }
  const cardName = (c) => (c.kind === 'num' ? String(c.value) : c.kind === 'mod' ? `+${c.value}` : c.kind === 'x2' ? '×2' : ACTION_NAME[c.kind]);

  // ---------------- effects ----------------
  const fx = (() => {
    const cv = $('#fx'); const cx = cv.getContext('2d');
    let parts = []; let running = false;
    function size() { const d = window.devicePixelRatio || 1; cv.width = innerWidth * d; cv.height = innerHeight * d; cx.setTransform(d, 0, 0, d, 0, 0); }
    addEventListener('resize', size); size();
    function loop() {
      cx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter((p) => p.life > 0);
      for (const p of parts) {
        p.vy += 0.32; p.vx *= 0.99; p.vy *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= 1;
        cx.save(); cx.globalAlpha = Math.min(1, p.life / 30); cx.translate(p.x, p.y); cx.rotate(p.r);
        cx.fillStyle = p.c;
        if (p.round) { cx.beginPath(); cx.arc(0, 0, p.s / 2, 0, 7); cx.fill(); } else cx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        cx.restore();
      }
      if (parts.length) requestAnimationFrame(loop); else { running = false; cx.clearRect(0, 0, innerWidth, innerHeight); }
    }
    function burst(n = 160, y = 0.4) {
      const cols = ['#ffd23f', '#ff6b1a', '#ff3d81', '#3ddcff', '#a3e635', '#c084fc', '#fff'];
      for (let i = 0; i < n; i++) {
        parts.push({ x: innerWidth / 2 + (Math.random() - 0.5) * 60, y: innerHeight * y, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5, s: 6 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length], life: 110 + Math.random() * 60, round: Math.random() < 0.3 });
      }
      if (!running) { running = true; requestAnimationFrame(loop); }
    }
    return { burst };
  })();

  // ---------------- heat ----------------
  const numsOf = (p) => p.cards.filter((c) => c.kind === 'num').length;
  function setHeat(n, live) {
    $('#heat').style.opacity = live && n >= 3 ? (Math.min(1, (n - 2) / 5) * 0.9).toFixed(2) : 0;
  }
  // Pulse the warm glow while the player on turn holds 5-6 numbers.
  const heart = (() => {
    let rate = 0;
    function stop() { rate = 0; $('#heat').classList.remove('beat'); }
    function set(ms) {
      if (ms === rate) return;
      stop();
      if (!ms) return;
      rate = ms;
      $('#heat').style.setProperty('--beat', ms + 'ms');
      $('#heat').classList.add('beat');
    }
    return { set, stop };
  })();

  // ---------------- achievements, moments ----------------
  const ACH = {
    seven: ['🔥', 'Seven Heaven', 'Hit a 7 Streak'],
    greedy: ['🤑', 'Greedy', 'Busted holding 6 numbers'],
    nerves: ['😎', 'Nerves of Steel', 'Closed holding 6 numbers'],
    ice: ['🥶', 'Ice Cold', 'Froze a rival sitting on 40+'],
    saved: ['😅', 'Saved by the Bell', 'A Second Chance saved you'],
    survivor: ['💪', 'Survivor', 'Made it through a Flip Three'],
    bigbank: ['💰', 'Big Bank', 'Scored 60+ in one round'],
    zero: ['🎯', 'Zero Hero', 'Won a round holding the 0'],
    comeback: ['🚀', 'Comeback Kid', 'Won after trailing by 50+'],
  };
  // App-side extras saved with the game: achievements, round moments, biggest deficits.
  function X() {
    if (!game.s.x) game.s.x = { ach: {}, moments: [], maxDef: [] };
    return game.s.x;
  }
  const badgeQ = [];
  let badgeBusy = false;
  function award(i, id) {
    const x = X();
    const list = x.ach[i] || (x.ach[i] = []);
    if (list.includes(id)) return;
    list.push(id);
    badgeQ.push([game.s.players[i].name, id]);
    runBadges();
  }
  async function runBadges() {
    if (badgeBusy) return;
    badgeBusy = true;
    while (badgeQ.length) {
      const [name, id] = badgeQ.shift();
      const [e, t, d] = ACH[id];
      const el = $('#badge');
      el.innerHTML = `<span class="be">${e}</span><div><small>${esc(name)} unlocked</small><b>${t}</b><span class="d">${d}</span></div>`;
      el.classList.add('show');
      await sleep(2400);
      el.classList.remove('show');
      await sleep(450);
    }
    badgeBusy = false;
  }
  const moment = (w, html) => X().moments.push({ w, html });
  const rawPts = (p) => breakdown(Object.assign({}, p, { status: 'active' })).score;

  // Badges and round highlights for each event (runs alongside the animations).
  function react(ev) {
    const s = ev.snap, P = s.players;
    const nm = (i) => `<b>${esc(P[i].name)}</b>`;
    switch (ev.type) {
      case 'roundStart':
        X().moments = [];
        break;
      case 'bust': {
        const pts = rawPts(P[ev.p]);
        if (numsOf(P[ev.p]) === 6) award(ev.p, 'greedy');
        moment(pts, `💥 ${nm(ev.p)} busted holding ${pts} points`);
        break;
      }
      case 'saved':
        award(ev.p, 'saved');
        moment(25 + breakdown(P[ev.p]).score, `😅 A Second Chance saved ${nm(ev.p)}`);
        break;
      case 'seven':
        award(ev.p, 'seven');
        moment(999, `🔥 ${nm(ev.p)} hit a 7 Streak`);
        break;
      case 'freeze': {
        const pts = breakdown(P[ev.t]).score;
        if (ev.t !== ev.p) {
          if (pts >= 40) award(ev.p, 'ice');
          moment(pts * 1.1, `🥶 ${nm(ev.p)} froze ${nm(ev.t)} at ${pts}`);
        }
        break;
      }
      case 'flip3Done':
        if (P[ev.p].status === 'active') award(ev.p, 'survivor');
        break;
      case 'stay':
        if (!ev.forced && numsOf(P[ev.p]) === 6) {
          award(ev.p, 'nerves');
          moment(45, `😎 ${nm(ev.p)} walked away holding 6 numbers`);
        }
        break;
      case 'roundEnd': {
        const x = X(), rows = ev.summary.rows;
        const best = rows.slice().sort((a, b) => b.score - a.score)[0];
        if (best.score > 0) {
          moment(best.score * 0.9, `💰 ${nm(best.i)} banked ${best.score}`);
          if (rows.filter((r) => r.score === best.score).length === 1 && best.nums.includes(0)) award(best.i, 'zero');
        }
        rows.forEach((r) => { if (r.score >= 60) award(r.i, 'bigbank'); });
        const lead = Math.max(...rows.map((r) => r.after));
        rows.forEach((r) => { x.maxDef[r.i] = Math.max(x.maxDef[r.i] || 0, lead - r.after); });
        if (s.phase === 'over' && (x.maxDef[s.winner] || 0) >= 50) award(s.winner, 'comeback');
        break;
      }
    }
  }

  // Where a player's cards live on screen: their row in table view, else their score chip.
  const playerEl = (i) => $(`#table.seatmode #seats .seat[data-i="${i}"] .seat-cards`) || $(`#rail .chip[data-i="${i}"]`);

  // Deal animation: the revealed card shrinks into that player's spot.
  function flyToChip(card, i) {
    const from = $('#reveal .flipper');
    const chip = playerEl(i);
    if (!from || !chip) { hideReveal(true); return; }
    const a = from.getBoundingClientRect(), b = chip.getBoundingClientRect();
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHTML(card);
    const el = wrap.firstChild;
    el.classList.add('flycard');
    Object.assign(el.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px' });
    document.body.appendChild(el);
    hideReveal(false);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const anim = el.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(.2) rotate(-25deg)`, opacity: 0.85 }], { duration: 420, easing: 'cubic-bezier(.55, 0, .75, .2)' });
    anim.onfinish = () => {
      el.remove();
      const c = playerEl(i);
      if (c) c.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 260 });
    };
  }

  function flash(kind) {
    const t = $('#table');
    t.classList.remove('flashred', 'flashice', 'flashgold'); void t.offsetWidth;
    t.classList.add('flash' + kind);
    setTimeout(() => t.classList.remove('flash' + kind), 650);
  }
  function shake() { const t = $('#table'); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake'); setTimeout(() => t.classList.remove('shake'), 500); }
  function stamp(text, kind, sub) {
    const el = $('#stamp');
    el.className = ''; void el.offsetWidth;
    el.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
    el.className = 'show ' + kind;
  }
  let toastTimer = null;
  function toast(msg, ms = 1800) {
    const el = $('#toast');
    el.innerHTML = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function banner(title, sub, color) {
    const el = $('#banner');
    el.style.setProperty('--pc', color);
    el.innerHTML = `<div class="inner"><small>${esc(sub)}</small><b>${esc(title)}</b></div>`;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  let revealToken = 0;
  function showReveal(card) {
    const el = $('#reveal');
    revealToken++;
    el.className = '';
    el.innerHTML = `<div class="flipper">${cardHTML(card)}<div class="card back"></div></div>`;
  }
  function hideReveal(animate) {
    const el = $('#reveal');
    if (!el.innerHTML) return;
    const tok = ++revealToken;
    if (!animate) { el.innerHTML = ''; return; }
    el.classList.add('out');
    setTimeout(() => { if (tok === revealToken) { el.innerHTML = ''; el.className = ''; } }, 300);
  }
  function shakeReveal() { const el = $('#reveal'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

  // ---------------- rendering ----------------
  function statusTag(p) {
    if (p.status === 'busted') return '<span class="tag-s bust">BUST</span>';
    if (p.seven) return '<span class="tag-s closed">7 STREAK</span>';
    if (p.status === 'frozen') return '<span class="tag-s frozen">FROZEN</span>';
    if (p.status === 'stayed') return '<span class="tag-s closed">CLOSED</span>';
    return '';
  }

  function render(s, focus, newId) {
    $('#roundLbl').textContent = `Round ${s.round}`;
    $('#targetLbl').textContent = `to ${s.target}`;
    $('#deckCount').textContent = `${s.deck.length} left`;
    const turnP = s.awaiting && s.awaiting.type === 'decide' ? s.awaiting.p : null;

    // score rail
    $('#rail').innerHTML = s.players.map((p, i) => {
      const b = breakdown(p);
      const cls = ['chip'];
      if (i === turnP) cls.push('turn');
      if (i === focus) cls.push('focus');
      if (p.status !== 'active') cls.push('out', p.status);
      if (p.seven) cls.push('seven');
      const live = s.phase === 'play' && p.status !== 'busted' && (p.cards.length || p.status !== 'active') ? `<span class="plus">+${b.score}</span>` : '';
      return `<button class="chip ${cls.join(' ')}" data-i="${i}" style="--pc:${pc(i)}">${i === s.dealer ? '<span class="dealer">D</span>' : ''}
        <div class="nm">${esc(p.name)}</div><div class="tot">${p.total}</div>
        <div class="rd">${live}${statusTag(p)}${p.second && p.status === 'active' ? '<span class="tag-s sc">♥</span>' : ''}</div>
        <div class="bar"><i style="width:${Math.min(100, (p.total / s.target) * 100)}%"></i></div></button>`;
    }).join('');

    // 2-3 players: everyone's cards on one screen. More: one player at a time.
    const seatMode = s.players.length <= SEAT_MAX;
    $('#table').classList.toggle('seatmode', seatMode);
    if (seatMode) renderSeats(s, focus, turnP, newId);
    else renderFocus(s, focus, turnP, newId);
    const fp = s.players[focus];
    setHeat(numsOf(fp), fp.status === 'active' && s.phase === 'play');

    // controls
    const ctr = $('#controls');
    const canAct = !busy && turnP != null;
    ctr.classList.toggle('locked', !canAct);
    $('#btnFlip').classList.toggle('nudge', canAct);
    $('#closeSub').textContent = turnP != null ? `bank ${breakdown(s.players[turnP]).score}` : 'bank points';
  }

  const bustCardHTML = (p, newId) => cardHTML(p.bust, p.bust.id === newId ? 'new' : '').replace(/<\/div>$/, '<div class="xmark">✕</div></div>');

  function renderSeats(s, focus, turnP, newId) {
    // 2 players: bigger cards, 5 per row, bonus cards fill the spare spots in row 2.
    // 3 players: all 7 number slots in one row, bonus cards in a small row below.
    const two = s.players.length <= 2;
    $('#seats').style.setProperty('--cols', two ? 5 : 7);
    $('#seats').innerHTML = s.players.map((p, i) => {
      const b = breakdown(p);
      const nums = p.cards.filter((c) => c.kind === 'num');
      const cls = ['seat'];
      if (i === turnP) cls.push('turn'); else if (i === focus) cls.push('focus');
      if (p.status !== 'active') cls.push('out', p.status);
      let row = nums.map((c) => cardHTML(c, c.id === newId ? 'new' : '')).join('');
      let used = nums.length;
      if (p.bust) { row += bustCardHTML(p, newId); used++; }
      for (let k = used; k < 7; k++) row += '<div class="slot"></div>';
      const extras = p.cards.filter((c) => c.kind !== 'num');
      if (p.second) extras.push(p.second);
      const extrasHTML = extras.map((c) => cardHTML(c, (c.id === newId ? 'new ' : '') + 'extra')).join('');
      if (two) row += extrasHTML;
      const tag = i === turnP ? '<span class="tag-s turn">YOUR TURN</span>' : statusTag(p);
      return `<div class="${cls.join(' ')}" data-i="${i}" style="--pc:${pc(i)}">
        <div class="seat-head">
          <div class="seat-name"><span class="nm">${esc(p.name)}</span>${i === s.dealer ? '<span class="dealer">D</span>' : ''}${tag}</div>
          <div class="seat-score"><span class="seat-rd">+${b.score} <small>this round</small></span><span class="seat-tot">${p.total}</span></div>
        </div>
        <div class="seat-cards">${row}</div>
        ${extras.length && !two ? `<div class="seat-extras">${extrasHTML}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderFocus(s, focus, turnP, newId) {
    const p = s.players[focus];
    const b = breakdown(p);
    const stage = $('#stage');
    stage.style.setProperty('--pc', pc(focus));
    stage.classList.toggle('isbust', p.status === 'busted');
    stage.classList.toggle('isfrozen', p.status === 'frozen');
    $('#focusName').textContent = p.name;
    let st = { active: 'In play', stayed: 'Closed', frozen: 'Frozen', busted: 'Busted' }[p.status];
    if (p.seven) st = '7 streak!';
    if (focus === turnP) st = 'Your turn';
    $('#focusStatus').textContent = st;
    const ptsEl = $('#ptsNum');
    const v = b.score;
    ptsEl.textContent = v;
    if (shownPts.p === focus && shownPts.v !== v) { ptsEl.classList.remove('pop'); void ptsEl.offsetWidth; ptsEl.classList.add('pop'); }
    shownPts = { p: focus, v };

    const nums = p.cards.filter((c) => c.kind === 'num');
    $('#meter').innerHTML = Array.from({ length: 7 }, (_, k) => `<i class="${k < nums.length ? 'on' : ''}"></i>`).join('');
    $('#meter').classList.toggle('hot', nums.length >= 5 && p.status === 'active');

    let tab = nums.map((c) => cardHTML(c, c.id === newId ? 'new' : '')).join('');
    if (p.bust) tab += bustCardHTML(p, newId);
    if (!tab) tab = `<div class="emptyhint">${p.status === 'active' ? 'No number cards yet' : 'Out with no numbers'}</div>`;
    $('#tableau').innerHTML = tab;
    const extras = p.cards.filter((c) => c.kind !== 'num');
    if (p.second) extras.push(p.second);
    $('#extras').innerHTML = extras.map((c) => cardHTML(c, c.id === newId ? 'new' : '')).join('');
  }

  // ---------------- event playback ----------------
  async function play(ev) {
    const s = ev.snap;
    const name = (i) => esc(s.players[i].name);
    const nm = (i) => `<b style="color:${pc(i)}">${name(i)}</b>`;
    react(ev);
    switch (ev.type) {
      case 'roundStart': {
        hideReveal(false);
        lastTurnP = null;
        focusP = (ev.dealer + 1) % s.players.length;
        render(s, focusP);
        banner(`Round ${ev.round}`, `${s.players[ev.dealer].name} deals`, '#1677c9');
        const deck = $('.deckstack');
        deck.classList.add('shuffling');
        setTimeout(() => deck.classList.remove('shuffling'), 950);
        await sleep(1100);
        break;
      }
      case 'reshuffle':
        toast('Deck ran out, so the discards were shuffled in');
        await sleep(800);
        break;
      case 'turn':
        render(s, ev.p);
        focusP = ev.p;
        if (ev.p !== lastTurnP) {
          banner(s.players[ev.p].name, 'Your turn', pc(ev.p));
          await sleep(500);
        }
        lastTurnP = ev.p;
        break;
      case 'draw':
        focusP = ev.p;
        dealing = ev.deal;
        render(s, ev.p);
        showReveal(ev.card);
        await sleep(ev.deal ? 560 : 680);
        break;
      case 'place':
        if (dealing) flyToChip(ev.card, ev.p); else hideReveal(true);
        render(s, ev.p, ev.card.id);
        if (ev.card.kind === 'second') toast(`${nm(ev.p)} is holding a Second Chance`);
        await sleep(ev.card.kind === 'num' ? 300 : 500);
        break;
      case 'bust':
        shakeReveal(); flash('red'); shake();
        stamp('BUST!', 'bust', `Second ${ev.card.value}`);
        await sleep(550);
        hideReveal(true);
        render(s, ev.p, ev.card.id);
        await sleep(1000);
        break;
      case 'saved':
        stamp('SAVED!', 'saved', 'Second Chance used');
        flash('gold');
        await sleep(700);
        hideReveal(true);
        render(s, ev.p);
        await sleep(700);
        break;
      case 'seven':
        hideReveal(true);
        render(s, ev.p, ev.card.id);
        stamp('7 STREAK!', 'seven', '+15 bonus');
        flash('gold'); fx.burst(200);
        await sleep(2100);
        break;
      case 'setAside':
        toast(`${ACTION_NAME[ev.card.kind]} set aside until the 3 flips finish`);
        await sleep(800);
        hideReveal(true);
        await sleep(250);
        break;
      case 'chooseTarget':
        await sleep(350);
        hideReveal(true);
        await sleep(200);
        break;
      case 'freeze': {
        hideReveal(true);
        focusP = ev.t;
        render(s, ev.t);
        stamp('FROZEN', 'freeze');
        flash('ice');
        const pts = breakdown(s.players[ev.t]).score;
        toast(ev.auto && ev.t === ev.p
          ? `${nm(ev.t)} is the only one left and has to take it. Frozen with ${pts}`
          : ev.t === ev.p ? `${nm(ev.t)} froze themselves and banks ${pts}` : `${nm(ev.p)} froze ${nm(ev.t)}, who banks ${pts}`, 2400);
        await sleep(1500);
        break;
      }
      case 'flip3':
        hideReveal(true);
        focusP = ev.t;
        render(s, ev.t);
        stamp('FLIP 3!', 'flip3');
        toast(ev.auto && ev.t === ev.p
          ? `${nm(ev.t)} is the only one left and must flip 3!`
          : ev.t === ev.p ? `${nm(ev.t)} takes the Flip Three!` : `${nm(ev.p)} makes ${nm(ev.t)} flip 3!`, 2200);
        await sleep(1400);
        break;
      case 'flip3Done':
        await sleep(150);
        break;
      case 'giveSecond':
        hideReveal(true);
        render(s, ev.t, ev.card.id);
        toast(`${nm(ev.p)} already had one, so ${nm(ev.t)} gets the Second Chance`, 2200);
        await sleep(1100);
        break;
      case 'discardAction':
        hideReveal(true);
        toast(`Nobody can take the ${ACTION_NAME[ev.card.kind]}, so it's discarded`);
        await sleep(1000);
        break;
      case 'stay':
        render(s, ev.p);
        toast(ev.forced ? `Out of cards, so ${nm(ev.p)} closes` : `${nm(ev.p)} closes with <b>${breakdown(s.players[ev.p]).score}</b>`);
        await sleep(750);
        break;
      case 'roundEnd':
        hideReveal(false);
        render(s, focusP);
        await sleep(450);
        break;
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    heart.stop();
    $('#controls').classList.add('locked');
    try {
      while (game.events.length) await play(game.events.shift());
    } catch (e) { console.error(e); }
    busy = false;
    dealing = false;
    settle();
  }

  function settle() {
    const s = game.s;
    const a = s.awaiting;
    if (a && a.p != null) focusP = a.p;
    render(s, focusP);
    store.set(SAVE, s);
    if (!a) return;
    if (a.type === 'decide') {
      const n = numsOf(s.players[a.p]);
      heart.set(n >= 6 ? 650 : n === 5 ? 900 : 0);
    } else heart.stop();
    if (a.type === 'target') showTarget(a);
    else if (a.type === 'summary' || a.type === 'over') showSummary();
    if (undo && undo.pending) {
      undo.pending = false;
      if (a.type === 'decide') {
        $('#undo').classList.remove('hidden');
        const bar = $('#undo i');
        bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
        undo.timer = setTimeout(clearUndo, 5000);
      }
    }
  }

  function clearUndo() {
    if (!undo) return;
    clearTimeout(undo.timer);
    undo = null;
    $('#undo').classList.add('hidden');
  }

  function doUndo() {
    if (!undo || busy) return;
    const snap = undo.snap;
    clearUndo();
    closeModal();
    game = Game.load(JSON.parse(snap));
    lastTurnP = game.s.awaiting.p;
    toast('Close undone. Still your turn');
    settle();
  }

  // ---------------- modals ----------------
  function openModal(html, onBind) {
    $('#modal').innerHTML = html;
    $('#modalWrap').classList.remove('hidden');
    $('#modal').scrollTop = 0;
    if (onBind) onBind($('#modal'));
  }
  function closeModal() { $('#modalWrap').classList.add('hidden'); $('#modal').innerHTML = ''; }

  function showTarget(a) {
    const s = game.s;
    const from = s.players[a.p];
    const desc = {
      freeze: 'They bank their points right now and are out for the round.',
      flip3: 'They must flip the next 3 cards, one at a time.',
      second: 'You can only hold one. Pick who gets this one.',
    }[a.action];
    const title = a.action === 'second' ? 'Give away a Second Chance' : `Play ${ACTION_NAME[a.action]}`;
    const opts = a.options.map((i) => {
      const p = s.players[i]; const b = breakdown(p);
      const n = p.cards.filter((c) => c.kind === 'num').length;
      return `<button data-i="${i}" style="--pc:${pc(i)}"><div><div class="pn">${esc(p.name)}${i === a.p ? '<span class="you">YOU</span>' : ''}</div>
        <div class="pm">${n}/7 numbers${p.second ? ' · has 2nd Chance' : ''} · total ${p.total}</div></div><div class="pr">${b.score}</div></button>`;
    }).join('');
    openModal(`<div class="mhead">${cardHTML(a.card)}<div><h2>${title}</h2><p><b style="color:${pc(a.p)}">${esc(from.name)}</b> drew it. ${desc}</p></div></div>
      <div class="pick">${opts}</div>`, (m) => {
      m.querySelectorAll('.pick button').forEach((b) => b.addEventListener('click', () => {
        clearUndo();
        closeModal();
        game.chooseTarget(+b.dataset.i);
        pump();
      }));
    });
  }

  function showSummary() {
    const s = game.s;
    const sum = s.summary;
    const over = s.phase === 'over';
    const rows = sum.rows.slice().sort((x, y) => y.after - x.after);
    const lead = rows[0].after;
    const rowsHTML = rows.map((r) => {
      const p = s.players[r.i];
      let detail;
      if (r.busted) detail = `Busted on a second ${p.bust ? p.bust.value : ''}`;
      else if (!r.nums.length && !r.mods.length) detail = 'No cards';
      else detail = `${r.nums.join(' + ') || '0'}${r.x2 ? ' ×2' : ''}${r.mods.map((m) => ` + ${m}`).join('')}${r.bonus ? ' + 15 streak' : ''}`;
      return `<div class="sumrow ${r.after === lead ? 'lead' : ''}" style="--pc:${pc(r.i)}">
        <div class="sn">${esc(p.name)} <span class="gain ${r.score ? '' : 'zero'}">+${r.score}</span></div>
        <div class="st" data-from="${r.before}" data-to="${r.after}">${r.before}</div>
        <div class="sb">${detail}</div>
        <div class="bar"><i data-w="${Math.min(100, (r.after / s.target) * 100)}"></i></div></div>`;
    }).join('');
    const x = X();
    const nextDealer = s.players[(s.dealer + 1) % s.players.length].name;

    // Lead change since last round
    const uniqueMax = (key) => {
      const m = Math.max(...sum.rows.map((r) => r[key]));
      const at = sum.rows.filter((r) => r[key] === m);
      return at.length === 1 && m > 0 ? at[0].i : -1;
    };
    const before = uniqueMax('before'), after = uniqueMax('after');
    const newLead = sum.round > 1 && after >= 0 && after !== before && !over
      ? `<span class="newlead">👑 New leader: ${esc(s.players[after].name)}</span>` : '';

    const top = (x.moments || []).slice().sort((a, b) => b.w - a.w)[0];
    const momentHTML = top ? `<div class="moment"><small>Moment of the round</small>${top.html}</div>` : '';

    let achHTML = '';
    if (over) {
      const rowsA = s.players.map((p, i) => ({ p, i, list: x.ach[i] || [] })).filter((r) => r.list.length);
      if (rowsA.length) achHTML = `<h3 style="margin:4px 0 8px">Badges earned</h3><div class="achlist">${rowsA.map((r) =>
        `<div class="achrow" style="--pc:${pc(r.i)}"><span class="an">${esc(r.p.name)}</span>${r.list.map((id) => `<span class="achchip">${ACH[id][0]} ${ACH[id][1]}</span>`).join('')}</div>`).join('')}</div>`;
    }

    const head = over
      ? `<div class="winner"><div class="crown">👑</div><h2>${esc(s.players[s.winner].name)} wins!</h2><p>Final score ${s.players[s.winner].total} after ${sum.round} round${sum.round === 1 ? '' : 's'}</p></div>`
      : `<h2>Round ${sum.round} results</h2><p>First to ${s.target} wins. ${newLead}</p>`;
    const undoBtn = undo ? `<button class="btn ghost" id="mUndo">↩ Undo that close</button>` : '';
    const btns = over
      ? `<button class="btn primary big" id="mRematch">Rematch</button>${undoBtn}<button class="btn ghost" id="mNew">New players</button>`
      : `<button class="btn primary big" id="mNext">Next round · ${esc(nextDealer)} deals</button>${undoBtn}`;
    openModal(`${head}${momentHTML}<div class="sumrows">${rowsHTML}</div>${achHTML}<div class="mbtns">${btns}</div>`, (m) => {
      const ub = m.querySelector('#mUndo');
      if (ub) ub.addEventListener('click', doUndo);
      requestAnimationFrame(() => m.querySelectorAll('.bar i').forEach((i) => { i.style.width = i.dataset.w + '%'; }));
      countUp(m.querySelectorAll('.st'));
      if (over) { fx.burst(260, 0.3); setTimeout(() => fx.burst(180, 0.35), 700); }
      const nx = m.querySelector('#mNext');
      if (nx) nx.addEventListener('click', () => { clearUndo(); closeModal(); game.nextRound(); pump(); });
      const rm = m.querySelector('#mRematch');
      if (rm) rm.addEventListener('click', () => { clearUndo(); closeModal(); startGame(s.players.map((p) => p.name), s.target); });
      const nw = m.querySelector('#mNew');
      if (nw) nw.addEventListener('click', () => { clearUndo(); closeModal(); store.del(SAVE); game = null; showSetup(); });
    });
  }

  function countUp(els) {
    const t0 = performance.now();
    const dur = 900;
    function tick(t) {
      const k = Math.min(1, (t - t0 - 200) / dur);
      const e = k <= 0 ? 0 : 1 - Math.pow(1 - k, 3);
      els.forEach((el) => { const a = +el.dataset.from, b = +el.dataset.to; el.textContent = Math.round(a + (b - a) * e); });
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  const RULES_HTML = `<h2>How to play</h2><div class="rules">
    <p>Score the most points by flipping cards without getting a duplicate number. First to the target score (200 by default) at the end of a round wins.</p>
    <h3>Your turn</h3><ul>
      <li><b>FLIP</b>: take the next card. Hold the deck down and let go to flip. Slide your finger off before letting go to back out.</li>
      <li><b>CLOSE</b>: bank your round points. You're out for the rest of the round, and action cards can't touch you anymore. Tapped it by mistake? Hit <b>Undo</b> within 5 seconds.</li></ul>
    <h3>Busting</h3><ul><li>Flip a number you already have and you <b>bust</b>: 0 points this round.</li></ul>
    <h3>7 Streak</h3><ul><li>Collect <b>7 different numbers</b>. The round ends right away for everyone and you get <b>+15</b>.</li></ul>
    <h3>The deck (94 cards)</h3>
    <div class="minis">${cardHTML({ kind: 'num', value: 0 })}${cardHTML({ kind: 'num', value: 7 })}${cardHTML({ kind: 'num', value: 12 })}${cardHTML({ kind: 'mod', value: 4 })}${cardHTML({ kind: 'x2' })}</div>
    <ul><li>Numbers 0–12. There are as many copies as the number (twelve 12s, one 1, plus one 0).</li>
      <li><b>+2 +4 +6 +8 +10</b> bonus cards add to your score.</li>
      <li><b>×2</b> doubles your number cards (not the bonuses).</li>
      <li>Bonus cards don't count toward your 7 numbers.</li></ul>
    <h3>Action cards</h3>
    <div class="minis">${cardHTML({ kind: 'freeze' })}${cardHTML({ kind: 'flip3' })}${cardHTML({ kind: 'second' })}</div>
    <ul><li><b>Freeze</b>: pick an active player (yourself included). They bank their points and are out.</li>
      <li><b>Flip Three</b>: pick an active player. They must flip 3 cards in a row. Actions flipped during it wait until the 3 are done.</li>
      <li><b>Second Chance</b>: keep it. If you flip a duplicate, both cards are discarded and you stay in. You can only hold one, so an extra one goes to another player.</li>
      <li>If you're the <b>only active player</b>, you have to take Freeze or Flip Three yourself.</li></ul>
    <h3>Rounds</h3><ul><li>The dealer gives everyone one card, then players take turns. The round ends when everyone has closed or busted, or someone hits a 7 Streak. The deal moves left each round.</li></ul>
  </div><div class="mbtns" style="margin-top:16px"><button class="btn primary" id="mOk">Got it</button></div>`;

  function showRules() {
    openModal(RULES_HTML, (m) => m.querySelector('#mOk').addEventListener('click', closeModal));
  }

  function showMenu() {
    heart.stop();
    openModal(`<h2>Menu</h2><div class="menu-list">
      <button class="btn ghost" id="mRules">📖  How to play</button>
      <button class="btn ghost" id="mHome">🏠  Main menu (game is saved)</button>
      <button class="btn ghost" id="mEnd" style="color:#ff8a95">✖  End this game</button>
      <button class="btn primary" id="mBack">Back to the table</button></div>`, (m) => {
      m.querySelector('#mRules').onclick = showRules;
      m.querySelector('#mHome').onclick = () => { closeModal(); showSetup(); };
      m.querySelector('#mEnd').onclick = () => {
        openModal(`<h2>End this game?</h2><p>Scores will be lost.</p><div class="mbtns"><button class="btn pink" id="mYes">End game</button><button class="btn ghost" id="mNo">Keep playing</button></div>`, (mm) => {
          mm.querySelector('#mYes').onclick = () => { store.del(SAVE); game = null; closeModal(); showSetup(); };
          mm.querySelector('#mNo').onclick = () => { closeModal(); settle(); };
        });
      };
      m.querySelector('#mBack').onclick = () => { closeModal(); settle(); };
    });
  }

  // ---------------- screens ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
  }

  function showSetup() {
    showScreen('setup');
    heart.stop();
    clearUndo();
    setHeat(0, false);
    const saved = store.get(SAVE);
    $('#btnResume').classList.toggle('hidden', !(saved && saved.phase !== 'over' && saved.players));
    renderNames();
  }

  function renderNames() {
    $('#pCount').textContent = prefs.count;
    const wrap = $('#names');
    wrap.innerHTML = Array.from({ length: prefs.count }, (_, i) =>
      `<div class="nameIn" style="color:${pc(i)}"><span class="sw"></span><input maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Player ${i + 1}" value="${esc(prefs.names[i] || '')}" data-i="${i}"></div>`).join('');
    wrap.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      prefs.names[+inp.dataset.i] = inp.value; store.set(PREFS, prefs);
    }));
    document.querySelectorAll('#targetSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === prefs.target));
  }

  function startGame(names, target, deck) {
    store.del(SAVE);
    clearUndo();
    game = new Game(names, { target, dealer: names.length - 1, deck });
    game.s.x = { ach: {}, moments: [], maxDef: [] };
    showScreen('table');
    keepAwake();
    game.startRound();
    pump();
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (game) {
        keepAwake();
        const a = game.s.awaiting;
        const modalOpen = !$('#modalWrap').classList.contains('hidden');
        if (!busy && !modalOpen && a && a.type === 'decide' && $('#table').classList.contains('active')) {
          const n = numsOf(game.s.players[a.p]);
          heart.set(n >= 6 ? 650 : n === 5 ? 900 : 0);
        }
      }
    } else {
      heart.stop();
    }
  });

  // ---------------- wiring ----------------
  $('#pMinus').onclick = () => { if (prefs.count > 2) { prefs.count--; store.set(PREFS, prefs); renderNames(); } };
  $('#pPlus').onclick = () => { if (prefs.count < 10) { prefs.count++; store.set(PREFS, prefs); renderNames(); } };
  document.querySelectorAll('#targetSeg button').forEach((b) => b.addEventListener('click', () => { prefs.target = +b.dataset.v; store.set(PREFS, prefs); renderNames(); }));
  $('#btnStart').onclick = () => {
    const names = Array.from({ length: prefs.count }, (_, i) => (prefs.names[i] || '').trim() || `Player ${i + 1}`);
    startGame(names, prefs.target);
  };
  $('#btnResume').onclick = () => {
    const saved = store.get(SAVE);
    if (!saved) return;
    game = Game.load(saved);
    lastTurnP = null;
    showScreen('table');
    keepAwake();
    settle();
  };
  $('#btnRules').onclick = showRules;
  $('#btnMenu').onclick = () => { showMenu(); };

  const canAct = () => !busy && game && game.s.awaiting && game.s.awaiting.type === 'decide';
  function doFlip() {
    if (!canAct()) return;
    clearUndo();
    game.hit();
    pump();
  }

  // Hold to flip: press the deck (card lifts and wobbles), let go to reveal. Slide off to back out.
  const flipBtn = $('#btnFlip');
  let hold = null;
  flipBtn.addEventListener('pointerdown', (e) => {
    if (!canAct() || hold) return;
    e.preventDefault();
    try { flipBtn.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    flipBtn.classList.add('charging');
    hold = { t: setTimeout(() => flipBtn.classList.add('charged'), 700) };
  });
  function endHold(fire, e) {
    if (!hold) return;
    clearTimeout(hold.t);
    hold = null;
    flipBtn.classList.remove('charging', 'charged');
    if (!fire) return;
    const r = flipBtn.getBoundingClientRect();
    if (e && (e.clientX < r.left - 24 || e.clientX > r.right + 24 || e.clientY < r.top - 60 || e.clientY > r.bottom + 30)) {
      toast('Chickened out 🐔', 1200);
      return;
    }
    doFlip();
  }
  flipBtn.addEventListener('pointerup', (e) => endHold(true, e));
  flipBtn.addEventListener('pointercancel', () => endHold(false));
  flipBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  flipBtn.addEventListener('click', (e) => { if (e.detail === 0) doFlip(); }); // keyboard / scripted clicks

  $('#btnClose').onclick = () => {
    if (!canAct()) return;
    clearUndo();
    const snap = JSON.stringify(game.s);
    game.stay();
    undo = { snap, timer: null, pending: true };
    pump();
  };
  $('#undo').onclick = doUndo;
  // Tap a score chip to peek at that player's cards.
  $('#rail').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || busy || !game) return;
    render(game.s, +chip.dataset.i);
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Testing hook: open with ?debug to get window.__deal(names, cardsInDrawOrder).
  if (/[?&]debug\b/.test(location.search)) {
    window.__deal = (names, cards, target = 200) => {
      const filler = HotStreak.buildDeck().filter((c) => c.kind === 'num');
      startGame(names, target, filler.concat(cards.slice().reverse()));
    };
  }

  showSetup();
})();
