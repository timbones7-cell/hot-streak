// Hot Streak rules engine.
// Pure game state + a task queue. The UI calls hit / stay / chooseTarget / nextRound,
// then drains `game.events` (each carries a snapshot of state) to animate what happened.
(function (global) {
  'use strict';

  const SEVEN_BONUS = 15;

  function buildDeck() {
    const d = [];
    let id = 0;
    d.push({ id: id++, kind: 'num', value: 0 });
    for (let v = 1; v <= 12; v++) for (let k = 0; k < v; k++) d.push({ id: id++, kind: 'num', value: v });
    for (const v of [2, 4, 6, 8, 10]) d.push({ id: id++, kind: 'mod', value: v });
    d.push({ id: id++, kind: 'x2' });
    for (const a of ['freeze', 'flip3', 'second']) for (let k = 0; k < 3; k++) d.push({ id: id++, kind: a });
    return d;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Score breakdown for a player's current tableau.
  function breakdown(p) {
    const nums = p.cards.filter((c) => c.kind === 'num').map((c) => c.value);
    const mods = p.cards.filter((c) => c.kind === 'mod').map((c) => c.value);
    const x2 = p.cards.some((c) => c.kind === 'x2');
    const numSum = nums.reduce((a, b) => a + b, 0);
    const modSum = mods.reduce((a, b) => a + b, 0);
    const bonus = p.seven ? SEVEN_BONUS : 0;
    const score = p.status === 'busted' ? 0 : numSum * (x2 ? 2 : 1) + modSum + bonus;
    return { nums, mods, x2, numSum, modSum, bonus, score, busted: p.status === 'busted' };
  }

  const numCount = (p) => p.cards.filter((c) => c.kind === 'num').length;

  class Game {
    // opts: { target, dealer, rng, deck (pre-ordered, top = last element; skips shuffle) }
    constructor(names, opts = {}) {
      this.rng = opts.rng || Math.random;
      this.events = [];
      this.s = {
        players: names.map((name) => ({ name, total: 0, cards: [], second: null, bust: null, status: 'active', seven: false })),
        deck: opts.deck ? opts.deck.slice() : shuffle(buildDeck(), this.rng),
        discard: [],
        dealer: opts.dealer != null ? opts.dealer : 0,
        turn: 0,
        round: 0,
        target: opts.target || 200,
        tasks: [],
        awaiting: null,
        setAside: {},
        seq: 0,
        phase: 'play',
        summary: null,
        winner: null,
      };
    }

    static load(state) {
      const g = Object.create(Game.prototype);
      g.rng = Math.random;
      g.events = [];
      g.s = state;
      return g;
    }

    emit(type, data = {}) {
      this.events.push(Object.assign({ type }, data, { snap: clone(this.s) }));
    }

    // ---------- round flow ----------

    startRound() {
      const s = this.s;
      s.round++;
      s.phase = 'play';
      s.summary = null;
      for (const p of s.players) { p.status = 'active'; p.seven = false; }
      const n = s.players.length;
      s.tasks = [];
      for (let k = 1; k <= n; k++) s.tasks.push({ t: 'deal', p: (s.dealer + k) % n });
      s.tasks.push({ t: 'turn' });
      s.turn = s.dealer; // first turn goes to the player left of the dealer
      this.emit('roundStart', { round: s.round, dealer: s.dealer });
      this.run();
    }

    nextRound() {
      const s = this.s;
      if (s.phase !== 'summary') return;
      for (const p of s.players) {
        s.discard.push(...p.cards);
        if (p.second) s.discard.push(p.second);
        if (p.bust) s.discard.push(p.bust);
        p.cards = []; p.second = null; p.bust = null;
      }
      s.awaiting = null;
      s.dealer = (s.dealer + 1) % s.players.length;
      this.startRound();
    }

    run() {
      const s = this.s;
      while (!s.awaiting && s.tasks.length) this.exec(s.tasks.shift());
    }

    exec(task) {
      const s = this.s;
      switch (task.t) {
        case 'deal':
          if (s.players[task.p].status === 'active') this.draw(task.p, null, true);
          break;
        case 'turn': {
          const nxt = this.nextActive(s.turn);
          if (nxt < 0) this.endRound();
          else { s.turn = nxt; s.awaiting = { type: 'decide', p: nxt }; this.emit('turn', { p: nxt }); }
          break;
        }
        case 'draw':
          this.draw(task.p, task.f3);
          break;
        case 'flip3':
          this.stepFlip3(task);
          break;
        case 'target':
          this.resolveTarget(task);
          break;
      }
    }

    nextActive(from) {
      const n = this.s.players.length;
      for (let k = 1; k <= n; k++) {
        const i = (from + k) % n;
        if (this.s.players[i].status === 'active') return i;
      }
      return -1;
    }

    takeCard() {
      const s = this.s;
      if (!s.deck.length) {
        if (!s.discard.length) return null;
        s.deck = shuffle(s.discard, this.rng);
        s.discard = [];
        this.emit('reshuffle');
      }
      return s.deck.pop();
    }

    // f3: id of the Flip Three this draw belongs to (actions get set aside), or null.
    draw(p, f3, deal) {
      const s = this.s;
      const pl = s.players[p];
      const card = this.takeCard();
      if (!card) { pl.status = 'stayed'; this.emit('stay', { p, forced: true }); return; }
      this.emit('draw', { p, card, f3: !!f3, deal: !!deal });

      if (card.kind === 'num') {
        const dup = pl.cards.some((c) => c.kind === 'num' && c.value === card.value);
        if (dup) {
          if (pl.second) {
            s.discard.push(card, pl.second);
            pl.second = null;
            this.emit('saved', { p, card });
          } else {
            pl.status = 'busted';
            pl.bust = card;
            this.emit('bust', { p, card });
          }
          return;
        }
        pl.cards.push(card);
        if (numCount(pl) === 7) {
          pl.seven = true;
          pl.status = 'stayed';
          this.emit('seven', { p, card });
          this.endRound();
          return;
        }
        this.emit('place', { p, card });
      } else if (card.kind === 'mod' || card.kind === 'x2') {
        pl.cards.push(card);
        this.emit('place', { p, card });
      } else if (card.kind === 'second') {
        if (!pl.second) { pl.second = card; this.emit('place', { p, card }); }
        else s.tasks.unshift({ t: 'target', action: 'second', from: p, card });
      } else if (f3) {
        s.setAside[f3].push(card);
        this.emit('setAside', { p, card });
      } else {
        s.tasks.unshift({ t: 'target', action: card.kind, from: p, card });
      }
    }

    eligible(action, from) {
      const ps = this.s.players;
      const out = [];
      ps.forEach((p, i) => {
        if (p.status !== 'active') return;
        if (action === 'second' && (i === from || p.second)) return;
        out.push(i);
      });
      return out;
    }

    resolveTarget(task) {
      const s = this.s;
      const opts = this.eligible(task.action, task.from);
      if (!opts.length) {
        s.discard.push(task.card);
        this.emit('discardAction', { p: task.from, card: task.card, action: task.action });
        return;
      }
      if (opts.length === 1) { this.applyAction(task, opts[0], true); return; }
      s.awaiting = { type: 'target', p: task.from, action: task.action, card: task.card, options: opts, task };
      this.emit('chooseTarget', { p: task.from, action: task.action, card: task.card, options: opts });
    }

    chooseTarget(i) {
      const s = this.s;
      const a = s.awaiting;
      if (!a || a.type !== 'target' || !a.options.includes(i)) return;
      s.awaiting = null;
      this.applyAction(a.task, i, false);
      this.run();
    }

    applyAction(task, t, auto) {
      const s = this.s;
      const target = s.players[t];
      if (task.action === 'freeze') {
        target.status = 'frozen';
        s.discard.push(task.card);
        this.emit('freeze', { p: task.from, t, card: task.card, auto });
      } else if (task.action === 'flip3') {
        s.discard.push(task.card);
        const id = ++s.seq;
        s.setAside[id] = [];
        s.tasks.unshift({ t: 'flip3', p: t, left: 3, id });
        this.emit('flip3', { p: task.from, t, card: task.card, auto });
      } else if (task.action === 'second') {
        target.second = task.card;
        this.emit('giveSecond', { p: task.from, t, card: task.card, auto });
      }
    }

    stepFlip3(task) {
      const s = this.s;
      const pl = s.players[task.p];
      if (pl.status === 'active' && task.left > 0) {
        task.left--;
        s.tasks.unshift({ t: 'draw', p: task.p, f3: task.id }, task);
        return;
      }
      const aside = s.setAside[task.id] || [];
      delete s.setAside[task.id];
      this.emit('flip3Done', { p: task.p });
      if (pl.status === 'active') {
        s.tasks.unshift(...aside.map((card) => ({ t: 'target', action: card.kind, from: task.p, card })));
      } else {
        s.discard.push(...aside);
      }
    }

    // ---------- player decisions ----------

    hit() {
      const s = this.s;
      const a = s.awaiting;
      if (!a || a.type !== 'decide') return;
      s.awaiting = null;
      s.tasks = [{ t: 'draw', p: a.p, f3: null }, { t: 'turn' }];
      this.run();
    }

    stay() {
      const s = this.s;
      const a = s.awaiting;
      if (!a || a.type !== 'decide') return;
      s.awaiting = null;
      s.players[a.p].status = 'stayed';
      this.emit('stay', { p: a.p });
      s.tasks = [{ t: 'turn' }];
      this.run();
    }

    // ---------- scoring ----------

    endRound() {
      const s = this.s;
      // A 7 Streak can end the round mid-chain: discard any action cards still waiting to resolve.
      for (const t of s.tasks) if (t.t === 'target') s.discard.push(t.card);
      for (const k of Object.keys(s.setAside)) s.discard.push(...s.setAside[k]);
      s.tasks = [];
      s.setAside = {};
      const rows = s.players.map((p, i) => Object.assign({ i, before: p.total }, breakdown(p)));
      rows.forEach((r) => { s.players[r.i].total += r.score; r.after = s.players[r.i].total; });
      s.summary = { round: s.round, rows };
      const max = Math.max(...s.players.map((p) => p.total));
      const leaders = s.players.map((p, i) => i).filter((i) => s.players[i].total === max);
      if (max >= s.target && leaders.length === 1) { s.phase = 'over'; s.winner = leaders[0]; }
      else s.phase = 'summary';
      s.awaiting = { type: s.phase };
      this.emit('roundEnd', { summary: s.summary });
    }
  }

  global.HotStreak = { Game, buildDeck, breakdown, shuffle, SEVEN_BONUS };
})(typeof window !== 'undefined' ? window : globalThis);
