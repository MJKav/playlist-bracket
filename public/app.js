// App wiring: import → setup → bracket, plus matchups, undo, and persistence.

(function () {
  "use strict";

  const { esc, fmtDuration, artHtml } = View;
  const $ = (sel) => document.querySelector(sel);
  const STORE_KEY = "playlistBracket.v1";
  const ZOOM_KEY = "playlistBracket.zoom";
  const ZOOMS = [0.35, 0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3];

  let state = load(); // the saved bracket, or null
  let draft = null; // setup-screen data before a bracket is built
  let rounds = null; // Bracket.compute(state.bracket), refreshed on render
  let zoom = 1;
  let currentKey = null; // match shown in the matchup overlay
  let picking = false;
  let stopConfetti = null;
  let artJob = 0;

  // ---------- storage ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && s.version === 1 && s.bracket ? s : null;
    } catch {
      return null;
    }
  }
  function save() {
    if (!state) return;
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked — bracket still works for this session */
    }
  }
  function clearSaved() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
  }

  // ---------- small UI helpers ----------
  function show(name) {
    for (const s of ["import", "setup", "bracket"]) $(`#screen-${s}`).hidden = s !== name;
    window.scrollTo(0, 0);
  }

  function setMsg(el, text, { error = false, busy = false } = {}) {
    el.classList.toggle("error", error);
    el.innerHTML = busy ? `<span class="spinner"></span>${esc(text)}` : esc(text);
  }

  function setBusy(on) {
    $("#loadBtn").disabled = on;
    $("#pasteBtn").disabled = on;
  }

  let toastTimer;
  function toast(text, actionLabel, action) {
    const el = $("#toast");
    el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
    if (action) el.querySelector("button").onclick = () => { action(); hideToast(); };
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    $("#toast").hidden = true;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`);
    return body;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  // ---------- parsing links ----------
  function parseCollectionLink(text) {
    const s = text.trim();
    const m =
      s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/i) ||
      s.match(/^spotify:(playlist|album):([A-Za-z0-9]{22})$/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };
    if (/^[A-Za-z0-9]{22}$/.test(s)) return { type: "playlist", id: s };
    if (/^https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(s)) return { shortLink: s };
    return null;
  }

  function parseTrackIds(text) {
    const re = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/gi;
    return [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  }

  function dedupe(tracks) {
    const seen = new Set();
    return tracks.filter((t) => !seen.has(t.id) && seen.add(t.id));
  }

  // ---------- import ----------
  async function loadCollection(text) {
    const msg = $("#importMsg");
    let parsed = parseCollectionLink(text);
    if (!parsed) {
      const ids = parseTrackIds(text);
      if (ids.length) return loadPastedTracks(ids, msg);
      return setMsg(msg, "Paste a Spotify playlist link, like https://open.spotify.com/playlist/…", { error: true });
    }
    setBusy(true);
    setMsg(msg, "Loading from Spotify…", { busy: true });
    try {
      if (parsed.shortLink) parsed = await api(`/api/resolve?url=${encodeURIComponent(parsed.shortLink)}`);
      const data = await api(`/api/collection?type=${parsed.type}&id=${parsed.id}`);
      const tracks = dedupe(data.tracks);
      if (tracks.length < 2) throw new Error(tracks.length ? "That only has one song — a bracket needs at least two." : "No songs found there.");
      setMsg(msg, "");
      openSetup({
        source: { type: data.type, id: data.id, name: data.name, owner: data.owner, image: data.image },
        tracks,
        skipped: data.skipped,
        maybeTruncated: data.maybeTruncated,
      });
    } catch (e) {
      setMsg(msg, e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function loadPastedTracks(ids, msg) {
    setBusy(true);
    const tracks = [];
    let failed = 0;
    try {
      for (let i = 0; i < ids.length; i += 25) {
        setMsg(msg, `Looking up songs… ${i} of ${ids.length}`, { busy: true });
        const batch = ids.slice(i, i + 25);
        const res = await api("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        });
        const byId = new Map(res.tracks.map((t) => [t.id, t]));
        for (const id of batch) byId.has(id) ? tracks.push(byId.get(id)) : failed++;
      }
      if (tracks.length < 2) throw new Error("Couldn't find at least two songs in what you pasted.");
      setMsg(msg, "");
      openSetup({
        source: { type: "custom", id: null, name: "Custom bracket", owner: "", image: tracks[0].image },
        tracks,
        skipped: failed,
        maybeTruncated: false,
      });
    } catch (e) {
      setMsg(msg, e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  function renderResume() {
    const el = $("#resumeCard");
    if (!state) {
      el.hidden = true;
      return;
    }
    const s = Bracket.stats(Bracket.compute(state.bracket));
    el.innerHTML =
      `${artHtml(state.source.image, "resume-art")}` +
      `<div class="grow"><span class="muted">Your bracket</span><strong>${esc(state.source.name)}</strong>` +
      `<span class="muted">${s.champion ? "Complete" : `${s.decided} of ${s.total} matchups decided`}</span></div>` +
      `<button class="btn btn-primary" type="button" id="resumeBtn">Resume</button>`;
    el.querySelector("#resumeBtn").onclick = openBracket;
    el.hidden = false;
  }

  function goHome() {
    closeMatchup();
    closeChampion();
    renderResume();
    show("import");
  }

  // ---------- album art (loaded in the background) ----------
  async function fetchArt(list, onUpdate) {
    const job = ++artJob;
    const missing = list.filter((t) => !t.image).map((t) => t.id);
    for (let i = 0; i < missing.length; i += 20) {
      if (job !== artJob) return;
      try {
        const { art } = await api(`/api/art?ids=${missing.slice(i, i + 20).join(",")}`);
        let changed = false;
        for (const t of list) {
          if (!t.image && art[t.id]) {
            t.image = art[t.id];
            changed = true;
          }
        }
        if (changed && job === artJob) onUpdate();
      } catch {
        /* artwork is optional */
      }
    }
  }

  // ---------- setup ----------
  function openSetup(d) {
    draft = { ...d, selected: new Set(d.tracks.map((t) => t.id)) };
    const { source } = d;
    $("#setupCover").src = source.image || "";
    $("#setupCover").hidden = !source.image;
    $("#setupKind").textContent = { playlist: "Playlist", album: "Album", custom: "Pasted songs" }[source.type];
    $("#setupTitle").textContent = source.name;
    $("#setupOwner").textContent = source.owner ? (source.type === "playlist" ? `By ${source.owner}` : source.owner) : "";

    const notes = [];
    if (d.maybeTruncated) {
      notes.push("Spotify only shares the first 100 songs of a playlist publicly, so this list may be cut short. To include every song, go back and use “Playlist has more than 100 songs?”.");
    }
    if (d.skipped) {
      notes.push(`${d.skipped} item${d.skipped === 1 ? " was" : "s were"} skipped (local files, podcasts, or songs that couldn't be found).`);
    }
    $("#setupNotice").textContent = notes.join(" ");
    $("#setupNotice").hidden = !notes.length;

    $("#songFilter").value = "";
    renderSongList();
    updateSummary();
    show("setup");
    fetchArt(draft.tracks, () => draft && renderSongList());
  }

  function renderSongList() {
    const q = $("#songFilter").value.trim().toLowerCase();
    $("#songList").innerHTML = draft.tracks
      .map((t, i) => {
        if (q && !`${t.name} ${t.artists}`.toLowerCase().includes(q)) return "";
        const on = draft.selected.has(t.id);
        return (
          `<li class="${on ? "" : "off"}"><label>` +
          `<input type="checkbox" data-id="${t.id}" ${on ? "checked" : ""}>` +
          `<span class="n">${i + 1}</span>${artHtml(t.image, "art")}` +
          `<span class="t"><b>${esc(t.name)}</b><small>${t.explicit ? "🅴 " : ""}${esc(t.artists)}</small></span>` +
          `<span class="dur">${fmtDuration(t.durationMs)}</span></label></li>`
        );
      })
      .join("");
  }

  function setupChoice(name) {
    return document.querySelector(`input[name="${name}"]:checked`).value;
  }

  function updateSummary() {
    const total = draft.tracks.length;
    const n = draft.selected.size;
    $("#songCount").textContent = `${n} of ${total}`;
    const summary = $("#setupSummary");
    if (n < 2) {
      $("#fitGroup").hidden = true;
      summary.textContent = "Select at least 2 songs.";
      $("#buildBtn").disabled = true;
      return;
    }
    const size = Bracket.nextPow2(n);
    const even = size === n;
    const trimTo = Bracket.prevPow2(n);
    const random = setupChoice("seeding") === "random";
    $("#fitGroup").hidden = even;
    const byes = size - n;
    const who = random ? `random song${byes === 1 ? "" : "s"}` : `top seed${byes === 1 ? "" : "s"}`;
    $("#byesHint").textContent = `${byes} ${who} skip${byes === 1 ? "s" : ""} the first round, filling a ${size}-song bracket.`;
    $("#trimHint").textContent = `Keep ${random ? "a random" : "the top"} ${trimTo} and drop the other ${n - trimTo}.`;

    const count = !even && setupChoice("fit") === "trim" ? trimTo : n;
    const roundsN = Math.log2(Bracket.nextPow2(count));
    summary.innerHTML = `<b>${count}</b> songs · <b>${roundsN}</b> round${roundsN === 1 ? "" : "s"} · <b>${count - 1}</b> matchups`;
    $("#buildBtn").disabled = false;
  }

  function buildBracket() {
    if (state && Object.keys(state.bracket.picks).length &&
        !confirm(`Replace your bracket for “${state.source.name}”? Your picks there will be lost.`)) {
      return;
    }
    const seeding = setupChoice("seeding");
    let ids = draft.tracks.filter((t) => draft.selected.has(t.id)).map((t) => t.id);
    if (seeding === "random") ids = Bracket.shuffle(ids);
    const b = Bracket.create(ids, { fit: setupChoice("fit") });
    const used = new Set(b.slots.filter(Boolean));
    const tracks = {};
    for (const t of draft.tracks) if (used.has(t.id)) tracks[t.id] = t;
    state = {
      version: 1,
      source: draft.source,
      tracks,
      bracket: b,
      seeded: seeding === "order",
      history: [],
      createdAt: Date.now(),
    };
    draft = null;
    save();
    zoom = 0; // pick a fitting zoom for the new bracket
    openBracket();
  }

  // ---------- bracket ----------
  function openBracket() {
    if (!state) return goHome();
    show("bracket");
    $("#bbTitle").textContent = state.source.name;
    $("#bbCover").src = state.source.image || "";
    $("#bbCover").hidden = !state.source.image;
    render();
    if (!zoom) setZoom(fitZoom(0.6));
    fetchArt(Object.values(state.tracks), () => {
      save();
      render();
      if (currentKey) openMatchup(currentKey);
    });
  }

  function render() {
    rounds = Bracket.compute(state.bracket);
    View.renderBracket($("#bracket"), {
      b: state.bracket,
      rounds,
      tracks: state.tracks,
      seeded: state.seeded,
    });
    const s = Bracket.stats(rounds);
    $("#bbProgress").textContent = s.champion
      ? `Complete · ${s.total} matchups`
      : `${s.decided} of ${s.total} matchups decided`;
    $("#progressFill").style.width = `${s.total ? (s.decided / s.total) * 100 : 0}%`;
    $("#playBtn").textContent = s.champion ? "See champion" : s.decided ? "Continue matchups" : "Start matchups";
    $("#undoBtn").disabled = !state.history.length;
    $("#mUndo").disabled = !state.history.length;
  }

  // Returns true if this pick crowned a new champion.
  function pick(key, trackId) {
    const b = state.bracket;
    if (b.picks[key] === trackId) return false;
    const hadChampion = !!Bracket.stats(rounds).champion;
    state.history.push({ ...b.picks });
    if (state.history.length > 500) state.history.shift();
    const removed = Bracket.setPick(b, key, trackId);
    save();
    render();
    if (removed) toast(`Pick changed · cleared ${removed} later result${removed === 1 ? "" : "s"}`, "Undo", undo);
    return !hadChampion && !!Bracket.stats(rounds).champion;
  }

  function undo() {
    if (!state || !state.history.length) return;
    const cur = state.bracket.picks;
    const prev = state.history.pop();
    const changed = Object.keys({ ...cur, ...prev }).filter((k) => cur[k] !== prev[k]);
    state.bracket.picks = prev;
    save();
    render();
    hideToast();
    closeChampion();
    if (!$("#matchOverlay").hidden) {
      const m = rounds.flat().find((x) => changed.includes(x.key) && x.a && x.b && !x.bye);
      openMatchup(m ? m.key : null);
    }
  }

  function resetPicks() {
    if (!Object.keys(state.bracket.picks).length) return toast("No picks to clear");
    state.history.push({ ...state.bracket.picks });
    state.bracket.picks = {};
    save();
    render();
    toast("All picks cleared", "Undo", undo);
  }

  function newBracket() {
    if (state && Object.keys(state.bracket.picks).length &&
        !confirm(`Delete your bracket for “${state.source.name}” and start a new one?`)) {
      return;
    }
    state = null;
    clearSaved();
    goHome();
  }

  // ---------- zoom ----------
  function setZoom(z) {
    zoom = Math.min(1.5, Math.max(0.25, Math.round(z * 100) / 100));
    $("#bracket").style.setProperty("--zoom", zoom);
    $("#zoomFit").textContent = `${Math.round(zoom * 100)}%`;
    try {
      localStorage.setItem(ZOOM_KEY, zoom);
    } catch {}
  }

  function fitZoom(min = 0.25) {
    const scroller = $("#bracketScroll");
    const el = $("#bracket");
    const applied = parseFloat(el.style.getPropertyValue("--zoom")) || 1;
    const natural = el.getBoundingClientRect().width / applied;
    const pad = parseFloat(getComputedStyle(scroller).paddingLeft) * 2;
    const avail = scroller.clientWidth - pad;
    return Math.max(min, Math.min(1, avail / natural));
  }

  // ---------- matchup overlay ----------
  function openMatchup(key) {
    const s = Bracket.stats(rounds);
    const m = key
      ? rounds.flat().find((x) => x.key === key && x.a && x.b && !x.bye)
      : Bracket.nextMatch(rounds);
    if (!m) {
      closeMatchup();
      if (s.champion) showChampion();
      else toast("No matchups are ready yet");
      return;
    }
    currentKey = m.key;
    const b = state.bracket;
    const inRound = rounds[m.r].filter((x) => !x.bye);
    $("#mRound").textContent = Bracket.roundName(m.r, b.rounds);
    $("#mCount").textContent = `Matchup ${inRound.indexOf(m) + 1} of ${inRound.length} · ${s.decided} of ${s.total} decided overall`;
    const seedText = (id) => (state.seeded ? `#${b.seeds[id]} seed` : "");
    const A = $("#mA");
    const B = $("#mB");
    // Only rebuild cards (and their players) when the songs changed.
    if (A.dataset.track !== m.a || B.dataset.track !== m.b || A.dataset.key !== m.key) {
      View.renderContender(A, state.tracks[m.a], { seedText: seedText(m.a) });
      View.renderContender(B, state.tracks[m.b], { seedText: seedText(m.b) });
      A.dataset.key = B.dataset.key = m.key;
    }
    A.classList.toggle("picked", m.winner === m.a);
    B.classList.toggle("picked", m.winner === m.b);
    $("#matchOverlay").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeMatchup() {
    $("#matchOverlay").hidden = true;
    for (const el of [$("#mA"), $("#mB")]) {
      el.innerHTML = ""; // also stops any playing preview
      delete el.dataset.track;
      delete el.dataset.key;
    }
    currentKey = null;
    picking = false;
    document.body.style.overflow = "";
  }

  function choose(trackId) {
    if (picking || !currentKey) return;
    picking = true;
    const key = currentKey;
    for (const el of [$("#mA"), $("#mB")]) {
      el.classList.toggle("picked", el.dataset.track === trackId);
      el.classList.toggle("dropped", el.dataset.track !== trackId);
    }
    const crowned = pick(key, trackId);
    setTimeout(() => {
      picking = false;
      if (crowned) {
        closeMatchup();
        showChampion();
        return;
      }
      const next = Bracket.nextMatch(rounds, key);
      if (next) openMatchup(next.key);
      else closeMatchup();
    }, 420);
  }

  function skip() {
    const next = Bracket.nextMatch(rounds, currentKey);
    if (!next || next.key === currentKey) return toast("This is the only matchup ready right now");
    openMatchup(next.key);
  }

  // ---------- champion ----------
  function showChampion() {
    const s = Bracket.stats(rounds);
    if (!s.champion) return;
    const t = state.tracks[s.champion];
    const ru = state.tracks[s.runnerUp];
    $("#champArt").src = t.image || "";
    $("#champArt").hidden = !t.image;
    $("#champName").textContent = t.name;
    $("#champArtist").textContent = t.artists;
    $("#champSub").textContent = `Beat “${ru.name}” in the final · ${state.source.name}`;
    $("#champOpen").href = `https://open.spotify.com/track/${t.id}`;
    $("#champOverlay").hidden = false;
    if (stopConfetti) stopConfetti();
    stopConfetti = View.confetti($("#confetti"));
  }

  function closeChampion() {
    $("#champOverlay").hidden = true;
    if (stopConfetti) stopConfetti();
    stopConfetti = null;
  }

  async function copyResults() {
    await copyText(Bracket.resultsText(state.bracket, rounds, state.tracks, state.source.name));
    toast("Results copied to clipboard");
  }

  // ---------- events ----------
  $("#brandLink").addEventListener("click", (e) => {
    e.preventDefault();
    goHome();
  });

  $("#importForm").addEventListener("submit", (e) => {
    e.preventDefault();
    loadCollection($("#linkInput").value);
  });

  $("#pasteInput").addEventListener("input", () => {
    const n = parseTrackIds($("#pasteInput").value).length;
    setMsg($("#pasteCount"), n ? `${n} song link${n === 1 ? "" : "s"} found` : "");
  });
  $("#pasteBtn").addEventListener("click", () => {
    const ids = parseTrackIds($("#pasteInput").value);
    const msg = $("#pasteCount");
    if (ids.length < 2) return setMsg(msg, "Paste at least two Spotify song links.", { error: true });
    loadPastedTracks(ids, msg);
  });

  $("#songList").addEventListener("change", (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    e.target.checked ? draft.selected.add(id) : draft.selected.delete(id);
    e.target.closest("li").classList.toggle("off", !e.target.checked);
    updateSummary();
  });
  $("#songFilter").addEventListener("input", renderSongList);
  const setVisible = (on) => {
    $("#songList").querySelectorAll("input[data-id]").forEach((cb) => {
      on ? draft.selected.add(cb.dataset.id) : draft.selected.delete(cb.dataset.id);
    });
    renderSongList();
    updateSummary();
  };
  $("#selectAll").addEventListener("click", () => setVisible(true));
  $("#selectNone").addEventListener("click", () => setVisible(false));
  document.querySelectorAll('input[name="seeding"], input[name="fit"]').forEach((r) => r.addEventListener("change", updateSummary));
  $("#buildBtn").addEventListener("click", buildBracket);
  $("#backBtn").addEventListener("click", goHome);

  $("#bracket").addEventListener("click", (e) => {
    const btn = e.target.closest(".entrant.pickable");
    if (btn && pick(btn.dataset.key, btn.dataset.track)) showChampion();
  });
  View.bindHighlight($("#bracket"));

  $("#playBtn").addEventListener("click", () => openMatchup(null));
  $("#undoBtn").addEventListener("click", undo);
  $("#zoomIn").addEventListener("click", () => setZoom(ZOOMS.find((z) => z > zoom + 0.001) ?? zoom));
  $("#zoomOut").addEventListener("click", () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? zoom));
  $("#zoomFit").addEventListener("click", () => setZoom(fitZoom()));

  const menuBtn = $("#menuBtn");
  const menuList = $("#menuList");
  const setMenu = (open) => {
    menuList.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(menuList.hidden);
  });
  document.addEventListener("click", () => setMenu(false));
  menuList.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    setMenu(false);
    if (action === "copy") copyResults();
    if (action === "reset") resetPicks();
    if (action === "new") newBracket();
  });

  $("#matchOverlay").addEventListener("click", (e) => {
    const pickBtn = e.target.closest("[data-pick]");
    if (pickBtn) return choose(pickBtn.dataset.pick);
    if (e.target === e.currentTarget) closeMatchup();
  });
  $("#mClose").addEventListener("click", closeMatchup);
  $("#mSkip").addEventListener("click", skip);
  $("#mUndo").addEventListener("click", undo);

  $("#champClose").addEventListener("click", closeChampion);
  $("#champCopy").addEventListener("click", copyResults);

  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof Element && e.target.matches("input, textarea, [contenteditable]");
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("#champOverlay").hidden) {
      if (e.key === "Escape") closeChampion();
      return;
    }
    if ($("#matchOverlay").hidden) return;
    if (e.key === "Escape") closeMatchup();
    else if (e.key === "ArrowLeft" || e.key === "1") choose($("#mA").dataset.track);
    else if (e.key === "ArrowRight" || e.key === "2") choose($("#mB").dataset.track);
    else if (e.key.toLowerCase() === "s") skip();
    else if (e.key.toLowerCase() === "u") undo();
  });

  // ---------- start ----------
  try {
    zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 0;
  } catch {}
  if (zoom) setZoom(zoom);

  const deepLink = new URLSearchParams(location.search).get("playlist");
  if (deepLink) {
    history.replaceState(null, "", location.pathname);
    show("import");
    $("#linkInput").value = deepLink;
    loadCollection(deepLink);
  } else if (state) {
    openBracket();
  } else {
    goHome();
  }
})();
