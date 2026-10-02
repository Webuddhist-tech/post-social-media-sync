// Post Sync dashboard — plain JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder. Strings become text nodes (never HTML), so user content is always escaped. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const BADGE = { instagram: "IG", facebook: "f", tiktok: "TT", youtube: "▶", linkedin: "in", threads: "@", x: "X", bluesky: "B" };
const badge = (platform) => h("span", { class: `pbadge p-${platform}`, title: platformName(platform) }, BADGE[platform] ?? "?");

const SETUP_NOTES = {
  meta: [
    "Create an app at developers.facebook.com (use case: manage everything on your Page, plus Instagram).",
    "Instagram must be a Professional (Business or Creator) account linked to a Facebook Page.",
    "Until Meta approves the app (App Review), only people with a role on the app can connect.",
  ],
  tiktok: [
    "Add the Login Kit and Content Posting API products; turn on Direct Post.",
    "Until TikTok audits your app, posts can only be private (\"Only me\") — or use \"Send to TikTok inbox\".",
  ],
  google: [
    "Enable \"YouTube Data API v3\" and create an OAuth client of type Web application.",
    "While the consent screen is in Testing, add yourself as a test user (logins then expire after 7 days).",
    "Videos from unverified API projects are forced to private until Google audits the project.",
  ],
  linkedin: [
    "Add the products \"Sign In with LinkedIn using OpenID Connect\" and \"Share on LinkedIn\".",
    "To post as a Company Page you also need the Community Management API and LINKEDIN_ORGANIZATIONS=true.",
  ],
  threads: [
    "Create a Meta app with the Threads use case and permissions threads_basic + threads_content_publish.",
    "Photo/video posts need PUBLIC_BASE_URL to be reachable from the internet.",
  ],
  x: [
    "Create an app in the X developer portal with OAuth 2.0 (Web App, Read and write).",
    "Posting through the X API requires a paid API plan.",
  ],
  bluesky: ["No developer app needed. Create an app password in Bluesky → Settings → Privacy and security."],
};

const state = {
  meta: null,
  accounts: [],
  media: [], // uploaded items, or { tempId, uploading: true, name, progress }
  selected: new Set(loadJSON("selected", [])),
  options: loadJSON("options", {}),
  overrides: {},
  posts: [],
  nextBefore: null,
  pollTimer: null,
  validateTimer: null,
  issues: [],
  validating: false,
};

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`postsync.${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(`postsync.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

// ---- API -------------------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Please log in again.");
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, kind = "") {
  const el = h("div", { class: `toast ${kind}` }, message);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 9000 : 4500);
}

/** Starts an OAuth login; the server sends the browser back to the Accounts tab afterwards. */
const connectUrl = (connector) => `/api/connect/${encodeURIComponent(connector)}?returnTo=${encodeURIComponent("/#accounts")}`;

const platformName = (id) => state.meta?.platforms.find((p) => p.id === id)?.name ?? id;
const platformInfo = (id) => state.meta?.platforms.find((p) => p.id === id);
const fmtTime = (ms) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
const fmtSize = (bytes) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

// ---- text length (mirrors src/text.ts) ----------------------------------------------

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (text) => (segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : [...text]);
const EMOJI = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return /\p{Extended_Pictographic}/u; // older browsers
  }
})();
const utf8 = new TextEncoder();

/** Approximately how each platform counts characters (the server does the exact check). */
function measure(platform, text) {
  if (platform === "x") {
    // Links count 23, each emoji 2, most non-Latin characters 2.
    let n = 0;
    const rest = text.normalize("NFC").replace(/https?:\/\/[^\s<>"]+/gi, () => {
      n += 23;
      return "";
    });
    for (const g of graphemes(rest)) {
      if (EMOJI.test(g)) {
        n += 2;
        continue;
      }
      for (const ch of g) {
        const cp = ch.codePointAt(0);
        const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
        n += light ? 1 : 2;
      }
    }
    return n;
  }
  if (platform === "bluesky") return graphemes(text).length;
  if (platform === "threads") return graphemes(text).reduce((n, g) => n + (EMOJI.test(g) ? utf8.encode(g).length : [...g].length), 0);
  if (platform === "tiktok") return text.length;
  return [...text].length;
}

// ---- login -------------------------------------------------------------------------

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-form input").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = new FormData(e.target).get("password");
  const errEl = $("#login-error");
  errEl.hidden = true;
  try {
    await api("/login", { method: "POST", body: { password } });
    e.target.reset();
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---- routing -----------------------------------------------------------------------

function route() {
  const [view = "compose", query = ""] = location.hash.slice(1).split("?");
  const name = ["compose", "history", "accounts", "setup"].includes(view) ? view : "compose";
  for (const v of $$(".view")) v.hidden = v.id !== `view-${name}`;
  for (const a of $$("#tabs a")) a.classList.toggle("active", a.dataset.view === name);

  // After an OAuth login the server sends the browser back with ?postsync=connected|error&connector=…
  const result = new URLSearchParams(location.search);
  const outcome = result.get("postsync");
  if (outcome === "connected") {
    const n = Number(result.get("count") ?? 1);
    toast(`Connected ${n} ${result.get("connector")} account${n === 1 ? "" : "s"}.`, "ok");
  }
  if (outcome === "error") toast(result.get("error") ?? "Connecting failed.", "bad");
  if (outcome || query) history.replaceState(null, "", `${location.pathname}#${name}`);

  clearTimeout(state.pollTimer);
  if (name === "history") loadPosts();
  if (name === "accounts") renderAccounts();
  if (name === "setup") renderSetup();
  if (name === "compose") renderCompose();
}
window.addEventListener("hashchange", route);

async function boot() {
  const [meta, { accounts }] = await Promise.all([api("/meta"), api("/accounts")]);
  state.meta = meta;
  state.options = forgetOneOffOptions(state.options);
  state.accounts = accounts;
  // Forget selections for accounts that no longer exist.
  state.selected = new Set([...state.selected].filter((id) => accounts.some((a) => a.id === id && a.status === "active")));
  $("#login").hidden = true;
  $("#app").hidden = false;
  route();
}

async function refreshAccounts() {
  state.accounts = (await api("/accounts")).accounts;
}

// ---- compose -----------------------------------------------------------------------

function selectedAccounts() {
  return state.accounts.filter((a) => state.selected.has(a.id));
}
function selectedPlatforms() {
  const order = state.meta.platforms.map((p) => p.id);
  return [...new Set(selectedAccounts().map((a) => a.platform))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
/** Platform options that must not carry over to the next post (e.g. TikTok privacy, per TikTok's rules). */
function forgetOneOffOptions(options) {
  const out = {};
  for (const [platform, values] of Object.entries(options ?? {})) {
    const fields = platformInfo(platform)?.options ?? [];
    out[platform] = Object.fromEntries(Object.entries(values).filter(([k]) => fields.find((f) => f.key === k)?.remember !== false));
  }
  return out;
}

function saveOptions() {
  saveJSON("options", forgetOneOffOptions(state.options));
}

function optionValue(platform, field) {
  const v = state.options[platform]?.[field.key];
  return v === undefined ? field.default : v;
}

function renderCompose() {
  renderPicker();
  renderMedia();
  renderPlatformDependent();
}

function renderPicker() {
  const box = $("#account-picker");
  box.replaceChildren();
  if (state.accounts.length === 0) {
    box.append(h("div", { class: "empty" }, "No accounts connected yet. ", h("a", { href: "#accounts" }, "Connect your first account →")));
    $("#select-all").hidden = true;
    return;
  }
  $("#select-all").hidden = false;
  const order = state.meta.platforms.map((p) => p.id);
  const accounts = [...state.accounts].sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform) || a.name.localeCompare(b.name));
  for (const a of accounts) {
    const disabled = a.status !== "active";
    const on = state.selected.has(a.id);
    const input = h("input", { type: "checkbox", checked: on, disabled });
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(a.id);
      else state.selected.delete(a.id);
      saveJSON("selected", [...state.selected]);
      label.classList.toggle("on", input.checked);
      renderPlatformDependent();
    });
    const label = h(
      "label",
      { class: `pick${on ? " on" : ""}${disabled ? " disabled" : ""}` },
      input,
      avatar(a),
      h(
        "span",
        { class: "who" },
        h("strong", {}, a.name),
        h("small", {}, platformName(a.platform), a.username ? ` · @${a.username.replace(/^@/, "")}` : "", disabled ? " · needs reconnect" : ""),
      ),
    );
    box.append(label);
  }
}

$("#select-all").addEventListener("click", () => {
  const active = state.accounts.filter((a) => a.status === "active");
  const all = active.every((a) => state.selected.has(a.id));
  state.selected = new Set(all ? [] : active.map((a) => a.id));
  saveJSON("selected", [...state.selected]);
  renderPicker();
  renderPlatformDependent();
});

function avatar(a) {
  const initials = () => h("span", { class: "avatar avatar-initial" }, (a.name.trim()[0] ?? "?").toUpperCase());
  const img = a.avatarUrl
    ? h("img", { class: "avatar", src: a.avatarUrl, alt: "", referrerpolicy: "no-referrer", loading: "lazy" })
    : initials();
  if (img.tagName === "IMG") img.addEventListener("error", () => img.replaceWith(initials()));
  return h("span", { class: "avatar-wrap" }, img, badge(a.platform));
}

/** Everything that depends on which platforms are selected. */
function renderPlatformDependent() {
  const platforms = selectedPlatforms();
  const hasVideo = state.media.some((m) => m.kind === "video");

  // Title: YouTube always, Facebook/LinkedIn for videos.
  const needsTitle = platforms.includes("youtube") || (hasVideo && platforms.some((p) => p === "facebook" || p === "linkedin"));
  $("#title-field").hidden = !needsTitle;
  $("#title-hint").textContent = platforms.includes("youtube") ? "— defaults to the first line of the caption" : "(optional)";

  // Per-platform options.
  const opts = $("#platform-options");
  opts.replaceChildren();
  for (const id of platforms) {
    const p = platformInfo(id);
    if (!p.options.length) continue;
    const group = h("div", { class: "opt-group" }, h("h3", {}, badge(id), p.name));
    for (const f of p.options) group.append(optionField(id, f));
    opts.append(group);
  }
  $("#options-card").hidden = opts.children.length === 0;

  // Caption overrides.
  const ov = $("#override-fields");
  const open = $("#overrides").open;
  ov.replaceChildren();
  for (const id of platforms) {
    const ta = h("textarea", { rows: 3, placeholder: "Leave empty to use the main caption" });
    ta.value = state.overrides[id] ?? "";
    ta.addEventListener("input", () => {
      state.overrides[id] = ta.value;
      renderCounters();
      scheduleValidate();
    });
    ov.append(h("label", { class: "field" }, h("span", {}, badge(id), " ", platformInfo(id).name), ta));
  }
  $("#overrides").open = open;
  $("#overrides-card").hidden = platforms.length < 2;

  renderCounters();
  scheduleValidate();
}

function optionField(platform, f) {
  const set = (value) => {
    state.options[platform] = { ...state.options[platform], [f.key]: value };
    saveOptions();
    renderCounters();
    scheduleValidate();
  };
  const value = optionValue(platform, f);
  if (f.type === "checkbox") {
    const input = h("input", { type: "checkbox", checked: !!value });
    input.addEventListener("change", () => set(input.checked));
    return h("label", { class: "checkbox" }, input, f.label, f.help ? h("span", { class: "help" }, ` — ${f.help}`) : null);
  }
  if (f.type === "select") {
    // Options without a default (e.g. TikTok privacy) start on "Choose…" so the person picks deliberately.
    const placeholder = value === undefined || value === null ? h("option", { value: "", selected: true, disabled: true }, "Choose…") : null;
    const select = h("select", {}, placeholder, f.choices.map((c) => h("option", { value: c.value, selected: c.value === value }, c.label)));
    select.addEventListener("change", () => set(select.value));
    return h("label", { class: "field" }, h("span", {}, f.label), select, f.help ? h("span", { class: "help" }, f.help) : null);
  }
  const input = h("input", { type: "text", value: value ?? "" });
  input.addEventListener("input", () => set(input.value));
  return h("label", { class: "field" }, h("span", {}, f.label), input);
}

const lengthKey = () => JSON.stringify([$("#text").value, state.overrides]);

function renderCounters() {
  const text = $("#text").value;
  const box = $("#counters");
  box.replaceChildren();
  for (const id of selectedPlatforms()) {
    const p = platformInfo(id);
    const own = state.overrides[id]?.trim() ? state.overrides[id] : text;
    const max = id === "x" && optionValue("x", { key: "premium", default: false }) ? 25000 : p.capabilities.maxTextLength;
    const server = state.serverLengths?.key === lengthKey() ? state.serverLengths.byPlatform[id] : undefined;
    const n = typeof server === "number" ? server : measure(id, own.trim());
    box.append(h("span", { class: `counter${n > max ? " over" : ""}` }, `${p.name} ${n.toLocaleString()}/${max.toLocaleString()}`));
  }
}

$("#text").addEventListener("input", () => {
  renderCounters();
  scheduleValidate();
});
$("#title").addEventListener("input", scheduleValidate);

for (const r of $$('input[name="when"]')) {
  r.addEventListener("change", () => {
    const later = $('input[name="when"]:checked').value === "later";
    const input = $("#scheduled-at");
    input.hidden = !later;
    if (later && !input.value) {
      const d = new Date(Date.now() + 3600_000);
      d.setMinutes(0, 0, 0);
      input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    updatePublishButton();
  });
}

function buildRequest() {
  const platforms = selectedPlatforms();
  const later = $('input[name="when"]:checked').value === "later";
  const platformOptions = {};
  const platformText = {};
  for (const id of platforms) {
    platformOptions[id] = Object.fromEntries(platformInfo(id).options.map((f) => [f.key, optionValue(id, f)]));
    if (state.overrides[id]?.trim()) platformText[id] = state.overrides[id];
  }
  const when = $("#scheduled-at").value;
  return {
    text: $("#text").value,
    title: $("#title-field").hidden ? null : $("#title").value || null,
    mediaIds: state.media.filter((m) => !m.uploading).map((m) => m.id),
    targets: selectedAccounts().map((a) => ({ accountId: a.id })),
    platformOptions,
    platformText,
    scheduledAt: later && when ? new Date(when).toISOString() : null,
  };
}

function scheduleValidate() {
  clearTimeout(state.validateTimer);
  state.validating = true;
  updatePublishButton();
  state.validateTimer = setTimeout(validate, 350);
}

async function validate() {
  const req = buildRequest();
  if (!req.targets.length || (!req.text.trim() && !req.mediaIds.length)) {
    state.issues = [];
    state.validating = false;
    renderIssues();
    return;
  }
  const key = lengthKey();
  try {
    const { issues } = await api("/posts/validate", { method: "POST", body: req });
    state.issues = issues.filter((i) => i.errors.length);
    // The server counts exactly like each platform (X's rules are complex); prefer its numbers while still current.
    state.serverLengths = { key, byPlatform: Object.fromEntries(issues.map((i) => [i.platform, i.length])) };
    renderCounters();
  } catch (err) {
    state.issues = [{ accountName: "Check failed", platform: "", errors: [err.message] }];
  }
  state.validating = false;
  renderIssues();
}

function renderIssues() {
  const box = $("#issues");
  box.replaceChildren();
  box.hidden = state.issues.length === 0;
  if (state.issues.length) {
    box.append(h("div", {}, "Fix these before publishing:"));
    box.append(
      h(
        "ul",
        {},
        state.issues.flatMap((i) => i.errors.map((e) => h("li", {}, h("strong", {}, i.accountName), i.platform ? ` (${platformName(i.platform)})` : "", ": ", e))),
      ),
    );
  }
  updatePublishButton();
}

function updatePublishButton() {
  const btn = $("#publish");
  const uploading = state.media.some((m) => m.uploading);
  const hasContent = $("#text").value.trim() || state.media.some((m) => !m.uploading);
  const later = $('input[name="when"]:checked').value === "later";
  btn.disabled = !state.selected.size || uploading || !hasContent || state.validating || state.issues.length > 0;
  const n = state.selected.size;
  btn.textContent = uploading
    ? "Waiting for uploads…"
    : `${later ? "Schedule" : "Publish"}${n ? ` to ${n} account${n === 1 ? "" : "s"}` : ""}`;
}

$("#publish").addEventListener("click", async () => {
  const btn = $("#publish");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const req = buildRequest();
    await api("/posts", { method: "POST", body: req });
    toast(req.scheduledAt ? `Scheduled for ${fmtTime(Date.parse(req.scheduledAt))}.` : "Publishing started. Track it here.", "ok");
    $("#text").value = "";
    $("#title").value = "";
    state.media = [];
    state.overrides = {};
    state.options = forgetOneOffOptions(state.options);
    $('input[name="when"][value="now"]').checked = true;
    $("#scheduled-at").hidden = true;
    $("#scheduled-at").value = "";
    location.hash = "#history";
  } catch (err) {
    const issues = err.data?.issues;
    if (issues) {
      state.issues = issues.filter((i) => i.errors.length);
      renderIssues();
    }
    toast(err.message, "bad");
    updatePublishButton();
  }
});

// ---- media -------------------------------------------------------------------------

const dropzone = $("#dropzone");
const fileInput = $("#file-input");
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  for (const f of fileInput.files) upload(f);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  for (const f of e.dataTransfer.files) upload(f);
});
document.addEventListener("paste", (e) => {
  if ($("#view-compose").hidden) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    files.forEach(upload);
  }
});

function upload(file) {
  const supported = state.meta.supportedMimeTypes;
  if (file.type && !supported.includes(file.type)) {
    toast(`${file.name}: unsupported file type (${file.type}).`, "bad");
    return;
  }
  if (file.size > state.meta.maxUploadMb * 1024 * 1024) {
    toast(`${file.name} is larger than the ${state.meta.maxUploadMb} MB limit.`, "bad");
    return;
  }
  const temp = { tempId: crypto.randomUUID(), uploading: true, name: file.name, progress: 0 };
  state.media.push(temp);
  renderMedia();

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/media");
  xhr.upload.addEventListener("progress", (e) => {
    if (!e.lengthComputable) return;
    temp.progress = e.loaded / e.total;
    const bar = $(`[data-temp="${temp.tempId}"] .progress > div`);
    if (bar) bar.style.width = `${Math.round(temp.progress * 100)}%`;
  });
  const finish = (item, error) => {
    const i = state.media.indexOf(temp);
    if (i >= 0) {
      if (item) state.media[i] = item;
      else state.media.splice(i, 1);
    }
    if (error) toast(error, "bad");
    renderMedia();
    renderPlatformDependent();
  };
  xhr.addEventListener("load", () => {
    let data = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      /* ignore */
    }
    if (xhr.status === 401) {
      finish(null, "Please log in again.");
      showLogin();
    } else if (xhr.status >= 200 && xhr.status < 300) finish(data.media[0]);
    else finish(null, `${file.name}: ${data?.error ?? `upload failed (${xhr.status})`}`);
  });
  xhr.addEventListener("error", () => finish(null, `${file.name}: upload failed (network error).`));
  const form = new FormData();
  form.append("file", file, file.name);
  xhr.send(form);
  updatePublishButton();
}

/** Image thumbnail, or a video's poster frame with a play marker (falls back to the <video> itself). */
function thumb(m) {
  if (m.kind !== "video") return h("img", { src: m.thumbnailUrl ?? m.url, alt: m.filename ?? "" });
  const visual = m.thumbnailUrl
    ? h("img", { src: m.thumbnailUrl, alt: m.filename ?? "" })
    : h("video", { src: `${m.url}#t=0.1`, muted: true, preload: "metadata", playsinline: true });
  return h("span", { class: "thumb-video" }, visual, h("span", { class: "play" }, "▶"));
}

function renderMedia() {
  const list = $("#media-list");
  list.replaceChildren();
  state.media.forEach((m, i) => {
    if (m.uploading) {
      list.append(
        h(
          "div",
          { class: "media-item uploading", dataset: { temp: m.tempId } },
          h("span", {}, `Uploading ${m.name}…`),
          h("div", { class: "progress" }, h("div", { style: `width:${Math.round(m.progress * 100)}%` })),
        ),
      );
      return;
    }
    const preview = thumb(m);
    const info = [
      m.kind === "video" && m.duration ? `${Math.round(m.duration)}s` : null,
      m.width && m.height ? `${m.width}×${m.height}` : null,
      fmtSize(m.size),
    ].filter(Boolean);
    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= state.media.length) return;
      [state.media[i], state.media[j]] = [state.media[j], state.media[i]];
      renderMedia();
      scheduleValidate();
    };
    list.append(
      h(
        "div",
        { class: "media-item", title: m.filename },
        preview,
        state.media.length > 1
          ? h(
              "div",
              { class: "order" },
              i > 0 ? h("button", { type: "button", title: "Move left", onclick: () => move(-1) }, "←") : null,
              i < state.media.length - 1 ? h("button", { type: "button", title: "Move right", onclick: () => move(1) }, "→") : null,
            )
          : null,
        h(
          "button",
          {
            type: "button",
            class: "remove",
            title: "Remove",
            onclick: () => {
              state.media.splice(i, 1);
              renderMedia();
              renderPlatformDependent();
            },
          },
          "×",
        ),
        h("div", { class: "meta" }, info.join(" · ")),
      ),
    );
  });
  updatePublishButton();
}

// ---- history -----------------------------------------------------------------------

async function loadPosts(append = false) {
  clearTimeout(state.pollTimer);
  try {
    const before = append && state.nextBefore ? `&before=${state.nextBefore}` : "";
    const { posts, nextBefore } = await api(`/posts?limit=20${before}`);
    state.posts = append ? [...state.posts, ...posts] : posts;
    state.nextBefore = nextBefore;
    renderPosts();
  } catch (err) {
    toast(err.message, "bad");
  }
  schedulePoll();
}

/** Refreshes while anything is publishing (or about to). */
function schedulePoll() {
  clearTimeout(state.pollTimer);
  if ($("#view-history").hidden) return;
  const now = Date.now();
  const active = state.posts.some((p) =>
    p.targets.some((t) => t.status === "running" || (t.status === "queued" && t.runAt - now < 120_000)),
  );
  state.pollTimer = setTimeout(() => refreshVisiblePosts(), active ? 2500 : 30_000);
}

async function refreshVisiblePosts() {
  try {
    const { posts } = await api(`/posts?limit=${Math.max(20, state.posts.length)}`);
    state.posts = posts;
    renderPosts();
  } catch {
    /* keep showing what we have */
  }
  schedulePoll();
}

$("#load-more").addEventListener("click", () => loadPosts(true));

function renderPosts() {
  const list = $("#post-list");
  list.replaceChildren();
  if (state.posts.length === 0) {
    list.append(h("div", { class: "card empty" }, "Nothing posted yet. ", h("a", { href: "#compose" }, "Write your first post →")));
  }
  for (const p of state.posts) list.append(postCard(p));
  $("#load-more").hidden = !state.nextBefore;
}

function postCard(p) {
  const thumbs = h(
    "div",
    { class: "post-thumbs" },
    p.media.slice(0, 4).map((m) => (m.kind === "missing" ? h("div", { class: "thumb-missing" }) : thumb(m))),
  );
  const counts = p.targets.reduce((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {});
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ");
  const busy = p.targets.some((t) => t.status === "running");

  return h(
    "article",
    { class: "card post" },
    h(
      "div",
      { class: "post-head" },
      h("div", { class: "post-text clamp" }, p.title ? h("strong", {}, p.title, h("br")) : null, p.text || h("span", { class: "muted" }, "(no caption)")),
      p.media.length ? thumbs : null,
    ),
    h(
      "div",
      { class: "post-meta" },
      h("span", {}, p.scheduledAt ? `Scheduled for ${fmtTime(p.scheduledAt)}` : `Created ${fmtTime(p.createdAt)}`),
      h("span", {}, summary),
      busy
        ? null
        : h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              title: "Removes it from this list (doesn't delete it from the platforms)",
              onclick: async () => {
                if (!confirm("Remove this post from the history? Queued posts are cancelled. Already published posts stay online.")) return;
                try {
                  await api(`/posts/${p.id}`, { method: "DELETE" });
                  loadPosts();
                } catch (err) {
                  toast(err.message, "bad");
                }
              },
            },
            "Remove",
          ),
    ),
    h("div", { class: "targets" }, p.targets.map(targetRow)),
  );
}

function targetRow(t) {
  const statusLabel = { queued: "queued", running: "posting", succeeded: "posted", failed: "failed", cancelled: "cancelled" }[t.status];
  let msg = null;
  if (t.status === "running") msg = h("div", { class: "msg" }, h("span", { class: "spinner" }), " ", t.progress ?? "Working…");
  else if (t.status === "queued" && t.runAt > Date.now() + 5000) msg = h("div", { class: "msg" }, `Scheduled for ${fmtTime(t.runAt)}`, t.error ? ` — last error: ${t.error}` : "");
  else if (t.status === "queued") msg = h("div", { class: "msg" }, t.error ?? "Waiting to start…");
  else if (t.status === "failed") msg = h("div", { class: "msg err" }, t.error ?? "Failed");
  else if (t.status === "succeeded" && t.progress) msg = h("div", { class: "msg" }, t.progress);

  const actions = h("div", { class: "actions" });
  if (t.status === "succeeded" && t.remoteUrl) {
    actions.append(h("a", { class: "btn btn-sm", href: t.remoteUrl, target: "_blank", rel: "noopener" }, "View ↗"));
  }
  if (t.status === "failed" || t.status === "cancelled") {
    actions.append(
      h("button", { class: "btn btn-sm", type: "button", onclick: () => targetAction(t, "retry") }, "Retry"),
    );
  }
  if (t.status === "queued") {
    actions.append(
      h("button", { class: "btn btn-ghost btn-sm btn-danger", type: "button", onclick: () => targetAction(t, "cancel") }, "Cancel"),
    );
  }
  actions.append(h("span", { class: `status s-${t.status}` }, statusLabel));

  return h(
    "div",
    { class: "target" },
    badge(t.platform),
    h("div", { class: "detail" }, h("strong", {}, t.accountName), msg),
    actions,
  );
}

async function targetAction(t, action) {
  try {
    await api(`/targets/${t.id}/${action}`, { method: "POST" });
    refreshVisiblePosts();
  } catch (err) {
    toast(err.message, "bad");
  }
}

// ---- accounts ----------------------------------------------------------------------

async function renderAccounts() {
  await refreshAccounts().catch((err) => toast(err.message, "bad"));
  const list = $("#account-list");
  list.replaceChildren();
  if (!state.accounts.length) list.append(h("div", { class: "empty" }, "No accounts yet. Connect one below."));
  for (const a of state.accounts) {
    const connector = state.meta.connectors.find((c) => c.id === a.connector);
    list.append(
      h(
        "div",
        { class: "account-row" },
        avatar(a),
        h(
          "div",
          { class: "who" },
          h("strong", {}, a.name),
          h("small", { class: "muted" }, platformName(a.platform), a.username ? ` · @${a.username.replace(/^@/, "")}` : ""),
          a.status !== "active" ? h("div", { class: "help", style: "color:var(--bad)" }, a.statusMessage ?? "Needs to be reconnected") : null,
        ),
        a.status === "active" ? h("span", { class: "tag tag-ok" }, "Active") : h("span", { class: "tag tag-bad" }, "Reconnect"),
        h(
          "button",
          {
            class: "btn btn-sm",
            type: "button",
            title: "Checks that the login still works, without posting anything",
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.textContent = "Testing…";
              try {
                const res = await api(`/accounts/${a.id}/check`, { method: "POST" });
                if (res.ok) toast(`${a.name} (${platformName(a.platform)}): ${res.detail}`, "ok");
                else toast(`${a.name} (${platformName(a.platform)}): ${res.error}`, "bad");
                if (res.ok === (a.status !== "active") || res.needsReconnect) await renderAccounts();
              } catch (err) {
                toast(err.message, "bad");
              } finally {
                btn.disabled = false;
                btn.textContent = "Test";
              }
            },
          },
          "Test",
        ),
        a.status !== "active" && connector?.kind === "oauth"
          ? h("a", { class: "btn btn-sm", href: connectUrl(a.connector) }, "Reconnect")
          : null,
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm btn-danger",
            type: "button",
            onclick: async () => {
              if (!confirm(`Disconnect ${a.name} (${platformName(a.platform)})?`)) return;
              try {
                await api(`/accounts/${a.id}`, { method: "DELETE" });
                state.selected.delete(a.id);
                saveJSON("selected", [...state.selected]);
                renderAccounts();
              } catch (err) {
                toast(err.message, "bad");
              }
            },
          },
          "Disconnect",
        ),
      ),
    );
  }

  const connect = $("#connect-list");
  connect.replaceChildren();
  for (const c of state.meta.connectors) {
    const card = h(
      "div",
      { class: "connector" },
      h("div", { class: "row" }, h("span", { class: "badges" }, c.platforms.map(badge)), h("strong", {}, c.name)),
    );
    if (c.kind === "credentials") {
      const form = h(
        "form",
        {},
        c.credentialFields.map((f) =>
          h(
            "label",
            { class: "field" },
            h("span", {}, f.label),
            h("input", { name: f.key, type: f.type, placeholder: f.placeholder ?? "", required: f.required, autocomplete: "off" }),
            f.help ? h("span", { class: "help" }, f.help) : null,
          ),
        ),
        h("button", { class: "btn btn-primary btn-block", type: "submit" }, `Connect ${c.name}`),
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector("button");
        btn.disabled = true;
        try {
          const fields = Object.fromEntries(new FormData(form));
          const res = await api(`/connect/${c.id}/credentials`, { method: "POST", body: { fields } });
          toast(`Connected ${res.accounts.map((a) => a.name).join(", ")}.`, "ok");
          form.reset();
          renderAccounts();
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          btn.disabled = false;
        }
      });
      card.append(form);
    } else if (c.configured) {
      card.append(h("a", { class: "btn btn-primary btn-block", href: connectUrl(c.id) }, `Connect ${c.name}`));
    } else {
      card.append(
        h("button", { class: "btn btn-block", type: "button", disabled: true }, "Not set up yet"),
        h("span", { class: "help" }, "Add ", c.envVars.map((v, i) => [i ? " and " : "", h("code", {}, v)]), " to .env. ", h("a", { href: "#setup" }, "How →")),
      );
    }
    connect.append(card);
  }
}

// ---- setup -------------------------------------------------------------------------

function renderSetup() {
  const m = state.meta;
  const copyable = (text) =>
    h(
      "span",
      {
        class: "copy mono",
        title: "Click to copy",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("Copied.");
          } catch {
            toast(text);
          }
        },
      },
      text,
    );

  $("#server-status").replaceChildren(
    h("h2", {}, "Server"),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Public URL"),
      h("dd", {}, copyable(m.publicBaseUrl)),
      h("dt", {}, "Reachable by platforms"),
      h(
        "dd",
        {},
        m.publicMediaReachable
          ? h("span", { class: "tag tag-ok" }, "Looks public")
          : [
              h("span", { class: "tag tag-bad" }, "Private address"),
              " Instagram (photos) and Threads (photos and videos) download media from this URL, so it must be reachable from the internet. Set PUBLIC_BASE_URL to your domain or a tunnel (cloudflared / ngrok).",
            ],
      ),
      h("dt", {}, "ffmpeg"),
      h(
        "dd",
        {},
        m.ffmpeg
          ? h("span", { class: "tag tag-ok" }, "Installed")
          : [h("span", { class: "tag tag-bad" }, "Missing"), " Install ffmpeg to auto-convert images and check video length/size."],
      ),
      h("dt", {}, "Upload limit"),
      h("dd", {}, `${m.maxUploadMb} MB`),
    ),
  );

  const list = $("#setup-list");
  list.replaceChildren();
  for (const c of m.connectors) {
    list.append(
      h(
        "div",
        { class: "card setup-item" },
        h(
          "div",
          { class: "row" },
          h("span", { class: "badges" }, c.platforms.map(badge)),
          h("h2", {}, c.name),
          c.kind === "credentials"
            ? h("span", { class: "tag tag-ok" }, "Ready")
            : c.configured
              ? h("span", { class: "tag tag-ok" }, "Configured")
              : h("span", { class: "tag tag-muted" }, "Not configured"),
        ),
        h("ul", { class: "muted" }, (SETUP_NOTES[c.id] ?? []).map((n) => h("li", {}, n))),
        c.kind === "oauth"
          ? h(
              "dl",
              { class: "kv" },
              h("dt", {}, ".env keys"),
              h("dd", {}, c.envVars.map((v, i) => [i ? ", " : "", h("code", {}, v)])),
              h("dt", {}, "Redirect URI"),
              h("dd", {}, copyable(c.redirectUri)),
              c.developerPortal ? [h("dt", {}, "Developer portal"), h("dd", {}, h("a", { href: c.developerPortal, target: "_blank", rel: "noopener" }, c.developerPortal))] : null,
            )
          : null,
      ),
    );
  }
}

// ---- start -------------------------------------------------------------------------

(async () => {
  try {
    const { authenticated } = await api("/session");
    if (authenticated) await boot();
    else showLogin();
  } catch (err) {
    showLogin();
  }
})();
