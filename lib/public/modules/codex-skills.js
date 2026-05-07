// Iter 6a: Codex skills frontend.
//
// Two surfaces share one data source:
//
//   1. Header panel popover (#header-codex-skills-btn → #codex-skills-panel)
//      — discoverable browse view with name, scope badge, description.
//   2. Inline autocomplete (#codex-skill-menu) — fast keyboard-driven picker
//      anchored above the input bar, triggered by `$` or `/` typed at the
//      start of input or after whitespace.
//
// Both feed `applySkillSelection(name)`, which prefixes the input field
// with `$<name> ` (codex's server-side skill mention syntax). The backend
// `applySkillInjection` parser in lib/codex-backend.js completes the
// contract by appending the matching `{type:"skill",name,path}` input
// item to the next turn/start.
//
// Data flow:
//   server → ws message `codex_skills` { skills: [...], errors: [...] }
//   ↓
//   handleCodexSkillsMessage(msg)  // updates module state, refreshes UI
//   ↓
//   render functions read from `state` and write to DOM
//
// The Claude side has its own skills system (#skills-btn / modules/skills.js)
// that is unrelated to this one. They live behind different capability
// flags (capabilities.codexSkills) so they don't collide.

var ctx = null;

// Module state. `skills` is the canonical list from the most recent
// `codex_skills` WS frame; everything else is UI-derived.
var state = {
  skills: [],          // SkillMetadata[] from codex skills/list
  errors: [],          // SkillErrorInfo[] (per-cwd discovery errors)
  fetchedAt: 0,
  hasReceived: false,  // false until first codex_skills frame arrives
  panelOpen: false,
  inlineOpen: false,
  inlineFiltered: [],
  inlineActiveIdx: -1,
  inlineTriggerStart: -1,  // index in input.value where the `$`/`/` lives
};

var headerBtn = null;
var panelEl = null;
var inlineEl = null;

export function initCodexSkills(ctxArg) {
  ctx = ctxArg;
  headerBtn = document.getElementById("header-codex-skills-btn");
  inlineEl = document.getElementById("codex-skill-menu");

  if (!headerBtn || !inlineEl) {
    // The DOM nodes are codex-only additions; if they're missing the
    // module is a complete no-op (Claude projects don't load codex
    // capability anyway).
    return;
  }

  buildPanel();

  headerBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (state.panelOpen) closePanel();
    else openPanel();
  });

  // Outside-click / Escape to close panel.
  document.addEventListener("click", function (e) {
    if (!state.panelOpen) return;
    if (panelEl && (panelEl.contains(e.target) || (headerBtn && headerBtn.contains(e.target)))) return;
    closePanel();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.panelOpen) closePanel();
  });
}

// Frontend gating mirror of agent-backend.js's getBackendCapabilities.
// Called by app.js's info handler with msg.capabilities.codexSkills.
export function setCodexSkillsCapability(enabled) {
  if (!headerBtn) return;
  if (enabled) {
    headerBtn.hidden = false;
  } else {
    headerBtn.hidden = true;
    closePanel();
    hideInlineMenu();
    // Wipe state so a backend switch (codex → claude) doesn't leak
    // stale skills into the next session view.
    state.skills = [];
    state.errors = [];
    state.hasReceived = false;
    renderPanel();
  }
}

export function handleCodexSkillsMessage(msg) {
  state.skills = Array.isArray(msg.skills) ? msg.skills : [];
  state.errors = Array.isArray(msg.errors) ? msg.errors : [];
  state.fetchedAt = msg.fetchedAt || Date.now();
  state.hasReceived = true;
  renderPanel();
  // If the inline picker is open, re-filter against the new list so the
  // user sees fresh results without retyping.
  if (state.inlineOpen) {
    var query = currentInlineQuery();
    if (query != null) showInlineMenu(query);
  }
}

// Public read-only view, used by tests and for debugging.
export function getCodexSkillsState() {
  return {
    skills: state.skills.slice(),
    errors: state.errors.slice(),
    fetchedAt: state.fetchedAt,
    hasReceived: state.hasReceived,
    panelOpen: state.panelOpen,
    inlineOpen: state.inlineOpen,
  };
}

// --- Header panel ---

function buildPanel() {
  panelEl = document.createElement("div");
  panelEl.id = "codex-skills-panel";
  panelEl.className = "codex-skills-panel hidden";
  panelEl.setAttribute("role", "dialog");
  panelEl.setAttribute("aria-label", "Codex skills");
  document.body.appendChild(panelEl);
}

function openPanel() {
  if (!panelEl || !headerBtn) return;
  state.panelOpen = true;
  // Trigger a refresh so the user sees current state. fetchSkills on the
  // server is cheap (cached); Force=false respects codex's cache; if the
  // user wants a hard reload they'll click Refresh inside the panel.
  if (ctx && ctx.requestCodexSkills) ctx.requestCodexSkills(false);
  renderPanel();
  positionPanel();
  panelEl.classList.remove("hidden");
}

function closePanel() {
  state.panelOpen = false;
  if (panelEl) panelEl.classList.add("hidden");
}

function positionPanel() {
  if (!panelEl || !headerBtn) return;
  var rect = headerBtn.getBoundingClientRect();
  panelEl.style.top = (rect.bottom + 6) + "px";
  // Right-align to the button so the panel grows leftward, matching
  // session-info-popover's placement convention.
  var panelWidth = 360;
  var leftCandidate = rect.left;
  var maxLeft = window.innerWidth - panelWidth - 12;
  panelEl.style.left = Math.max(12, Math.min(leftCandidate, maxLeft)) + "px";
  panelEl.style.width = panelWidth + "px";
}

function renderPanel() {
  if (!panelEl) return;
  var html = '<div class="codex-skills-panel-header">' +
    '<span class="codex-skills-panel-title">Skills</span>' +
    '<button class="codex-skills-refresh-btn" type="button" title="Reload from disk">Refresh</button>' +
    '</div>';

  if (state.errors && state.errors.length > 0) {
    html += '<div class="codex-skills-errors">';
    for (var i = 0; i < state.errors.length; i++) {
      var e = state.errors[i] || {};
      html += '<div class="codex-skills-error-row">' +
        '<strong>' + escapeHtml(e.code || "error") + '</strong>: ' +
        escapeHtml(e.message || "") +
        '</div>';
    }
    html += '</div>';
  }

  if (!state.hasReceived) {
    html += '<div class="codex-skills-empty">Loading…</div>';
  } else if (state.skills.length === 0) {
    html += '<div class="codex-skills-empty">No skills available for this project.</div>';
  } else {
    html += '<div class="codex-skills-list">';
    for (var j = 0; j < state.skills.length; j++) {
      html += renderSkillRow(state.skills[j], j);
    }
    html += '</div>';
  }

  panelEl.innerHTML = html;

  var refreshBtn = panelEl.querySelector(".codex-skills-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (ctx && ctx.requestCodexSkills) ctx.requestCodexSkills(true);
    });
  }
  panelEl.querySelectorAll(".codex-skills-row").forEach(function (el) {
    el.addEventListener("click", function () {
      var name = el.getAttribute("data-skill-name");
      if (name) {
        applySkillSelection(name);
        closePanel();
      }
    });
  });
}

function renderSkillRow(skill, idx) {
  if (!skill) return "";
  var name = skill.name || "";
  var desc = skill.shortDescription || skill.description || "";
  if (desc.length > 200) desc = desc.substring(0, 197) + "…";
  var scope = typeof skill.scope === "string" ? skill.scope : "user";
  var enabled = skill.enabled === false ? false : true;
  var enabledMark = enabled ? "" : ' <span class="codex-skill-disabled-mark" title="Disabled in Codex config">disabled</span>';
  return '<button type="button" class="codex-skills-row" data-skill-name="' + escapeAttr(name) + '" data-idx="' + idx + '">' +
    '<div class="codex-skills-row-head">' +
    '<span class="codex-skill-name">$' + escapeHtml(name) + '</span>' +
    '<span class="codex-skill-scope codex-skill-scope-' + escapeAttr(scope) + '">' + escapeHtml(scope) + '</span>' +
    enabledMark +
    '</div>' +
    (desc ? '<div class="codex-skill-desc">' + escapeHtml(desc) + '</div>' : '') +
    '</button>';
}

// --- Inline autocomplete ---

// Detect whether the cursor sits inside a `$<query>` or `/<query>` token
// at start-of-input or after whitespace. Returns
//   { start, char, query }
// or null.
export function detectSkillTrigger(value, cursor) {
  if (typeof value !== "string" || cursor == null) return null;
  var i = cursor - 1;
  while (i >= 0) {
    var ch = value.charAt(i);
    if (ch === "$" || ch === "/") {
      // Trigger char must be at start or preceded by whitespace.
      if (i === 0 || /\s/.test(value.charAt(i - 1))) {
        return { start: i, char: ch, query: value.substring(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

function currentInlineQuery() {
  if (!ctx || !ctx.inputEl) return null;
  var token = detectSkillTrigger(ctx.inputEl.value, ctx.inputEl.selectionStart);
  return token ? token.query : null;
}

export function maybeShowInlineMenu() {
  if (!ctx || !ctx.inputEl || !inlineEl) return false;
  // Capability gate: only when the codex skill panel is enabled. The
  // header button visibility is the canonical signal.
  if (!headerBtn || headerBtn.hidden) {
    hideInlineMenu();
    return false;
  }
  var token = detectSkillTrigger(ctx.inputEl.value, ctx.inputEl.selectionStart);
  if (!token) {
    hideInlineMenu();
    return false;
  }
  state.inlineTriggerStart = token.start;
  showInlineMenu(token.query);
  return true;
}

function showInlineMenu(query) {
  if (!inlineEl) return;
  var q = (query || "").toLowerCase();
  state.inlineFiltered = state.skills.filter(function (s) {
    if (!s || typeof s.name !== "string") return false;
    return s.name.toLowerCase().indexOf(q) !== -1;
  });
  if (state.inlineFiltered.length === 0) {
    hideInlineMenu();
    return;
  }
  state.inlineActiveIdx = 0;
  state.inlineOpen = true;
  inlineEl.innerHTML = state.inlineFiltered.map(function (s, i) {
    var scope = typeof s.scope === "string" ? s.scope : "user";
    var desc = s.shortDescription || s.description || "";
    if (desc.length > 80) desc = desc.substring(0, 77) + "…";
    return '<div class="codex-skill-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
      '<span class="codex-skill-item-name">$' + escapeHtml(s.name || "") + '</span>' +
      '<span class="codex-skill-item-scope codex-skill-scope-' + escapeAttr(scope) + '">' + escapeHtml(scope) + '</span>' +
      (desc ? '<span class="codex-skill-item-desc">' + escapeHtml(desc) + '</span>' : '') +
      '</div>';
  }).join("");
  inlineEl.classList.add("visible");
  inlineEl.querySelectorAll(".codex-skill-item").forEach(function (el) {
    el.addEventListener("click", function () {
      selectInlineItem(parseInt(el.dataset.idx, 10));
    });
  });
}

export function hideInlineMenu() {
  if (!inlineEl) return;
  inlineEl.classList.remove("visible");
  inlineEl.innerHTML = "";
  state.inlineOpen = false;
  state.inlineFiltered = [];
  state.inlineActiveIdx = -1;
  state.inlineTriggerStart = -1;
}

export function isInlineMenuVisible() {
  return state.inlineOpen;
}

export function moveInlineSelection(delta) {
  if (!state.inlineOpen || state.inlineFiltered.length === 0) return;
  var n = state.inlineFiltered.length;
  state.inlineActiveIdx = (state.inlineActiveIdx + delta + n) % n;
  updateInlineHighlight();
}

export function commitInlineSelection() {
  if (!state.inlineOpen) return false;
  selectInlineItem(state.inlineActiveIdx);
  return true;
}

function updateInlineHighlight() {
  if (!inlineEl) return;
  var nodes = inlineEl.querySelectorAll(".codex-skill-item");
  nodes.forEach(function (el, i) {
    el.classList.toggle("active", i === state.inlineActiveIdx);
  });
  var activeEl = inlineEl.querySelector(".codex-skill-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function selectInlineItem(idx) {
  if (idx < 0 || idx >= state.inlineFiltered.length) return;
  var skill = state.inlineFiltered[idx];
  if (!skill || !skill.name) return;
  if (!ctx || !ctx.inputEl) return;
  // Replace the trigger token (`$query` or `/query`) with `$<name> `.
  var input = ctx.inputEl;
  var val = input.value;
  var startIdx = state.inlineTriggerStart >= 0 ? state.inlineTriggerStart : 0;
  // Find end of the current token: stop at first whitespace at/after cursor.
  var cursor = input.selectionStart;
  var endIdx = cursor;
  // If the user has more text after their query before whitespace, preserve
  // it (rare; happens when they paste). But typical case is endIdx === cursor.
  while (endIdx < val.length && !/\s/.test(val.charAt(endIdx))) endIdx++;
  var prefix = val.substring(0, startIdx);
  var suffix = val.substring(endIdx);
  var inserted = "$" + skill.name + " ";
  input.value = prefix + inserted + suffix;
  var newCursor = (prefix + inserted).length;
  input.setSelectionRange(newCursor, newCursor);
  hideInlineMenu();
  if (ctx.autoResize) ctx.autoResize();
  if (ctx.sendInputSync) ctx.sendInputSync();
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// --- Shared selection (header panel → input prefix) ---

function applySkillSelection(name) {
  if (!ctx || !ctx.inputEl) return;
  var input = ctx.inputEl;
  var existing = input.value;
  // If the input already starts with $<something>, replace that token; else
  // prepend `$<name> `. This makes the panel-click idempotent: re-clicking
  // a skill swaps cleanly instead of stacking.
  var m = /^\$([^\s$]+)(\s?)/.exec(existing);
  if (m) {
    input.value = "$" + name + " " + existing.substring(m[0].length);
  } else {
    input.value = "$" + name + " " + existing;
  }
  var pos = ("$" + name + " ").length;
  input.setSelectionRange(pos, pos);
  if (ctx.autoResize) ctx.autoResize();
  if (ctx.sendInputSync) ctx.sendInputSync();
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// --- Helpers ---

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
