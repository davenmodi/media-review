/* Media Review — gallery, comments, versions, approvals.
   Plain JS, no build step. Backend: Supabase (or local demo mode). */
(() => {
  "use strict";

  const cfg = window.REVIEW_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
  const MAX_MB = DEMO ? 3 : (cfg.MAX_UPLOAD_MB || 50);

  const STATUS = {
    in_review:          "In Review",
    ready_for_approval: "Ready for Approval",
    changes_requested:  "Changes Requested",
    approved:           "Approved",
  };
  const STATUS_ORDER = ["ready_for_approval", "in_review", "changes_requested", "approved"];

  // ---------- small utilities ------------------------------------------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^(https?:|data:|blob:)/i.test(String(u || "")) ? u : "#");
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const badge = (status) => `<span class="badge s-${esc(status)}">${esc(STATUS[status] || status)}</span>`;

  function timeAgo(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  const fullDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  function mediaTypeFromFile(file) {
    const t = file.type || "";
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("video/")) return "video";
    if (t === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
    return "file";
  }
  function mediaTypeFromLink(url) {
    const path = url.split(/[?#]/)[0];
    if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) return "image";
    if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return "video";
    if (/\.pdf$/i.test(path)) return "pdf";
    return "link";
  }
  function youtubeId(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
    return m ? m[1] : null;
  }
  function driveId(url) {
    if (!/drive\.google\.com|docs\.google\.com/i.test(url)) return null;
    const m = String(url).match(/\/d\/([\w-]+)/) || String(url).match(/[?&]id=([\w-]+)/);
    return m ? m[1] : null;
  }

  const store = {
    get name() { try { return localStorage.getItem("mr_name") || ""; } catch { return ""; } },
    set name(v) { try { localStorage.setItem("mr_name", v); } catch {} },
    get approver() { try { return JSON.parse(sessionStorage.getItem("mr_approver") || "null"); } catch { return null; } },
    set approver(v) { try { v ? sessionStorage.setItem("mr_approver", JSON.stringify(v)) : sessionStorage.removeItem("mr_approver"); } catch {} },
  };

  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2500);
  }
  const errMsg = (e) => (e && (e.message || e.error_description || e.details)) || String(e);

  // ---------- backends -------------------------------------------------
  // Both expose the same methods; the UI doesn't care which is active.

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function supabaseBackend() {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };

    return {
      async listProjects() { return ok(await sb.from("projects").select("*").order("name")); },
      async createProject(name) { return ok(await sb.from("projects").insert({ name: name.trim() }).select().single()); },
      async listAssets() {
        const rows = ok(await sb.from("assets").select("*, versions(*), comments(kind)").order("updated_at", { ascending: false }));
        return rows.map((a) => ({
          ...a,
          current: (a.versions || []).find((v) => v.version_number === a.current_version) || null,
          comment_count: (a.comments || []).filter((c) => c.kind === "comment").length,
        }));
      },
      async getAsset(id) {
        const [asset, versions, comments] = await Promise.all([
          sb.from("assets").select("*").eq("id", id).maybeSingle().then(ok),
          sb.from("versions").select("*").eq("asset_id", id).order("version_number").then(ok),
          sb.from("comments").select("*").eq("asset_id", id).order("created_at").then(ok),
        ]);
        return asset ? { asset, versions, comments } : null;
      },
      async uploadFile(file) {
        const clean = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
        const path = `${uid()}/${clean}`;
        ok(await sb.storage.from("media").upload(path, file, { contentType: file.type || undefined }));
        const { data } = sb.storage.from("media").getPublicUrl(path);
        return { url: data.publicUrl, storage_path: path };
      },
      async createAsset(p) {
        return ok(await sb.rpc("create_asset", {
          p_project_id: p.project_id, p_title: p.title, p_description: p.description, p_created_by: p.name,
          p_media_type: p.media_type, p_url: p.url, p_storage_path: p.storage_path, p_file_name: p.file_name, p_notes: p.notes,
        }));
      },
      async addVersion(p) {
        return ok(await sb.rpc("add_version", {
          p_asset_id: p.asset_id, p_uploaded_by: p.name, p_media_type: p.media_type, p_url: p.url,
          p_storage_path: p.storage_path, p_file_name: p.file_name, p_notes: p.notes,
        }));
      },
      async addComment(p) {
        ok(await sb.from("comments").insert({ asset_id: p.asset_id, version_number: p.version_number, author: p.name.trim(), body: p.body.trim() }));
      },
      async verifyApprover(name, passcode) { return ok(await sb.rpc("verify_approver", { p_approver: name, p_passcode: passcode })); },
      async setStatus(p) {
        ok(await sb.rpc("set_status", { p_asset_id: p.asset_id, p_status: p.status, p_approver: p.approver, p_passcode: p.passcode, p_note: p.note || null }));
      },
      async deleteAsset(p) { ok(await sb.rpc("delete_asset", { p_asset_id: p.asset_id, p_approver: p.approver, p_passcode: p.passcode })); },
      async deleteComment(p) { ok(await sb.rpc("delete_comment", { p_comment_id: p.comment_id, p_approver: p.approver, p_passcode: p.passcode })); },
    };
  }

  // Demo backend: everything in localStorage. Approver passcode is "demo".
  function demoBackend() {
    const KEY = "mr_demo_db_v1";
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
    let db = load();
    const save = () => {
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch { throw new Error("Demo storage is full — use smaller files or connect Supabase."); }
    };
    const now = () => new Date().toISOString();
    const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const svg = (bg, fg, label) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${bg}"/>` +
      `<circle cx="620" cy="160" r="90" fill="${fg}" opacity=".35"/><rect x="80" y="380" width="460" height="24" rx="6" fill="${fg}" opacity=".5"/>` +
      `<rect x="80" y="420" width="320" height="18" rx="6" fill="${fg}" opacity=".35"/>` +
      `<text x="80" y="330" font-family="Helvetica,Arial" font-size="56" font-weight="700" fill="${fg}">${label}</text></svg>`);

    if (!db) {
      const p1 = uid(), p2 = uid(), a1 = uid(), a2 = uid(), a3 = uid();
      db = {
        projects: [{ id: p1, name: "Section 6 – Shastra", created_at: ago(80) }, { id: p2, name: "Social posts", created_at: ago(80) }],
        assets: [
          { id: a1, project_id: p1, title: "Entrance banner", description: "Main banner at the section entrance. 6ft × 3ft.", status: "ready_for_approval", current_version: 2, created_by: "Daven", created_at: ago(50), updated_at: ago(3) },
          { id: a2, project_id: p1, title: "Panel 2 – timeline", description: "", status: "in_review", current_version: 1, created_by: "Daven", created_at: ago(30), updated_at: ago(30) },
          { id: a3, project_id: p2, title: "Instagram teaser", description: "Square post for the launch.", status: "approved", current_version: 1, approved_version: 1, approved_by: "Demo", approved_at: ago(5), created_by: "Daven", created_at: ago(40), updated_at: ago(5) },
        ],
        versions: [
          { id: uid(), asset_id: a1, version_number: 1, media_type: "image", url: svg("#f1e3c6", "#7a4a00", "Banner v1"), uploaded_by: "Daven", notes: "First draft", created_at: ago(50) },
          { id: uid(), asset_id: a1, version_number: 2, media_type: "image", url: svg("#ffe1b3", "#8a3b00", "Banner v2"), uploaded_by: "Daven", notes: "Bigger title, warmer colours per feedback", created_at: ago(3) },
          { id: uid(), asset_id: a2, version_number: 1, media_type: "image", url: svg("#dfe8ff", "#1d3a8a", "Timeline"), uploaded_by: "Daven", notes: "", created_at: ago(30) },
          { id: uid(), asset_id: a3, version_number: 1, media_type: "image", url: svg("#dff3e6", "#1e6b3c", "Teaser"), uploaded_by: "Daven", notes: "", created_at: ago(40) },
        ],
        comments: [
          { id: uid(), asset_id: a1, version_number: 1, author: "Daven", body: "Uploaded v1", kind: "event", created_at: ago(50) },
          { id: uid(), asset_id: a1, version_number: 1, author: "Reviewer", body: "Title is too small from a distance. Can we try a warmer palette?", kind: "comment", created_at: ago(20) },
          { id: uid(), asset_id: a1, version_number: 2, author: "Daven", body: "Uploaded v2 — ready for approval", kind: "event", created_at: ago(3) },
          { id: uid(), asset_id: a2, version_number: 1, author: "Daven", body: "Uploaded v1", kind: "event", created_at: ago(30) },
          { id: uid(), asset_id: a3, version_number: 1, author: "Daven", body: "Uploaded v1", kind: "event", created_at: ago(40) },
          { id: uid(), asset_id: a3, version_number: 1, author: "Demo", body: "✅ Approved v1", kind: "event", created_at: ago(5) },
        ],
      };
      save();
    }

    const checkApprover = (name, pass) => {
      if (!String(name || "").trim() || pass !== "demo") throw new Error("Approver name or passcode is incorrect (demo passcode: demo)");
      return String(name).trim();
    };
    const asset = (id) => { const a = db.assets.find((x) => x.id === id); if (!a) throw new Error("Asset not found"); return a; };
    const event = (asset_id, version_number, author, body) =>
      db.comments.push({ id: uid(), asset_id, version_number, author, body, kind: "event", created_at: now() });
    const delay = (v) => new Promise((r) => setTimeout(() => r(v), 60));

    return {
      async listProjects() { return delay([...db.projects].sort((a, b) => a.name.localeCompare(b.name))); },
      async createProject(name) {
        if (db.projects.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("That project already exists");
        const p = { id: uid(), name: name.trim(), created_at: now() }; db.projects.push(p); save(); return delay(p);
      },
      async listAssets() {
        return delay([...db.assets].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((a) => ({
          ...a,
          current: db.versions.find((v) => v.asset_id === a.id && v.version_number === a.current_version) || null,
          comment_count: db.comments.filter((c) => c.asset_id === a.id && c.kind === "comment").length,
        })));
      },
      async getAsset(id) {
        const a = db.assets.find((x) => x.id === id); if (!a) return delay(null);
        return delay({
          asset: { ...a },
          versions: db.versions.filter((v) => v.asset_id === id).sort((x, y) => x.version_number - y.version_number),
          comments: db.comments.filter((c) => c.asset_id === id).sort((x, y) => x.created_at.localeCompare(y.created_at)),
        });
      },
      async uploadFile(file) {
        const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        return { url, storage_path: null };
      },
      async createAsset(p) {
        const id = uid(), t = now();
        db.assets.push({ id, project_id: p.project_id, title: p.title.trim(), description: (p.description || "").trim(), status: "in_review", current_version: 1, created_by: p.name.trim(), created_at: t, updated_at: t });
        db.versions.push({ id: uid(), asset_id: id, version_number: 1, media_type: p.media_type, url: p.url, file_name: p.file_name, notes: (p.notes || "").trim(), uploaded_by: p.name.trim(), created_at: t });
        event(id, 1, p.name.trim(), "Uploaded v1");
        save(); return delay(id);
      },
      async addVersion(p) {
        const a = asset(p.asset_id); const n = a.current_version + 1;
        db.versions.push({ id: uid(), asset_id: a.id, version_number: n, media_type: p.media_type, url: p.url, file_name: p.file_name, notes: (p.notes || "").trim(), uploaded_by: p.name.trim(), created_at: now() });
        Object.assign(a, { current_version: n, status: "ready_for_approval", approved_version: null, approved_by: null, approved_at: null, updated_at: now() });
        event(a.id, n, p.name.trim(), `Uploaded v${n} — ready for approval`);
        save(); return delay(n);
      },
      async addComment(p) {
        db.comments.push({ id: uid(), asset_id: p.asset_id, version_number: p.version_number, author: p.name.trim(), body: p.body.trim(), kind: "comment", created_at: now() });
        save(); return delay();
      },
      async verifyApprover(name, pass) { return delay(checkApprover(name, pass)); },
      async setStatus(p) {
        const who = checkApprover(p.approver, p.passcode); const a = asset(p.asset_id);
        const approved = p.status === "approved";
        Object.assign(a, { status: p.status, approved_version: approved ? a.current_version : null, approved_by: approved ? who : null, approved_at: approved ? now() : null, updated_at: now() });
        let body = { approved: `✅ Approved v${a.current_version}`, changes_requested: `✏️ Requested changes on v${a.current_version}`, in_review: "Reopened for review" }[p.status];
        if (p.note && p.note.trim()) body += " — " + p.note.trim();
        event(a.id, a.current_version, who, body);
        save(); return delay();
      },
      async deleteAsset(p) {
        checkApprover(p.approver, p.passcode);
        db.assets = db.assets.filter((a) => a.id !== p.asset_id);
        db.versions = db.versions.filter((v) => v.asset_id !== p.asset_id);
        db.comments = db.comments.filter((c) => c.asset_id !== p.asset_id);
        save(); return delay();
      },
      async deleteComment(p) {
        checkApprover(p.approver, p.passcode);
        db.comments = db.comments.filter((c) => c.id !== p.comment_id); save(); return delay();
      },
    };
  }

  // ---------- state ----------------------------------------------------
  let api;
  const state = {
    projects: [],
    filters: { q: "", project: "all", status: "all" },
    detail: null, // { asset, versions, comments, selected, commentScope }
  };

  // ---------- media rendering -----------------------------------------
  function thumbHtml(v) {
    if (!v) return `<div class="icon"><b>?</b>NO FILE</div>`;
    const url = safeUrl(v.url);
    if (v.media_type === "image") return `<img loading="lazy" src="${esc(url)}" alt="">`;
    if (v.media_type === "video") return `<video src="${esc(url)}#t=0.5" preload="metadata" muted playsinline></video>`;
    const yt = youtubeId(v.url);
    if (yt) return `<img loading="lazy" src="https://img.youtube.com/vi/${esc(yt)}/hqdefault.jpg" alt="">`;
    const dr = driveId(v.url);
    if (dr) return `<img loading="lazy" src="https://drive.google.com/thumbnail?id=${esc(dr)}&sz=w600" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'icon',innerHTML:'<b>↗</b>DRIVE LINK'}))">`;
    if (v.media_type === "pdf") return `<div class="icon"><b>📄</b>PDF</div>`;
    if (v.media_type === "link") return `<div class="icon"><b>↗</b>LINK</div>`;
    return `<div class="icon"><b>📎</b>${esc((v.file_name || "FILE").split(".").pop().toUpperCase())}</div>`;
  }

  function viewerHtml(v) {
    if (!v) return `<div class="fallback">No file for this version.</div>`;
    const url = safeUrl(v.url);
    const open = `<a href="${esc(url)}" target="_blank" rel="noopener">Open in new tab ↗</a>`;
    if (v.media_type === "image") return `<img src="${esc(url)}" alt="" data-zoom>`;
    if (v.media_type === "video") return `<video src="${esc(url)}" controls playsinline preload="metadata"></video>`;
    if (v.media_type === "pdf" && !driveId(v.url)) return `<iframe src="${esc(url)}" title="PDF preview"></iframe>`;
    const yt = youtubeId(v.url);
    if (yt) return `<iframe src="https://www.youtube.com/embed/${esc(yt)}" allowfullscreen title="Video"></iframe>`;
    const dr = driveId(v.url);
    if (dr) return `<iframe src="https://drive.google.com/file/d/${esc(dr)}/preview" allowfullscreen title="Drive preview"></iframe>`;
    return `<div class="fallback"><p>This item can't be previewed here.</p><p>${open}</p></div>`;
  }

  // ---------- gallery --------------------------------------------------
  async function renderGallery() {
    state.detail = null;
    const [projects, assets] = await Promise.all([api.listProjects(), api.listAssets()]);
    state.projects = projects;
    const f = state.filters;
    if (f.project !== "all" && f.project !== "none" && !projects.some((p) => p.id === f.project)) f.project = "all";

    const q = f.q.trim().toLowerCase();
    const inScope = assets.filter((a) =>
      (f.project === "all" || (f.project === "none" ? !a.project_id : a.project_id === f.project)) &&
      (!q || a.title.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)));
    const counts = { all: inScope.length };
    STATUS_ORDER.forEach((s) => (counts[s] = inScope.filter((a) => a.status === s).length));
    const shown = inScope.filter((a) => f.status === "all" || a.status === f.status);

    const groups = [];
    const byProject = new Map();
    shown.forEach((a) => { const k = a.project_id || "none"; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(a); });
    projects.forEach((p) => byProject.has(p.id) && groups.push({ name: p.name, items: byProject.get(p.id) }));
    if (byProject.has("none")) groups.push({ name: "Unsorted", items: byProject.get("none") });
    // project ids that no longer exist
    byProject.forEach((items, k) => { if (k !== "none" && !projects.some((p) => p.id === k)) groups.push({ name: "Unsorted", items }); });

    const card = (a) => `
      <a class="card ${a.status === "approved" ? "is-approved" : ""}" href="#/asset/${esc(a.id)}">
        <div class="thumb">${thumbHtml(a.current)}<span class="vtag">v${a.current_version}</span></div>
        <div class="card-body">
          <div class="card-title" title="${esc(a.title)}">${esc(a.title)}</div>
          <div class="card-meta">${badge(a.status)}<span>💬 ${a.comment_count} · ${esc(timeAgo(a.updated_at))}</span></div>
        </div>
      </a>`;

    $("#app").innerHTML = `
      <div class="toolbar">
        <input type="search" id="f-q" placeholder="Search titles…" value="${esc(f.q)}">
        <select id="f-project">
          <option value="all">All projects</option>
          ${projects.map((p) => `<option value="${esc(p.id)}" ${f.project === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          <option value="none" ${f.project === "none" ? "selected" : ""}>Unsorted</option>
        </select>
        <div class="chips">
          <button class="chip ${f.status === "all" ? "active" : ""}" data-status="all">All<span class="n">${counts.all}</span></button>
          ${STATUS_ORDER.map((s) => `<button class="chip ${f.status === s ? "active" : ""}" data-status="${s}">${STATUS[s]}<span class="n">${counts[s]}</span></button>`).join("")}
        </div>
      </div>
      ${groups.length ? groups.map((g) => `
        <section class="group">
          <h2>${esc(g.name)} <span class="muted">${g.items.length}</span></h2>
          <div class="grid">${g.items.map(card).join("")}</div>
        </section>`).join("")
      : `<div class="empty">${assets.length ? "Nothing matches these filters." : "No assets yet. Click <b>+ New asset</b> to upload the first one."}</div>`}`;

    const qEl = $("#f-q");
    qEl.addEventListener("input", debounce(() => { f.q = qEl.value; renderGallery().then(() => { const el = $("#f-q"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 250));
    $("#f-project").addEventListener("change", (e) => { f.project = e.target.value; renderGallery(); });
    $$(".chip").forEach((b) => b.addEventListener("click", () => { f.status = b.dataset.status; renderGallery(); }));
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------- detail ---------------------------------------------------
  async function renderDetail(id, keepSelection = false) {
    const data = await api.getAsset(id);
    if (!data) { $("#app").innerHTML = `<div class="empty">This asset doesn't exist (it may have been deleted). <a href="#/">Back to gallery</a></div>`; return; }
    state.projects = await api.listProjects();
    const prev = state.detail && state.detail.asset.id === id ? state.detail : null;
    state.detail = {
      ...data,
      selected: keepSelection && prev ? Math.min(prev.selected, data.asset.current_version) : data.asset.current_version,
      commentScope: prev ? prev.commentScope : "all",
    };
    drawDetail();
  }

  function drawDetail() {
    const d = state.detail; const a = d.asset;
    const project = state.projects.find((p) => p.id === a.project_id);
    const v = d.versions.find((x) => x.version_number === d.selected) || d.versions[d.versions.length - 1];
    const isCurrent = v && v.version_number === a.current_version;
    const approver = store.approver;

    const comments = d.comments.filter((c) => d.commentScope === "all" || c.version_number === d.selected);
    const commentHtml = comments.length ? comments.map((c) => `
      <div class="comment ${c.kind === "event" ? "event" : ""}">
        <div class="who">
          <span><b>${esc(c.author)}</b>${c.version_number ? `<span class="vchip">v${c.version_number}</span>` : ""}</span>
          <span title="${esc(fullDate(c.created_at))}">${esc(timeAgo(c.created_at))}${approver && c.kind === "comment" ? `<button class="del" data-del-comment="${esc(c.id)}" title="Delete comment">✕</button>` : ""}</span>
        </div>
        <div class="body">${esc(c.body)}</div>
      </div>`).join("") : `<p class="muted small">No comments ${d.commentScope === "all" ? "yet" : "on v" + d.selected}.</p>`;

    let statusPanel;
    if (a.status === "approved") {
      statusPanel = `<div class="approved-box">✅ v${a.approved_version} approved by ${esc(a.approved_by)}<br><span class="small" style="font-weight:400">${esc(fullDate(a.approved_at))}</span></div>`;
    } else {
      statusPanel = `<p class="small muted" style="margin:0">Current status: ${badge(a.status)}</p>`;
    }
    const approverBtns = a.status === "approved"
      ? `<button class="btn" data-act="in_review">Reopen for review</button>`
      : `<button class="btn btn-approve" data-act="approved">✓ Approve v${a.current_version}</button>
         <button class="btn btn-changes" data-act="changes_requested">Request changes</button>`;

    $("#app").innerHTML = `
      <div class="crumbs"><a href="#/">Gallery</a> / ${esc(project ? project.name : "Unsorted")}</div>
      <div class="detail-head">
        <div>
          <h1>${esc(a.title)} ${badge(a.status)}</h1>
          ${a.description ? `<p>${esc(a.description)}</p>` : ""}
          <div class="small muted" style="margin-top:4px">Created by ${esc(a.created_by)} · ${esc(fullDate(a.created_at))}</div>
        </div>
      </div>
      <div class="detail-layout">
        <div class="panel">
          <div class="viewer">${viewerHtml(v)}</div>
          <div class="vbar">
            <span class="small muted">Versions:</span>
            ${d.versions.map((x) => `<button class="vtab ${x.version_number === d.selected ? "active" : ""}" data-v="${x.version_number}">v${x.version_number}${x.version_number === a.approved_version && a.status === "approved" ? ' <span class="tick">✓</span>' : ""}${x.version_number === a.current_version ? " · latest" : ""}</button>`).join("")}
          </div>
          ${v ? `<div class="vinfo">
            <div class="row" style="justify-content:space-between">
              <span><b>v${v.version_number}</b> uploaded by ${esc(v.uploaded_by)} · ${esc(fullDate(v.created_at))}${isCurrent ? "" : ' · <span class="muted">older version</span>'}</span>
              <a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener" ${v.file_name ? `download="${esc(v.file_name)}"` : ""}>Open original ↗</a>
            </div>
            ${v.notes ? `<div class="notes"><span class="muted">Notes:</span> ${esc(v.notes)}</div>` : ""}
          </div>` : ""}
        </div>
        <div class="side">
          <div class="panel">
            <h3>Status</h3>
            ${statusPanel}
            <div class="actions" style="margin-top:12px">
              <button class="btn btn-primary" id="new-version-btn">⬆ Upload revised version</button>
              ${approver ? approverBtns : `<button class="btn" id="approver-login">Approver? Sign in to approve</button>`}
              ${approver ? `<button class="btn-link small btn-danger" id="delete-asset" style="align-self:flex-start;margin-top:4px">Delete this asset</button>` : ""}
            </div>
          </div>
          <div class="panel">
            <div class="comments-head">
              <h3 style="margin:0">Comments</h3>
              <div class="seg small">
                <label><input type="radio" name="scope" value="all" ${d.commentScope === "all" ? "checked" : ""}>All versions</label>
                <label><input type="radio" name="scope" value="this" ${d.commentScope === "this" ? "checked" : ""}>v${d.selected} only</label>
              </div>
            </div>
            <div class="comment-list" id="comment-list">${commentHtml}</div>
            <form id="comment-form">
              <label class="field"><span>Your name</span><input type="text" name="name" maxlength="80" required value="${esc(store.name)}"></label>
              <label class="field"><span>Comment on v${d.selected}</span><textarea name="body" maxlength="5000" required placeholder="Feedback, questions, change requests…"></textarea></label>
              <button class="btn btn-primary" type="submit">Post comment</button>
            </form>
          </div>
        </div>
      </div>`;

    const list = $("#comment-list"); list.scrollTop = list.scrollHeight;

    $$(".vtab").forEach((b) => b.addEventListener("click", () => { d.selected = +b.dataset.v; drawDetail(); }));
    $$('input[name="scope"]').forEach((r) => r.addEventListener("change", () => { d.commentScope = r.value; drawDetail(); }));
    const img = $(".viewer img[data-zoom]");
    if (img) img.addEventListener("click", () => openLightbox(img.src));
    $("#new-version-btn").addEventListener("click", () => openVersionModal(a));
    const login = $("#approver-login"); if (login) login.addEventListener("click", () => openApproverLogin(() => drawDetail()));
    $$("[data-act]").forEach((b) => b.addEventListener("click", () => openStatusModal(a, b.dataset.act)));
    const del = $("#delete-asset"); if (del) del.addEventListener("click", () => deleteAsset(a));
    $$("[data-del-comment]").forEach((b) => b.addEventListener("click", () => deleteComment(b.dataset.delComment)));

    $("#comment-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const btn = e.target.querySelector("button[type=submit]");
      const name = String(fd.get("name")).trim(), body = String(fd.get("body")).trim();
      if (!name || !body) return;
      btn.disabled = true;
      try {
        store.name = name;
        await api.addComment({ asset_id: a.id, version_number: d.selected, name, body });
        await renderDetail(a.id, true);
      } catch (err) { toast(errMsg(err), true); btn.disabled = false; }
    });
  }

  function openLightbox(src) {
    const el = document.createElement("div");
    el.className = "lightbox"; el.innerHTML = `<img src="${esc(src)}" alt="">`;
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
  }

  // ---------- modals ---------------------------------------------------
  function openModal(html) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const back = $(".modal-backdrop", root);
    back.addEventListener("mousedown", (e) => { if (e.target === back) closeModal(); });
    $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
    const first = $("input:not([type=hidden]):not([type=radio]), textarea, select", root);
    if (first) setTimeout(() => first.focus(), 30);
    return $(".modal", root);
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const lb = $(".lightbox"); if (lb) return lb.remove();
    closeModal();
  });

  // Shared "file or link" source picker
  const sourceFieldsHtml = () => `
    <div class="field" style="margin-bottom:12px">
      <div class="seg" style="margin-bottom:8px">
        <label><input type="radio" name="src" value="file" checked>Upload file</label>
        <label><input type="radio" name="src" value="link">Paste link</label>
      </div>
      <div data-src="file">
        <input type="file" name="file" accept="image/*,video/*,application/pdf,.pdf,.ai,.psd,.zip,.pptx,.docx">
        <div class="small muted" style="margin-top:4px">Images, PDFs, videos — up to ${MAX_MB} MB. For bigger videos, use a YouTube or Google Drive link.</div>
      </div>
      <div data-src="link" hidden>
        <input type="url" name="link" placeholder="https://… (YouTube, Google Drive, Canva, etc.)">
        <div class="small muted" style="margin-top:4px">Google Drive files must be shared as “Anyone with the link”.</div>
      </div>
    </div>`;
  function wireSource(modal) {
    $$('input[name="src"]', modal).forEach((r) => r.addEventListener("change", () => {
      $$("[data-src]", modal).forEach((el) => (el.hidden = el.dataset.src !== r.value));
    }));
  }
  async function resolveSource(modal, setStatus) {
    const mode = $('input[name="src"]:checked', modal).value;
    if (mode === "file") {
      const file = $('input[name="file"]', modal).files[0];
      if (!file) throw new Error("Choose a file to upload.");
      if (file.size > MAX_MB * 1024 * 1024) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_MB} MB. Upload it to Google Drive or YouTube and paste the link instead.`);
      setStatus(`Uploading ${file.name}…`);
      const up = await api.uploadFile(file);
      return { ...up, media_type: mediaTypeFromFile(file), file_name: file.name };
    }
    const link = $('input[name="link"]', modal).value.trim();
    if (!/^https?:\/\//i.test(link)) throw new Error("Paste a full link starting with https://");
    return { url: link, storage_path: null, media_type: mediaTypeFromLink(link), file_name: null };
  }

  async function openNewAssetModal() {
    if (!state.projects.length) state.projects = await api.listProjects();
    const f = state.filters;
    const preset = state.detail ? state.detail.asset.project_id : (f.project !== "all" && f.project !== "none" ? f.project : "");
    const modal = openModal(`
      <h2>New asset</h2>
      <form>
        <label class="field"><span>Project / section</span>
          <select name="project">
            ${state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === preset ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            <option value="" ${state.projects.length ? "" : "selected"}>— Unsorted —</option>
            <option value="__new">＋ New project…</option>
          </select>
        </label>
        <label class="field" data-newproj hidden><span>New project name</span><input type="text" name="newproject" maxlength="120" placeholder="e.g. Section 6 – Shastra"></label>
        <label class="field"><span>Title</span><input type="text" name="title" maxlength="160" required></label>
        <label class="field"><span>Description <span class="muted" style="font-weight:400">(optional)</span></span><textarea name="description" maxlength="2000" style="min-height:60px"></textarea></label>
        ${sourceFieldsHtml()}
        <label class="field"><span>Your name</span><input type="text" name="name" maxlength="80" required value="${esc(store.name)}"></label>
        <div class="error" data-err></div>
        <div class="footer"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Upload</button></div>
      </form>`);
    wireSource(modal);
    const sel = $('select[name="project"]', modal);
    sel.addEventListener("change", () => { $("[data-newproj]", modal).hidden = sel.value !== "__new"; });

    $("form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const btn = $('button[type=submit]', modal); const err = $("[data-err]", modal);
      const setStatus = (t) => { err.style.color = "var(--muted)"; err.textContent = t; };
      err.textContent = ""; err.style.color = ""; btn.disabled = true;
      try {
        const name = String(fd.get("name")).trim(), title = String(fd.get("title")).trim();
        if (!title || !name) throw new Error("Title and your name are required.");
        let project_id = fd.get("project") || null;
        if (project_id === "__new") {
          const pn = String(fd.get("newproject") || "").trim();
          if (!pn) throw new Error("Enter a name for the new project.");
          const existing = state.projects.find((p) => p.name.toLowerCase() === pn.toLowerCase());
          project_id = existing ? existing.id : (await api.createProject(pn)).id;
        }
        const src = await resolveSource(modal, setStatus);
        setStatus("Saving…");
        store.name = name;
        const id = await api.createAsset({ project_id, title, description: fd.get("description"), name, notes: "", ...src });
        closeModal(); toast("Asset uploaded");
        location.hash = `#/asset/${id}`;
      } catch (ex) { err.style.color = ""; err.textContent = errMsg(ex); btn.disabled = false; }
    });
  }

  function openVersionModal(a) {
    const next = a.current_version + 1;
    const modal = openModal(`
      <h2>Upload v${next} of “${esc(a.title)}”</h2>
      <p class="small muted" style="margin-top:-6px">The new version will be marked <b>Ready for Approval</b>.${a.status === "approved" ? " This asset is currently approved — uploading will reopen it." : ""}</p>
      <form>
        ${sourceFieldsHtml()}
        <label class="field"><span>What changed?</span><textarea name="notes" maxlength="2000" placeholder="e.g. Fixed spelling, enlarged logo per comments"></textarea></label>
        <label class="field"><span>Your name</span><input type="text" name="name" maxlength="80" required value="${esc(store.name)}"></label>
        <div class="error" data-err></div>
        <div class="footer"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Upload v${next}</button></div>
      </form>`);
    wireSource(modal);
    $("form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const btn = $('button[type=submit]', modal); const err = $("[data-err]", modal);
      const setStatus = (t) => { err.style.color = "var(--muted)"; err.textContent = t; };
      err.textContent = ""; btn.disabled = true;
      try {
        const name = String(fd.get("name")).trim();
        if (!name) throw new Error("Your name is required.");
        const src = await resolveSource(modal, setStatus);
        setStatus("Saving…");
        store.name = name;
        const n = await api.addVersion({ asset_id: a.id, name, notes: fd.get("notes"), ...src });
        closeModal(); toast(`v${n} uploaded — ready for approval`);
        await renderDetail(a.id);
      } catch (ex) { err.style.color = ""; err.textContent = errMsg(ex); btn.disabled = false; }
    });
  }

  function openApproverLogin(onDone) {
    const modal = openModal(`
      <h2>Approver sign-in</h2>
      <p class="small muted" style="margin-top:-6px">Only people on the approver list can approve assets.${DEMO ? " <b>Demo passcode: demo</b>" : ""} You'll stay signed in until you close this tab.</p>
      <form>
        <label class="field"><span>Approver name</span><input type="text" name="name" maxlength="80" required value="${esc(store.name)}"></label>
        <label class="field"><span>Passcode</span><input type="password" name="pass" required autocomplete="current-password"></label>
        <div class="error" data-err></div>
        <div class="footer"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Sign in</button></div>
      </form>`);
    $("form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const btn = $('button[type=submit]', modal); const err = $("[data-err]", modal);
      btn.disabled = true; err.textContent = "";
      try {
        const name = String(fd.get("name")).trim(), pass = String(fd.get("pass"));
        const canonical = await api.verifyApprover(name, pass);
        store.approver = { name: canonical || name, pass };
        closeModal(); updateHeader(); toast(`Signed in as approver: ${canonical || name}`);
        onDone && onDone();
      } catch (ex) { err.textContent = errMsg(ex); btn.disabled = false; }
    });
  }

  function withApprover(fn) {
    const ap = store.approver;
    if (ap) return fn(ap);
    openApproverLogin(() => fn(store.approver));
  }

  function openStatusModal(a, status) {
    withApprover((ap) => {
      const titles = { approved: `Approve v${a.current_version}?`, changes_requested: `Request changes on v${a.current_version}`, in_review: "Reopen for review" };
      const labels = { approved: "Approve", changes_requested: "Request changes", in_review: "Reopen" };
      const btnCls = { approved: "btn-approve", changes_requested: "btn-primary", in_review: "btn-primary" };
      const modal = openModal(`
        <h2>${esc(titles[status])}</h2>
        <form>
          <label class="field"><span>${status === "changes_requested" ? "What needs to change?" : "Note"} <span class="muted" style="font-weight:400">${status === "changes_requested" ? "" : "(optional)"}</span></span>
            <textarea name="note" maxlength="2000" ${status === "changes_requested" ? "required" : ""}></textarea></label>
          <p class="small muted">Signed in as <b>${esc(ap.name)}</b></p>
          <div class="error" data-err></div>
          <div class="footer"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn ${btnCls[status]}">${labels[status]}</button></div>
        </form>`);
      $("form", modal).addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $('button[type=submit]', modal); const err = $("[data-err]", modal);
        btn.disabled = true;
        try {
          await api.setStatus({ asset_id: a.id, status, approver: ap.name, passcode: ap.pass, note: new FormData(e.target).get("note") });
          closeModal(); toast(status === "approved" ? "Approved ✅" : "Status updated");
          await renderDetail(a.id, true);
        } catch (ex) {
          err.textContent = errMsg(ex); btn.disabled = false;
          if (/passcode/i.test(errMsg(ex))) { store.approver = null; updateHeader(); }
        }
      });
    });
  }

  function deleteAsset(a) {
    withApprover(async (ap) => {
      if (!confirm(`Delete “${a.title}” and all its versions and comments? This can't be undone.`)) return;
      try { await api.deleteAsset({ asset_id: a.id, approver: ap.name, passcode: ap.pass }); toast("Asset deleted"); location.hash = "#/"; }
      catch (ex) { toast(errMsg(ex), true); }
    });
  }
  function deleteComment(id) {
    withApprover(async (ap) => {
      if (!confirm("Delete this comment?")) return;
      try { await api.deleteComment({ comment_id: id, approver: ap.name, passcode: ap.pass }); await renderDetail(state.detail.asset.id, true); }
      catch (ex) { toast(errMsg(ex), true); }
    });
  }

  // ---------- header + routing ----------------------------------------
  function updateHeader() {
    const ap = store.approver; const flag = $("#approver-flag");
    if (ap) {
      flag.hidden = false;
      flag.innerHTML = `Approver: ${esc(ap.name)}<button id="ap-out">sign out</button>`;
      $("#ap-out").addEventListener("click", () => { store.approver = null; updateHeader(); route(); });
    } else flag.hidden = true;
  }

  async function route() {
    const m = location.hash.match(/^#\/asset\/([\w-]+)/);
    try {
      if (m) await renderDetail(m[1]);
      else await renderGallery();
    } catch (ex) {
      console.error(ex);
      $("#app").innerHTML = `<div class="empty">Something went wrong loading this page.<br><span class="small">${esc(errMsg(ex))}</span><br><br><a href="#/">Back to gallery</a></div>`;
    }
  }

  async function init() {
    const title = cfg.SITE_TITLE || "Media Review";
    document.title = title; $("#brand").textContent = title;
    $("#demo-flag").hidden = !DEMO;
    $("#new-asset-btn").addEventListener("click", () => openNewAssetModal().catch((e) => toast(errMsg(e), true)));
    updateHeader();
    try { api = DEMO ? demoBackend() : await supabaseBackend(); }
    catch (ex) { $("#app").innerHTML = `<div class="empty">Couldn't connect to the database.<br><span class="small">${esc(errMsg(ex))}</span></div>`; return; }
    window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
    route();
  }

  init();
})();
