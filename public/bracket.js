// Pure bracket logic — no DOM. A bracket is stored as:
//   { size, rounds, slots: [trackId|null...], seeds: {trackId: n}, picks: {"r-i": trackId} }
// Everything else (who plays whom in later rounds, winners, byes) is derived.

(function (global) {
  "use strict";

  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  function prevPow2(n) {
    let p = 1;
    while (p * 2 <= n) p *= 2;
    return p;
  }

  // Standard tournament seeding: 1 plays 16, 8 plays 9, and so on, with the
  // top two seeds on opposite halves. Returns seed numbers in slot order.
  function seedPositions(size) {
    let order = [1];
    while (order.length < size) {
      const n = order.length * 2;
      order = order.flatMap((s) => [s, n + 1 - s]);
    }
    return order;
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // trackIds are in seed order (index 0 = seed 1).
  function create(trackIds, { fit = "byes" } = {}) {
    let ids = [...new Set(trackIds)];
    if (ids.length < 2) throw new Error("A bracket needs at least 2 songs.");
    if (fit === "trim") ids = ids.slice(0, prevPow2(ids.length));
    const size = nextPow2(ids.length);
    const seeds = {};
    ids.forEach((id, i) => (seeds[id] = i + 1));
    return {
      size,
      rounds: Math.log2(size),
      slots: seedPositions(size).map((seed) => ids[seed - 1] ?? null),
      seeds,
      picks: {},
    };
  }

  // Derive every match. Picks that no longer match an entrant are ignored.
  function compute(b) {
    const rounds = [];
    let entrants = b.slots;
    for (let r = 0; r < b.rounds; r++) {
      const matches = [];
      const next = [];
      for (let i = 0; i < entrants.length; i += 2) {
        const a = entrants[i];
        const c = entrants[i + 1];
        const key = `${r}-${i / 2}`;
        let winner = null;
        let bye = false;
        if (r === 0 && (!a || !c)) {
          bye = true;
          winner = a || c;
        } else if (a && c) {
          const p = b.picks[key];
          if (p === a || p === c) winner = p;
        }
        matches.push({ key, r, i: i / 2, a, b: c, winner, bye });
        next.push(winner);
      }
      rounds.push(matches);
      entrants = next;
    }
    return rounds;
  }

  // Drop picks invalidated by an earlier change. Returns how many were removed.
  function prune(b) {
    let removed = 0;
    for (const m of compute(b).flat()) {
      if (b.picks[m.key] !== undefined && b.picks[m.key] !== m.winner) {
        delete b.picks[m.key];
        removed++;
      }
    }
    return removed;
  }

  function setPick(b, key, trackId) {
    b.picks[key] = trackId;
    return prune(b);
  }

  function stats(rounds) {
    const all = rounds.flat().filter((m) => !m.bye);
    const final = rounds[rounds.length - 1][0];
    return {
      total: all.length,
      decided: all.filter((m) => m.winner).length,
      champion: final.winner,
      runnerUp: final.winner ? (final.winner === final.a ? final.b : final.a) : null,
    };
  }

  const isReady = (m) => !m.bye && m.a && m.b && !m.winner;

  // Next match waiting on a pick, in round order. With afterKey, search from
  // just past that match and wrap around (used for "skip").
  function nextMatch(rounds, afterKey) {
    const flat = rounds.flat();
    let start = 0;
    if (afterKey) start = flat.findIndex((m) => m.key === afterKey) + 1;
    for (let n = 0; n < flat.length; n++) {
      const m = flat[(start + n) % flat.length];
      if (isReady(m) && m.key !== afterKey) return m;
    }
    return afterKey ? flat.find((m) => m.key === afterKey && isReady(m)) || null : null;
  }

  function roundName(r, totalRounds) {
    const left = 2 ** (totalRounds - r);
    if (left === 2) return "Final";
    if (left === 4) return "Semifinals";
    if (left === 8) return "Quarterfinals";
    return `Round of ${left}`;
  }

  // Plain-text summary for sharing.
  function resultsText(b, rounds, tracks, title) {
    const label = (id) => {
      const t = tracks[id];
      return t ? `${t.name} — ${t.artists}` : "Unknown song";
    };
    const s = stats(rounds);
    const lines = [`🏆 ${title} — song bracket`, ""];
    if (s.champion) {
      lines.push(`Champion: ${label(s.champion)}`);
      lines.push(`Runner-up: ${label(s.runnerUp)}`);
    } else {
      lines.push(`In progress: ${s.decided} of ${s.total} matchups decided`);
    }
    // Losers of the semifinals, quarterfinals, etc.
    const tiers = [
      [2, "Semifinalists"],
      [3, "Quarterfinalists"],
    ];
    for (const [back, name] of tiers) {
      const r = b.rounds - back;
      if (r < 0) continue;
      const losers = rounds[r]
        .filter((m) => m.winner && !m.bye)
        .map((m) => (m.winner === m.a ? m.b : m.a));
      if (losers.length) lines.push(`${name}: ${losers.map(label).join("; ")}`);
    }
    return lines.join("\n");
  }

  global.Bracket = {
    nextPow2,
    prevPow2,
    seedPositions,
    shuffle,
    create,
    compute,
    prune,
    setPick,
    stats,
    nextMatch,
    roundName,
    resultsText,
  };
})(typeof window !== "undefined" ? window : globalThis);
