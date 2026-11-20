const app = document.querySelector("#app");
const logout = document.querySelector("#logout");
const network = document.querySelector("#network");
const local = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};
const sharedAssignment = new URLSearchParams(location.search);
let user = local.get("timing-user");
let events = [];
let event = null;
let point = null;
let pass = null;
let view = "setup";
let logs = [];
let refreshBibGrid;
const savingBibs = new Set();
let syncing = false;
let syncError = "";
let clockCheck = null;
let zone = null;

const db = new Promise((resolve, reject) => {
  const request = indexedDB.open("novarace-backup-timing", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("captures", { keyPath: "id" });
    request.result.createObjectStore("assignments", { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
db.catch(() => {});

async function storage(store, method, value) {
  const connection = await db;
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(store, method === "put" ? "readwrite" : "readonly");
    const request = value === undefined ? transaction.objectStore(store)[method]() : transaction.objectStore(store)[method](value);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function acknowledge(row, update) {
  const connection = await db;
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction("captures", "readwrite");
    const store = transaction.objectStore("captures");
    const request = store.get(row.id);
    request.onsuccess = () => {
      const current = request.result;
      if (current?.voided === row.voided) store.put({ ...current, ...update });
    };
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}

async function api(path, { method = "GET", data, file } = {}) {
  const headers = user ? { Authorization: "Bearer " + user.token } : {};
  if (data) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, {
    method, headers, body: file || (data ? JSON.stringify(data) : undefined),
    signal: AbortSignal.timeout(file ? 120000 : 10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
const contestName = (id) => event?.contests.find((contest) => contest.id === id)?.name ?? id;
const splitName = (pointName, contestId, splitId) => {
  for (const item of event?.timingPoints ?? []) {
    if (item.name !== pointName) continue;
    for (const choice of item.passes) {
      const split = choice.splits.find((mapping) => mapping.contestId === contestId && mapping.id === splitId);
      if (split) return `${item.name} / ${split.label}`;
    }
  }
  return splitId;
};
const passLabel = (item) => `${item.label}${item.distance > 0 ? ` · ${item.distance / 1000} km` : ""}${item.occurrence > 1 ? ` · pass ${item.occurrence}` : ""}`;
const gender = (runner) => ["m", "male"].includes(runner?.sex) ? "Male"
  : ["f", "female"].includes(runner?.sex) ? "Female" : "Unspecified / other";
const genderOptions = '<option value="">All genders</option>' + ["Male", "Female", "Unspecified / other"].map((name) => option(name, name)).join("");
const topLimit = 10;

function setZone(value) {
  const options = { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" };
  try { zone = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: value || undefined }); }
  catch { zone = new Intl.DateTimeFormat("en-GB", options); }
}
setZone();
const tod = (at) => zone.format(at).replace(",", ".");
const $ = (id) => document.getElementById(id);

function status() {
  const pending = logs.filter((row) => row.dirty).length;
  network.textContent = navigator.onLine ? "Online" : "Offline";
  network.dataset.online = String(navigator.onLine);
  if ($("pending")) $("pending").textContent = pending
    ? `${pending} saved on this device · waiting to upload`
    : "All crossings uploaded";
  if ($("sync-error")) $("sync-error").textContent = syncError;
}

async function refreshLogs() {
  logs = (await storage("captures", "getAll")).filter((row) => row.operator === user?.name);
  status();
}

async function sync() {
  if (syncing || !user || !navigator.onLine) return;
  const account = user;
  syncing = true;
  try {
    await refreshLogs();
    const queue = logs.filter((row) => row.dirty && !row.rejected);
    for (const eventId of new Set(queue.map((row) => row.event))) {
      const rows = queue.filter((row) => row.event === eventId);
      for (let i = 0; i < rows.length; i += 200) {
        if (user !== account) return;
        const batch = rows.slice(i, i + 200);
        const result = await api(`/events/${eventId}/captures`, { method: "POST", data: { entries: batch } });
        for (const row of batch) {
          if (result.accepted.includes(row.id)) await acknowledge(row, { dirty: false });
          if (result.rejected.includes(row.id)) await acknowledge(row, { rejected: true });
        }
      }
    }
    await refreshLogs();
    syncError = logs.some((row) => row.rejected) ? "Some captures were rejected by the server. They remain in your local report." : "";
  } catch (error) {
    syncError = `Sync paused. ${error.message}`;
  } finally {
    syncing = false;
    status();
  }
}

async function checkClock() {
  const start = Date.now();
  const result = await api("/clock");
  const end = Date.now();
  clockCheck = { offset: start + (end - start) / 2 - result.now, latency: end - start, at: end };
}
function clockText() {
  if (!clockCheck) return "Device clock · unchecked";
  return `Device ${Math.round(clockCheck.offset)} ms from server · ±${Math.ceil(clockCheck.latency / 2)} ms · checked ${tod(clockCheck.at)}`;
}

function notice(error) { if ($("message")) $("message").textContent = error?.message ?? error ?? ""; }
function bindForm(id, submit) {
  $(id)?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    notice("");
    try { await submit(new FormData(event.currentTarget)); }
    catch (error) { notice(error); }
    finally { if (button) button.disabled = false; }
  });
}

async function refreshEvents() {
  events = local.get("timing-events:" + user.name, []);
  try {
    events = await api("/events");
    local.set("timing-events:" + user.name, events);
  } catch { /* Cached assignments remain available. */ }
}

async function loadEvent(id) {
  let configuration;
  try {
    configuration = await api(`/events/${encodeURIComponent(id)}`);
    await storage("assignments", "put", { id: `${user.name}:${id}`, configuration });
  } catch (error) {
    configuration = (await storage("assignments", "get", `${user.name}:${id}`))?.configuration;
    if (!configuration) throw error;
  }
  event = configuration;
  setZone(event.timezone);
  point = null;
  pass = null;
  local.set("timing-selection:" + user.name, { event: event.id });
}

function remember() {
  local.set("timing-selection:" + user.name, { event: event.id, point: point.name, pass: pass.key, view });
}

function renderLogin() {
  logout.hidden = true;
  app.innerHTML = `<section class="login panel"><div class="eyebrow">Checkpoint operations</div><h1>Backup Timing</h1>
    <p>${sharedAssignment.has("event") ? "Sign in with your volunteer account to open the shared assignment." : "Sign in online to download your event and roster before heading to your timing point."}</p>
    <form id="login"><label>Username<input name="name" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary">Sign in</button></form><p id="message" role="status"></p></section>`;
  bindForm("login", async (form) => {
    user = await api("/login", { method: "POST", data: Object.fromEntries(form) });
    local.set("timing-user", user);
    navigator.storage?.persist?.().catch(() => {});
    await initialize();
  });
}

function renderSetup() {
  view = "setup";
  logout.hidden = false;
  const admin = user.role === "admin";
  app.innerHTML = `<div class="setup ${admin ? "" : "volunteer-setup"}">
    <div class="page-head"><div class="eyebrow">${admin ? "Race control" : "Volunteer assignment"}</div><h1>Set your checkpoint</h1></div>
    <div class="setup-grid"><section class="panel">
      ${admin ? "<h2>Timing assignment</h2>" : ""}
      <label>Event<select id="event"><option value="">Choose an event</option>${events.map((item) => option(item.id, item.name)).join("")}</select></label>
      <div id="assignment"></div>
      <div class="actions"><button id="start" class="primary" disabled>${admin ? "Open bib keypad" : "Start recording bibs"}</button>
        ${admin ? '<button id="report" disabled>Race-control report</button>' : ""}</div>
    </section>
    ${admin ? `<section class="panel"><h2>Race control</h2>
      <form id="upload"><label>RACE RESULT event file<input type="file" name="ses" accept=".ses" required></label><button>Import event</button></form>
      <form id="volunteer"><h3>Create volunteer</h3><label>Username<input name="name" required minlength="3" maxlength="48"></label>
      <label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" required></label>
      <button>Create account</button></form></section>` : ""}
    </div><p id="message" role="status"></p><p id="sync-error" role="status"></p></div>`;
  $("event").value = event?.id ?? "";
  $("event").onchange = async (change) => {
    const selector = change.currentTarget;
    selector.disabled = true;
    notice("");
    $("start").disabled = true;
    if ($("report")) $("report").disabled = true;
    $("assignment").replaceChildren();
    try {
      if ($("event").value) await loadEvent($("event").value);
      else { event = null; point = null; pass = null; local.set("timing-selection:" + user.name, null); }
      assignment();
    } catch (error) { notice(error); }
    finally { selector.disabled = false; }
  };
  $("start").onclick = () => { view = "capture"; remember(); renderCapture(); };
  if ($("report")) $("report").onclick = () => showReport(true);
  bindForm("upload", async (form) => {
    const file = form.get("ses");
    notice("Importing event and start list…");
    const imported = await api(`/events?filename=${encodeURIComponent(file.name)}`, { method: "POST", file });
    await refreshEvents();
    await loadEvent(imported.id);
    renderSetup();
    notice(`Imported ${event.roster.length} bibs across ${event.contests.length} contests.`);
  });
  bindForm("volunteer", async (form) => {
    const result = await api("/volunteers", { method: "POST", data: Object.fromEntries(form) });
    $("volunteer").reset();
    notice(`Account created for ${result.name}.`);
  });
  assignment();
  status();
}

function assignment() {
  if (!event) { $("assignment").replaceChildren(); return; }
  if ($("report")) $("report").disabled = false;
  const admin = user.role === "admin";
  $("assignment").innerHTML = `<label>${admin ? "Physical timing point" : "Checkpoint"}<select id="point"><option value="">Choose a checkpoint</option>
    ${event.timingPoints.filter((item) => item.passes.length).map((item) => option(item.name, item.name)).join("")}
    </select></label><div id="pass-slot"></div>
    ${user.role === "admin" ? '<div id="share" class="share"><label>Volunteer link<input id="share-url" type="url" readonly></label><button id="copy-link" type="button">Copy link</button><p id="share-note" class="muted" role="status"></p></div>' : ""}
    <p class="muted">${admin ? `${event.roster.length} bibs cached · ${escape(event.timezone || "device time zone")}<br>` : ""}<span id="offline-state" role="status">${offlineText()}</span></p>
    ${admin && event.findings.length ? `<details><summary>${event.findings.length} import findings</summary><ul>${event.findings.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></details>` : ""}`;
  $("point").value = point?.name ?? "";
  $("point").onchange = () => {
    point = event.timingPoints.find((item) => item.name === $("point").value);
    pass = point?.passes.length === 1 ? point.passes[0] : null;
    showPass();
  };
  showPass();
}

function updateShareLink() {
  if (!$("share-url")) return;
  const link = new URL("/", location.origin);
  link.searchParams.set("event", event.id);
  if (point) link.searchParams.set("point", point.name);
  $("share-url").value = link.href;
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(link.hostname);
  $("share-note").textContent = localHost
    ? "This link opens only on this computer. Open admin on your shared HTTPS address to create a phone-ready link."
    : "Volunteers sign in with their own accounts. This link selects the event and the checkpoint if chosen.";
  $("copy-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(link.href);
      $("share-note").textContent = localHost ? "Copied local link. Volunteer phones need the shared HTTPS address." : "Volunteer link copied.";
    } catch {
      $("share-url").focus();
      $("share-url").select();
      $("share-note").textContent = "Link selected. Use your device’s Copy command.";
    }
  };
}

function showPass() {
  updateShareLink();
  $("start").disabled = !pass;
  $("pass-slot").innerHTML = point ? `<label>Active split<select id="setup-pass"><option value="">Choose a split</option>
    ${point.passes.map((item) => option(item.key, passLabel(item))).join("")}</select></label>` : "";
  if (!point) return;
  $("setup-pass").value = pass?.key ?? "";
  $("setup-pass").onchange = () => {
    pass = point.passes.find((item) => item.key === $("setup-pass").value);
    $("start").disabled = !pass;
  };
}

function eligible() {
  const contestIds = new Set(pass.splits.map((split) => split.contestId));
  return event.roster.filter((runner) => contestIds.has(runner.contestId) && ![4, 5].includes(runner.status));
}

function bibKey(row) {
  return JSON.stringify([row.operator, row.event, row.point, row.contestId, row.splitId, row.participantId]);
}

function renderCapture() {
  app.innerHTML = `<div class="capture">
    <header class="console"><div><div class="eyebrow">${escape(event.name)}</div><h1>${escape(point.name)}</h1>
    <label>Active split<select id="active-pass">${point.passes.map((item) => option(item.key, passLabel(item))).join("")}</select></label></div>
    <div class="clock-panel"><div class="eyebrow">Time of day · ${escape(zone.resolvedOptions().timeZone)}</div>
    <div id="clock" class="clock">${tod(Date.now())}</div></div></header>
    <div class="bib-search">
    <label>Search bib<input id="bib-search" inputmode="numeric" type="search" autocomplete="off" placeholder="Enter bib number"></label>
    <button id="clear-bib-search" type="button" disabled>Clear</button></div>
    <div class="capture-status"><div id="last" role="status">Tap the runner’s bib as they pass you.</div><span id="pending"></span></div>
    <details class="keypad-options"><summary id="keypad-options-label">Filters and tools</summary>
    <div class="capture-tools"><div class="filters">
    <label>Contest<select id="contest-filter"><option value="">All contests</option>${pass.splits.map((item) => option(item.contestId, contestName(item.contestId))).join("")}</select></label>
    <label>Category<select id="category-filter"></select></label>
    <label>Gender<select id="gender-filter">${genderOptions}</select></label>
    <label>Recording mode<select id="recording-mode"><option value="">All crossings</option><option value="top">Top 10 men and women</option></select></label></div>
    <div class="actions"><button id="local-report">View recorded bibs</button><button id="setup">Change checkpoint</button>
    <button id="clock-check" class="quiet">${escape(clockText())}</button></div></div></details>
    <p id="message" role="status"></p><p id="sync-error" role="status"></p><div id="top-progress" role="status" hidden></div>
    <div id="bib-count" class="eyebrow" role="status"></div><section id="bibs" class="bib-grid" aria-label="Pending bibs"></section>
    <button id="more" hidden>Show more bibs</button></div>`;
  $("active-pass").value = pass.key;
  $("active-pass").onchange = () => {
    pass = point.passes.find((item) => item.key === $("active-pass").value);
    remember();
    renderCapture();
    $("active-pass").focus();
  };
  $("setup").onclick = () => { view = "setup"; remember(); renderSetup(); };
  $("local-report").onclick = () => showReport(false);
  $("clock-check").onclick = async () => {
    try { await checkClock(); if ($("clock-check")) $("clock-check").textContent = clockText(); }
    catch (error) { notice(error); }
  };
  const roster = eligible();
  const bibs = $("bibs");
  const splitIds = new Map(pass.splits.map((split) => [split.contestId, split.id]));
  const assignment = { operator: user.name, event: event.id, point: point.name };
  const keys = new Map(roster.map((runner) => [runner.id, bibKey({
    ...assignment, contestId: runner.contestId, splitId: splitIds.get(runner.contestId), participantId: runner.id,
  })]));
  const search = $("bib-search");
  const clearSearch = $("clear-bib-search");
  let limit = 200;
  const byContest = (runners = roster) => runners.filter((runner) => !$("contest-filter").value || runner.contestId === Number($("contest-filter").value));
  function categories() {
    $("category-filter").innerHTML = '<option value="">All categories</option>' + [...new Set(byContest().map((runner) => runner.category))].sort().map((category) => option(category, category)).join("");
  }
  function grid(reset = true) {
    if (reset) limit = 200;
    const query = search.value.trim();
    clearSearch.disabled = !search.value;
    const selectedGender = $("gender-filter").value;
    const top = $("recording-mode").value === "top";
    $("keypad-options-label").textContent = top || selectedGender || $("contest-filter").value || $("category-filter").value
      ? "Filters and tools · filters on" : "Filters and tools";
    const recorded = new Set(logs.filter((row) => !row.voided && row.event === assignment.event
      && row.point === assignment.point && splitIds.get(row.contestId) === row.splitId).map(bibKey));
    const totals = new Map();
    const counts = new Map();
    const group = (runner) => JSON.stringify([runner.contestId, gender(runner)]);
    if (top) {
      for (const runner of roster) {
        const key = group(runner);
        totals.set(key, (totals.get(key) ?? 0) + 1);
        if (recorded.has(keys.get(runner.id))) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const progress = $("top-progress");
    progress.hidden = !top;
    if (top) {
      progress.innerHTML = '<p>Top 10 progress on this device</p><ul>' + pass.splits
        .filter((split) => !$("contest-filter").value || split.contestId === Number($("contest-filter").value))
        .map(({ contestId }) => {
          const summary = ["Male", "Female"].map((label) => {
            const key = JSON.stringify([contestId, label]);
            const target = Math.min(topLimit, totals.get(key) ?? 0);
            return `${label} ${Math.min(counts.get(key) ?? 0, target)}/${target}`;
          }).join(" · ");
          return `<li><strong>${escape(contestName(contestId))}</strong> · ${summary}</li>`;
        }).join("") + "</ul>" + (roster.some((runner) => runner.sex === undefined)
          ? "<p>Ask race control to re-upload the SES file, then reopen the event to load gender data.</p>" : "");
    }
    const pending = roster.filter((runner) => !recorded.has(keys.get(runner.id)) &&
      (!top || (gender(runner) !== "Unspecified / other" && (counts.get(group(runner)) ?? 0) < topLimit)));
    const list = byContest(pending).filter((runner) => (!$("category-filter").value || runner.category === $("category-filter").value)
      && (!selectedGender || gender(runner) === selectedGender) && String(runner.bib).startsWith(query));
    if (query) {
      list.sort((a, b) => Number(String(b.bib) === query) - Number(String(a.bib) === query));
    }
    $("bib-count").textContent = top ? `${list.length} eligible bibs shown by these filters` : list.length === pending.length
      ? `${pending.length} of ${roster.length} bibs left`
      : `${list.length} matching · ${pending.length} of ${roster.length} bibs left`;
    $("more").hidden = list.length <= limit;
    bibs.innerHTML = list.slice(0, limit).map((runner) => `<button class="bib" data-id="${runner.id}" aria-label="Record bib ${runner.bib}, ${escape(contestName(runner.contestId))}" ${savingBibs.has(keys.get(runner.id)) ? "disabled" : ""}>
      <strong>${runner.bib}</strong><small>${escape(contestName(runner.contestId))}</small></button>`).join("")
      || (pending.length ? "<p>No pending bibs match these filters.</p>" : top
        ? "<p>No eligible bibs left in Top 10 mode.</p>" : "<p>No bibs pending for this split.</p>");
  }
  refreshBibGrid = () => { if (bibs.isConnected) grid(false); };
  $("contest-filter").onchange = () => { categories(); grid(); };
  $("category-filter").onchange = () => grid();
  $("gender-filter").onchange = () => grid();
  $("recording-mode").onchange = () => grid();
  search.oninput = () => grid();
  clearSearch.onclick = () => {
    search.value = "";
    grid();
    search.focus();
  };
  $("more").onclick = () => { limit += 200; grid(false); };
  const runners = new Map(roster.map((runner) => [runner.id, runner]));
  bibs.onclick = async (click) => {
    const at = Date.now();
    const button = click.target.closest(".bib");
    if (!button) return;
    const runner = runners.get(Number(button.dataset.id));
    const key = keys.get(runner.id);
    if (savingBibs.has(key)) return;
    const split = pass.splits.find((item) => item.contestId === runner.contestId);
    const entry = { id: crypto.randomUUID(), participantId: runner.id, contestId: runner.contestId,
      splitId: split.id, point: point.name, event: event.id, operator: user.name, at, voided: false, dirty: true };
    const lane = $("last");
    const queryAtTap = search.value;
    savingBibs.add(key);
    button.disabled = true;
    notice("");
    try {
      await storage("captures", "put", entry);
      if (lane.isConnected) {
        if (search.value === queryAtTap) search.value = "";
        lane.innerHTML = `Bib <strong>${runner.bib}</strong> recorded at <time>${tod(at)}</time> <button class="quiet">Undo</button>`;
        lane.querySelector("button").onclick = async (click) => {
          const undo = click.currentTarget;
          undo.disabled = true;
          try {
            await storage("captures", "put", { ...entry, dirty: true, voided: true });
            if (undo.isConnected) lane.textContent = `Bib ${runner.bib} is back on the list.`;
            await refreshLogs();
            refreshBibGrid();
            void sync();
          } catch (error) {
            undo.disabled = false;
            notice(`Undo could not be saved. ${error.message}`);
          }
        };
      }
      await refreshLogs();
      void sync();
    } catch (error) { notice(`Bib ${runner.bib} could not be saved. ${error.message}`); }
    finally {
      savingBibs.delete(key);
      refreshBibGrid();
    }
  };
  categories();
  grid();
  status();
}

async function showReport(central) {
  const previous = view;
  const reportEvent = event;
  try {
    const rows = central ? await api(`/events/${event.id}/captures`) : (await storage("captures", "getAll"))
      .filter((item) => item.event === event.id && item.operator === user.name);
    if (event !== reportEvent) return;
    const roster = new Map(event.roster.map((item) => [item.id, item]));
    const enriched = rows.map((row) => ({ ...row, bib: roster.get(row.participantId)?.bib ?? "—",
      gender: gender(roster.get(row.participantId)), split: splitName(row.point, row.contestId, row.splitId) }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const ranked = new Map();
    for (const row of enriched) {
      if (row.voided || row.rejected) continue;
      const key = JSON.stringify([row.point, row.splitId, row.contestId, row.gender]);
      if (!ranked.has(key)) ranked.set(key, new Set());
      const participants = ranked.get(key);
      if (participants.has(row.participantId)) continue;
      participants.add(row.participantId);
      row.rank = participants.size;
    }
    view = "report";
    const reportTitle = central ? "Race-control timing report" : "My checkpoint report";
    app.innerHTML = `<div class="report"><div class="page-head"><div class="eyebrow">${escape(event.name)}</div><h1>${reportTitle}</h1></div>
      <div class="capture-tools"><div class="filters"><label>Point / split<select id="report-split"><option value="">All points and splits</option>
      ${[...new Set(enriched.map((item) => item.split))].sort().map((item) => option(item, item)).join("")}</select></label>
      <label>Contest<select id="report-contest"><option value="">All contests</option>${event.contests.map((item) => option(item.id, item.name)).join("")}</select></label>
      <label>Gender<select id="report-gender">${genderOptions}</select></label>
      <label>Ranked crossings<select id="report-limit"><option value="">All observations</option><option value="top">Top 10 men and women</option></select></label></div>
      <div class="actions"><button id="export-report" class="primary">Download CSV</button><button id="print-report">Print report</button><button id="report-back">Back</button></div></div>
      <div id="report-table" class="table-wrap"></div></div>`;
    const visibleRows = () => enriched.filter((item) => (!$("report-split").value || item.split === $("report-split").value)
      && (!$("report-contest").value || item.contestId === Number($("report-contest").value))
      && (!$("report-gender").value || item.gender === $("report-gender").value)
      && (!$("report-limit").value || (item.rank <= topLimit && item.gender !== "Unspecified / other")));
    const header = ["Rank", "Bib", "Contest", "Gender", "Point / split", "Time of day", "Date", "Volunteer", "Status"];
    const timeZone = zone.resolvedOptions().timeZone;
    const date = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone });
    const cells = (row) => [row.rank ?? "", row.bib, contestName(row.contestId), row.gender, row.split, tod(row.at), date.format(row.at), row.operator,
        [row.voided ? "Voided" : "Recorded", row.rejected ? "Sync rejected" : row.dirty ? "Pending sync" : ""].filter(Boolean).join(" · ")];
    function table() {
      const rows = visibleRows();
      $("report-table").innerHTML = `<p>${rows.length} observations · ${escape(zone.resolvedOptions().timeZone)} · Manual backup timing</p>
        <table><thead><tr>${header.map((label) => `<th>${label}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${cells(row).map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    $("report-split").onchange = table;
    $("report-contest").onchange = table;
    $("report-gender").onchange = table;
    $("report-limit").onchange = table;
    $("export-report").onclick = () => {
      const quote = (value) => {
        const field = String(value);
        const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(field) ? "'" + field : field;
        return '"' + safe.replaceAll('"', '""') + '"';
      };
      const csv = [[...header, "Time zone"], ...visibleRows().map((row) => [...cells(row), timeZone])]
        .map((row) => row.map(quote).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "checkpoint-rankings.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $("print-report").onclick = () => {
      $("print").innerHTML = `<h1>${escape(event.name)} · ${reportTitle}</h1>
        <p>${escape($("report-split").value || "All points and splits")} · ${escape($("report-contest").value ? contestName(Number($("report-contest").value)) : "All contests")} · ${escape($("report-gender").value || "All genders")} · ${$("report-limit").value ? "Top 10 men and women" : "All observations"}</p>
        ${$("report-table").innerHTML}`;
      window.print();
    };
    $("report-back").onclick = () => {
      view = previous;
      if (view === "capture") renderCapture(); else renderSetup();
    };
    table();
  } catch (error) { notice(error); }
}

async function initialize() {
  const selection = local.get("timing-selection:" + user.name);
  events = local.get("timing-events:" + user.name, []);
  try {
    await refreshLogs();
    if (selection?.event) {
      const cached = await storage("assignments", "get", `${user.name}:${selection.event}`);
      if (cached) { event = cached.configuration; setZone(event.timezone); }
    }
    point = event?.timingPoints.find((item) => item.name === selection?.point);
    pass = point?.passes.find((item) => item.key === selection?.pass);
    const linkedEvent = sharedAssignment.get("event");
    if (linkedEvent) {
      await loadEvent(linkedEvent);
      if (!events.some((item) => item.id === event.id)) events.unshift({ id: event.id, name: event.name });
      point = event.timingPoints.find((item) => item.name === sharedAssignment.get("point") && item.passes.length);
      pass = point?.passes.length === 1 ? point.passes[0] : null;
      if (point) local.set("timing-selection:" + user.name, { event: event.id, point: point.name, pass: pass?.key, view: "setup" });
      sharedAssignment.delete("event");
      sharedAssignment.delete("point");
      history.replaceState(null, "", "/");
    }
    if (!linkedEvent && pass && selection?.view === "capture") {
      view = "capture";
      logout.hidden = false;
      renderCapture();
    } else renderSetup();
    void refreshEvents().then(() => {
      if (view !== "setup" || !$("event")) return;
      $("event").innerHTML = '<option value="">Choose an event</option>' + events.map((item) => option(item.id, item.name)).join("");
      $("event").value = event?.id ?? "";
    });
  } catch (error) {
    renderSetup();
    notice(sharedAssignment.has("event") ? `Could not open the shared assignment. ${error.message}` : `Device storage unavailable. ${error.message}`);
  }
  void checkClock().then(() => { if ($("clock-check")) $("clock-check").textContent = clockText(); }).catch(() => {});
  void sync();
}

logout.onclick = async () => {
  if (navigator.onLine) await api("/logout", { method: "POST" }).catch(() => {});
  user = null;
  event = null;
  point = null;
  pass = null;
  logs = [];
  view = "setup";
  localStorage.removeItem("timing-user");
  renderLogin();
};
addEventListener("online", () => { status(); void sync(); });
addEventListener("offline", status);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
setInterval(() => { if (!document.hidden) void sync(); }, 5000);
function updateClock() {
  const clock = $("clock");
  if (clock) clock.textContent = tod(Date.now());
  requestAnimationFrame(updateClock);
}
requestAnimationFrame(updateClock);
function offlineText() {
  if (!("serviceWorker" in navigator)) return "Ask race control for a secure link to use this app offline.";
  return navigator.serviceWorker.controller ? "Ready to use offline." : "Stay online while we prepare offline access…";
}
if ("serviceWorker" in navigator) {
  const update = () => { if ($("offline-state")) $("offline-state").textContent = offlineText(); };
  navigator.serviceWorker.addEventListener("controllerchange", update);
  navigator.serviceWorker.register("/sw.js").catch(() => {
    if ($("offline-state")) $("offline-state").textContent = "Offline reload could not be prepared.";
  });
}
status();
if (user) void initialize(); else renderLogin();
