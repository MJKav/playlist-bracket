// Rendering helpers: the bracket tree, matchup cards, and confetti.

(function (global) {
  "use strict";

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  function fmtDuration(ms) {
    if (!ms) return "";
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  const artHtml = (url, cls) =>
    url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy">` : `<span class="${cls}"></span>`;

  // ---------- Bracket tree ----------
  // Two-sided layout: left half flows right, right half flows left, final in the middle.
  function renderBracket(el, { b, rounds, tracks, seeded }) {
    const R = b.rounds;
    const stats = global.Bracket.stats(rounds);

    const entrant = (m, id) => {
      if (!id) {
        return `<div class="entrant empty"><span class="seed"></span><span class="art"></span><span class="t">${m.bye ? "Bye" : "TBD"}</span></div>`;
      }
      const t = tracks[id] || { name: "Unknown song", artists: "" };
      const ready = !m.bye && m.a && m.b;
      const cls = ["entrant"];
      if (ready) cls.push("pickable");
      if (m.winner && !m.bye) cls.push(m.winner === id ? "winner" : "loser");
      const inner =
        `<span class="seed">${seeded ? b.seeds[id] : ""}</span>${artHtml(t.image, "art")}` +
        `<span class="t"><span class="name">${esc(t.name)}</span><span class="artist">${esc(t.artists)}</span></span>`;
      return ready
        ? `<button type="button" class="${cls.join(" ")}" data-track="${id}" data-key="${m.key}" title="${esc(`${t.name} — ${t.artists}`)}">${inner}</button>`
        : `<div class="${cls.join(" ")}" data-track="${id}">${inner}</div>`;
    };

    const matchHtml = (m) => {
      const cls = ["match"];
      if (m.bye) cls.push("bye");
      else if (m.a && m.b && !m.winner) cls.push("ready");
      return `<div class="${cls.join(" ")}" data-match="${m.key}">${entrant(m, m.a)}${entrant(m, m.b)}</div>`;
    };

    const slotHtml = (m, extra = "") =>
      `<div class="slot${m.winner ? " done" : ""}">${extra}${matchHtml(m)}</div>`;

    const colHtml = (r, matches, side) => {
      let body = "";
      if (matches.length === 1) {
        body = slotHtml(matches[0]);
      } else {
        for (let i = 0; i < matches.length; i += 2) {
          body += `<div class="pair">${slotHtml(matches[i])}${slotHtml(matches[i + 1])}</div>`;
        }
      }
      return `<div class="col ${side}"><div class="col-head">${global.Bracket.roundName(r, R)}</div><div class="col-body">${body}</div></div>`;
    };

    const finalMatch = rounds[R - 1][0];
    let champ;
    if (stats.champion) {
      const t = tracks[stats.champion] || {};
      champ = `<div class="champ-slot"><div class="trophy">🏆</div>${artHtml(t.image, "champ-img")}<strong>${esc(t.name)}</strong><span>${esc(t.artists)}</span></div>`;
    } else {
      champ = `<div class="champ-slot pending"><div class="trophy">🏆</div><span>Champion</span></div>`;
    }

    const left = [];
    const right = [];
    for (let r = 0; r < R - 1; r++) {
      const half = rounds[r].length / 2;
      left.push(colHtml(r, rounds[r].slice(0, half), "side-left"));
      right.unshift(colHtml(r, rounds[r].slice(half), "side-right"));
    }
    const final = `<div class="col final"><div class="col-head">Final</div><div class="col-body">${slotHtml(finalMatch, champ)}</div></div>`;

    el.classList.toggle("solo", R === 1);
    el.classList.toggle("no-seeds", !seeded);
    el.innerHTML = left.join("") + final + right.join("");
  }

  // Hovering a song highlights every appearance of it (its path through the bracket).
  function bindHighlight(el) {
    let current = null;
    const clear = () => {
      el.querySelectorAll(".entrant.hl").forEach((n) => n.classList.remove("hl"));
      current = null;
    };
    el.addEventListener("mouseover", (e) => {
      const node = e.target.closest("[data-track]");
      const id = node ? node.dataset.track : null;
      if (id === current) return;
      clear();
      if (!id) return;
      current = id;
      el.querySelectorAll(`[data-track="${id}"]`).forEach((n) => n.classList.add("hl"));
    });
    el.addEventListener("mouseleave", clear);
  }

  // ---------- Matchup card ----------
  function renderContender(el, track, { seedText }) {
    const name = esc(track.name);
    el.dataset.track = track.id;
    el.classList.remove("picked", "dropped");
    el.innerHTML =
      `${artHtml(track.image, "c-art")}` +
      `<div class="c-meta"><span class="c-seed">${esc(seedText)}</span><h3>${name}</h3><p class="c-artist">${esc(track.artists)}</p></div>` +
      `<iframe src="https://open.spotify.com/embed/track/${track.id}?utm_source=generator&theme=0" title="Listen to ${name}" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>` +
      `<button class="btn btn-primary" type="button" data-pick="${track.id}">Pick this song</button>`;
  }

  // ---------- Confetti ----------
  function confetti(canvas) {
    if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
    const ctx = canvas.getContext("2d");
    const dpr = global.devicePixelRatio || 1;
    const W = (canvas.width = canvas.clientWidth * dpr);
    const H = (canvas.height = canvas.clientHeight * dpr);
    const colors = ["#ffc94a", "#ff6a4d", "#eef0f5", "#7dd3fc", "#b69cff"];
    const pieces = Array.from({ length: 200 }, () => ({
      x: Math.random() * W,
      y: -Math.random() * H * 0.8,
      vx: (Math.random() - 0.5) * 3 * dpr,
      vy: (Math.random() * 2 + 2) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      w: (Math.random() * 6 + 5) * dpr,
      h: (Math.random() * 4 + 3) * dpr,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    let raf;
    const start = performance.now();
    const frame = (now) => {
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of pieces) {
        p.vy += 0.03 * dpr;
        p.x += p.vx + Math.sin((now + p.w * 100) / 400) * 0.6;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y > H && now - start < 2500) {
          p.y = -20;
          p.vy = (Math.random() * 2 + 2) * dpr;
        }
        if (p.y < H + 20) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H);
    };
  }

  global.View = { esc, fmtDuration, artHtml, renderBracket, bindHighlight, renderContender, confetti };
})(window);
