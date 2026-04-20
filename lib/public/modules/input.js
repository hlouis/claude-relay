import { iconHtml, refreshIcons } from './icons.js';
import { setRewindMode, isRewindMode } from './rewind.js';

var ctx;

// --- State ---
var pendingImages = []; // [{data: base64, mediaType: "image/png"}]
var pendingPastes = []; // [{text: string, preview: string}]
var pendingFiles = []; // [{name: string, path: string}]
var uploadingCount = 0;
var slashActiveIdx = -1;
var slashFiltered = [];
var isComposing = false;
var isRemoteInput = false;

// --- @ file path completion state ---
var atActiveIdx = -1;
var atFiltered = [];       // current visible entries [{name, type, path}]
var atAllEntries = [];     // all entries from last fs_list_result (unfiltered)
var atTriggerPos = -1;     // position of @ in inputEl.value
var atLastRequestedDir = null; // last directory we requested via fs_list
var atFilterQuery = "";    // current filter text after the directory portion

export var builtinCommands = [
  { name: "clear", desc: "Clear conversation" },
  { name: "context", desc: "Context window usage" },
  { name: "rewind", desc: "Toggle rewind mode" },
  { name: "usage", desc: "Toggle usage panel" },
  { name: "status", desc: "Process status and resource usage" },
];

// --- Send ---
export function sendMessage() {
  // DM mode intercept: if in DM mode, route to DM handler instead
  if (ctx.isDmMode && ctx.isDmMode() && ctx.handleDmSend) {
    ctx.handleDmSend();
    return;
  }
  var text = ctx.inputEl.value.trim();
  var images = pendingImages.slice();
  if (!text && images.length === 0 && pendingPastes.length === 0 && pendingFiles.length === 0) return;
  if (uploadingCount > 0) return; // wait for uploads to finish
  hideSlashMenu();
  if (ctx.hideSuggestionChips) ctx.hideSuggestionChips();

  if (text === "/clear") {
    ctx.inputEl.value = "";
    clearPendingImages();
    autoResize();
    if (ctx.ws && ctx.connected) {
      ctx.ws.send(JSON.stringify({ type: "new_session" }));
    }
    return;
  }

  if (text === "/rewind") {
    ctx.inputEl.value = "";
    clearPendingImages();
    autoResize();
    if (ctx.messageUuidMap().length === 0) {
      ctx.addSystemMessage("No rewind points available in this session.", true);
    } else {
      setRewindMode(!isRewindMode());
    }
    return;
  }

  if (text === "/context") {
    ctx.inputEl.value = "";
    clearPendingImages();
    autoResize();
    if (ctx.toggleContextPanel) ctx.toggleContextPanel();
    return;
  }

  if (text === "/usage") {
    ctx.inputEl.value = "";
    clearPendingImages();
    autoResize();
    if (ctx.toggleUsagePanel) ctx.toggleUsagePanel();
    return;
  }

  if (text === "/status") {
    ctx.inputEl.value = "";
    clearPendingImages();
    autoResize();
    if (ctx.toggleStatusPanel) ctx.toggleStatusPanel();
    return;
  }

  if (!ctx.connected) {
    ctx.addSystemMessage("Not connected — message not sent.", true);
    return;
  }

  // Prepend file paths to text
  var files = pendingFiles.slice();
  if (files.length > 0) {
    var filePaths = files.map(function (f) { return "[Uploaded file: " + f.path + "]"; }).join("\n");
    text = text ? filePaths + "\n\n" + text : filePaths;
  }

  var pastes = pendingPastes.map(function (p) { return p.text; });
  var clientMsgId = (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Date.now().toString(36) + Math.random().toString(36).slice(2));
  ctx.addUserMessage(text, images.length > 0 ? images : null, pastes.length > 0 ? pastes : null, clientMsgId);

  var payload = { type: "message", text: text || "", clientMsgId: clientMsgId };
  if (images.length > 0) {
    payload.images = images;
  }
  if (pastes.length > 0) {
    payload.pastes = pastes;
  }
  ctx.ws.send(JSON.stringify(payload));

  ctx.inputEl.value = "";
  sendInputSync();
  clearPendingImages();
  autoResize();
  if ("ontouchstart" in window) {
    ctx.inputEl.blur();
  } else {
    ctx.inputEl.focus();
  }
  // Input cleared — switch back to stop mode if still processing
  if (ctx.processing && ctx.setSendBtnMode) {
    ctx.setSendBtnMode("stop");
  }
}

export function autoResize() {
  ctx.inputEl.style.height = "auto";
  ctx.inputEl.style.height = Math.min(ctx.inputEl.scrollHeight, 120) + "px";
}

// --- File path extraction from clipboard ---
function extractFilePaths(cd) {
  var paths = [];

  // 1. Check text/uri-list for file:// URIs (Finder on some browsers)
  var uriList = cd.getData("text/uri-list");
  if (uriList) {
    var lines = uriList.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line && !line.startsWith("#") && line.startsWith("file://")) {
        paths.push(decodeURIComponent(line.replace("file://", "")));
      }
    }
    if (paths.length > 0) return paths;
  }

  // 2. Check if text/plain looks like file path(s) while files are present
  //    (Finder Cmd+C puts filename in text/plain, Cmd+Option+C puts full path)
  if (cd.files && cd.files.length > 0) {
    var plainText = cd.getData("text/plain");
    if (plainText) {
      var textLines = plainText.split(/\r?\n/).filter(function (l) { return l.trim(); });
      for (var i = 0; i < textLines.length; i++) {
        var p = textLines[i].trim();
        if (p.startsWith("/") || p.startsWith("~")) {
          paths.push(p);
        }
      }
      if (paths.length > 0) return paths;
    }
    // 3. Fallback: files present but no path in text, use filenames
    for (var i = 0; i < cd.files.length; i++) {
      var f = cd.files[i];
      if (f.name && f.type.indexOf("image/") !== 0) {
        paths.push(f.name);
      }
    }
  }

  return paths;
}

// --- Insert text at cursor in textarea ---
function insertTextAtCursor(text) {
  var el = ctx.inputEl;
  el.focus();
  var start = el.selectionStart;
  var end = el.selectionEnd;
  var before = el.value.substring(0, start);
  var after = el.value.substring(end);
  // Add space before if cursor is right after non-space text
  if (before.length > 0 && before[before.length - 1] !== " " && before[before.length - 1] !== "\n") {
    text = " " + text;
  }
  el.value = before + text + after;
  el.selectionStart = el.selectionEnd = start + text.length;
  autoResize();
  sendInputSync();
}

// --- Image paste ---
function addPendingImage(dataUrl) {
  var commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return;
  var header = dataUrl.substring(0, commaIdx);
  var data = dataUrl.substring(commaIdx + 1);
  var typeMatch = header.match(/data:(image\/[^;,]+)/);
  if (!typeMatch || !data) return;
  pendingImages.push({ mediaType: typeMatch[1], data: data });
  renderInputPreviews();
}

function removePendingImage(idx) {
  pendingImages.splice(idx, 1);
  renderInputPreviews();
}

export function clearPendingImages() {
  pendingImages = [];
  pendingPastes = [];
  pendingFiles = [];
  renderInputPreviews();
}

function removePendingPaste(idx) {
  pendingPastes.splice(idx, 1);
  renderInputPreviews();
}

function removePendingFile(idx) {
  pendingFiles.splice(idx, 1);
  renderInputPreviews();
}

function renderInputPreviews() {
  var bar = ctx.imagePreviewBar;
  bar.innerHTML = "";
  if (pendingImages.length === 0 && pendingPastes.length === 0 && pendingFiles.length === 0 && uploadingCount === 0) {
    bar.classList.remove("visible");
    return;
  }
  bar.classList.add("visible");

  // Image thumbnails
  for (var i = 0; i < pendingImages.length; i++) {
    (function (idx) {
      var wrap = document.createElement("div");
      wrap.className = "image-preview-thumb";
      var img = document.createElement("img");
      img.src = "data:" + pendingImages[idx].mediaType + ";base64," + pendingImages[idx].data;
      img.addEventListener("click", function () {
        if (ctx.showImageModal) ctx.showImageModal(this.src);
      });
      var removeBtn = document.createElement("button");
      removeBtn.className = "image-preview-remove";
      removeBtn.innerHTML = iconHtml("x");
      removeBtn.addEventListener("click", function () {
        removePendingImage(idx);
      });
      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      bar.appendChild(wrap);
    })(i);
  }

  // File chips
  for (var fi = 0; fi < pendingFiles.length; fi++) {
    (function (idx) {
      var chip = document.createElement("div");
      chip.className = "file-chip";
      var icon = document.createElement("span");
      icon.className = "file-chip-icon";
      icon.innerHTML = iconHtml("file");
      var nameSpan = document.createElement("span");
      nameSpan.className = "file-chip-name";
      nameSpan.textContent = pendingFiles[idx].name;
      var removeBtn = document.createElement("button");
      removeBtn.className = "file-chip-remove";
      removeBtn.innerHTML = iconHtml("x");
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        removePendingFile(idx);
      });
      chip.appendChild(icon);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    })(fi);
  }

  // Uploading indicator
  if (uploadingCount > 0) {
    var chip = document.createElement("div");
    chip.className = "file-chip file-chip-uploading";
    var spinner = document.createElement("span");
    spinner.className = "file-chip-spinner";
    var label = document.createElement("span");
    label.className = "file-chip-name";
    label.textContent = "Uploading" + (uploadingCount > 1 ? " (" + uploadingCount + ")" : "") + "...";
    chip.appendChild(spinner);
    chip.appendChild(label);
    bar.appendChild(chip);
  }

  // Pasted content chips
  for (var j = 0; j < pendingPastes.length; j++) {
    (function (idx) {
      var chip = document.createElement("div");
      chip.className = "pasted-chip";
      var preview = document.createElement("span");
      preview.className = "pasted-chip-preview";
      preview.textContent = pendingPastes[idx].preview;
      var label = document.createElement("span");
      label.className = "pasted-chip-label";
      label.textContent = "PASTED";
      var removeBtn = document.createElement("button");
      removeBtn.className = "pasted-chip-remove";
      removeBtn.innerHTML = iconHtml("x");
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        removePendingPaste(idx);
      });
      chip.appendChild(preview);
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    })(j);
  }

  refreshIcons();
}

var MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
var RESIZE_MAX_DIM = 1920;
var RESIZE_QUALITY = 0.85;
var MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// --- File upload ---
function uploadFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    if (ctx.addSystemMessage) ctx.addSystemMessage("File too large (max 50MB): " + file.name, true);
    return;
  }
  uploadingCount++;
  renderInputPreviews();
  var reader = new FileReader();
  reader.onload = function (ev) {
    var dataUrl = ev.target.result;
    var commaIdx = dataUrl.indexOf(",");
    var b64 = commaIdx !== -1 ? dataUrl.substring(commaIdx + 1) : "";

    var xhr = new XMLHttpRequest();
    xhr.open("POST", ctx.basePath + "api/upload");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () {
      uploadingCount--;
      if (xhr.status === 200) {
        try {
          var resp = JSON.parse(xhr.responseText);
          pendingFiles.push({ name: resp.name || file.name, path: resp.path });
        } catch (e) {}
      } else {
        if (ctx.addSystemMessage) ctx.addSystemMessage("Upload failed: " + file.name, true);
      }
      renderInputPreviews();
    };
    xhr.onerror = function () {
      uploadingCount--;
      if (ctx.addSystemMessage) ctx.addSystemMessage("Upload failed: " + file.name, true);
      renderInputPreviews();
    };
    xhr.send(JSON.stringify({ name: file.name, data: b64 }));
  };
  reader.readAsDataURL(file);
}

function readImageBlob(blob) {
  var reader = new FileReader();
  reader.onload = function (ev) {
    var dataUrl = ev.target.result;
    // Check base64 payload size (~3/4 of base64 length)
    var commaIdx = dataUrl.indexOf(",");
    var b64 = commaIdx !== -1 ? dataUrl.substring(commaIdx + 1) : "";
    var estimatedBytes = b64.length * 0.75;

    if (estimatedBytes <= MAX_IMAGE_BYTES) {
      addPendingImage(dataUrl);
      return;
    }

    // Resize via canvas
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var scale = Math.min(RESIZE_MAX_DIM / Math.max(w, h), 1);
      var nw = Math.round(w * scale);
      var nh = Math.round(h * scale);
      var canvas = document.createElement("canvas");
      canvas.width = nw;
      canvas.height = nh;
      var cx = canvas.getContext("2d");
      cx.drawImage(img, 0, 0, nw, nh);
      var resized = canvas.toDataURL("image/jpeg", RESIZE_QUALITY);
      addPendingImage(resized);
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(blob);
}

// --- Slash menu ---
function getAllCommands() {
  return builtinCommands.concat(ctx.slashCommands());
}

function showSlashMenu(filter) {
  var query = filter.toLowerCase();
  slashFiltered = getAllCommands().filter(function (c) {
    return c.name.toLowerCase().indexOf(query) !== -1;
  });
  if (slashFiltered.length === 0) { hideSlashMenu(); return; }

  slashActiveIdx = 0;
  ctx.slashMenu.innerHTML = slashFiltered.map(function (c, i) {
    return '<div class="slash-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
      '<span class="slash-cmd">/' + c.name + '</span>' +
      '<span class="slash-desc">' + c.desc + '</span>' +
      '</div>';
  }).join("");
  ctx.slashMenu.classList.add("visible");

  ctx.slashMenu.querySelectorAll(".slash-item").forEach(function (el) {
    el.addEventListener("click", function () {
      selectSlashItem(parseInt(el.dataset.idx));
    });
  });
}

export function hideSlashMenu() {
  ctx.slashMenu.classList.remove("visible");
  ctx.slashMenu.innerHTML = "";
  slashActiveIdx = -1;
  slashFiltered = [];
}

function selectSlashItem(idx) {
  if (idx < 0 || idx >= slashFiltered.length) return;
  var cmd = slashFiltered[idx];
  ctx.inputEl.value = "/" + cmd.name + " ";
  hideSlashMenu();
  autoResize();
  ctx.inputEl.focus();
}

function updateSlashHighlight() {
  ctx.slashMenu.querySelectorAll(".slash-item").forEach(function (el, i) {
    el.classList.toggle("active", i === slashActiveIdx);
  });
  var activeEl = ctx.slashMenu.querySelector(".slash-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

// --- @ file path autocomplete ---

function detectAtToken() {
  var val = ctx.inputEl.value;
  var cursor = ctx.inputEl.selectionStart;
  // Scan backward from cursor to find @
  var i = cursor - 1;
  while (i >= 0) {
    var ch = val[i];
    if (ch === "@") {
      // @ must be at start of input or preceded by whitespace/newline
      if (i === 0 || /\s/.test(val[i - 1])) {
        return { start: i, query: val.substring(i + 1, cursor) };
      }
      return null;
    }
    // Stop scanning if we hit whitespace (no @ token here)
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

function triggerAtMenu(query) {
  var dir = ".";
  var filter = query;

  var lastSlash = query.lastIndexOf("/");
  if (lastSlash !== -1) {
    dir = query.substring(0, lastSlash) || ".";
    filter = query.substring(lastSlash + 1);
  }

  atFilterQuery = filter.toLowerCase();

  // Only request from server if directory changed
  if (dir !== atLastRequestedDir) {
    atLastRequestedDir = dir;
    if (ctx.ws && ctx.connected) {
      ctx.ws.send(JSON.stringify({ type: "fs_list", path: dir, source: "at-complete" }));
    }
  } else {
    // Re-filter existing entries
    renderAtFiltered();
  }
}

export function handleAtFsListResult(msg) {
  if (!msg.entries) return;
  atAllEntries = msg.entries.slice();
  renderAtFiltered();
}

function renderAtFiltered() {
  if (atAllEntries.length === 0) { hideAtMenu(); return; }

  var entries = atAllEntries.filter(function (e) {
    return e.name.toLowerCase().indexOf(atFilterQuery) !== -1;
  });

  // Sort: directories first, then alphabetical
  entries.sort(function (a, b) {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (entries.length === 0) { hideAtMenu(); return; }

  atFiltered = entries;
  atActiveIdx = 0;
  showAtMenu(entries);
}

function showAtMenu(entries) {
  ctx.atMenu.innerHTML = entries.map(function (e, i) {
    var icon = e.type === "dir" ? "folder" : "file";
    var iconClass = e.type === "dir" ? "at-icon at-icon-dir" : "at-icon";
    var displayName = e.name + (e.type === "dir" ? "/" : "");
    return '<div class="at-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
      '<span class="' + iconClass + '">' + iconHtml(icon) + '</span>' +
      '<span class="at-name">' + displayName + '</span>' +
      '</div>';
  }).join("");
  ctx.atMenu.classList.add("visible");
  refreshIcons(ctx.atMenu);

  ctx.atMenu.querySelectorAll(".at-item").forEach(function (el) {
    el.addEventListener("click", function () {
      selectAtItem(parseInt(el.dataset.idx));
    });
  });
}

export function hideAtMenu() {
  if (!ctx.atMenu) return;
  ctx.atMenu.classList.remove("visible");
  ctx.atMenu.innerHTML = "";
  atActiveIdx = -1;
  atFiltered = [];
  atAllEntries = [];
  atLastRequestedDir = null;
  atFilterQuery = "";
  atTriggerPos = -1;
}

function selectAtItem(idx) {
  if (idx < 0 || idx >= atFiltered.length) return;
  var entry = atFiltered[idx];
  var val = ctx.inputEl.value;

  if (entry.type === "dir") {
    // Replace text after @ with dir path + "/"
    var newPath = entry.path + "/";
    var before = val.substring(0, atTriggerPos + 1); // include @
    var after = val.substring(ctx.inputEl.selectionStart);
    ctx.inputEl.value = before + newPath + after;
    var newCursor = atTriggerPos + 1 + newPath.length;
    ctx.inputEl.selectionStart = ctx.inputEl.selectionEnd = newCursor;
    autoResize();
    // Trigger directory listing for the new path
    atLastRequestedDir = null; // force re-request
    triggerAtMenu(newPath);
  } else {
    // Insert file path and close menu
    var filePath = entry.path;
    var before = val.substring(0, atTriggerPos + 1); // include @
    var after = val.substring(ctx.inputEl.selectionStart);
    ctx.inputEl.value = before + filePath + " " + after;
    var newCursor = atTriggerPos + 1 + filePath.length + 1;
    ctx.inputEl.selectionStart = ctx.inputEl.selectionEnd = newCursor;
    hideAtMenu();
    autoResize();
  }
  ctx.inputEl.focus();
}

function updateAtHighlight() {
  ctx.atMenu.querySelectorAll(".at-item").forEach(function (el, i) {
    el.classList.toggle("active", i === atActiveIdx);
  });
  var activeEl = ctx.atMenu.querySelector(".at-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function isAtMenuVisible() {
  return atFiltered.length > 0 && ctx.atMenu && ctx.atMenu.classList.contains("visible");
}

// --- Input sync across devices ---
function sendInputSync() {
  if (isRemoteInput) return;
  if (!ctx.ws || !ctx.connected) return;
  // In DM mode, send typing indicator instead of input_sync
  if (ctx.isDmMode && ctx.isDmMode()) {
    var hasText = ctx.inputEl.value.length > 0;
    var dk = ctx.getDmKey ? ctx.getDmKey() : null;
    if (dk) ctx.ws.send(JSON.stringify({ type: "dm_typing", dmKey: dk, typing: hasText }));
    return;
  }
  ctx.ws.send(JSON.stringify({ type: "input_sync", text: ctx.inputEl.value }));
}

export function handleInputSync(text) {
  isRemoteInput = true;
  ctx.inputEl.value = text;
  autoResize();
  isRemoteInput = false;
}

function createFileInput(accept, capture, multiple) {
  var input = document.createElement("input");
  input.type = "file";
  if (accept) input.accept = accept;
  if (capture) input.setAttribute("capture", capture);
  if (multiple) input.multiple = true;
  input.style.display = "none";
  document.body.appendChild(input);

  input.addEventListener("change", function () {
    if (input.files) {
      for (var i = 0; i < input.files.length; i++) {
        if (input.files[i].type.indexOf("image/") === 0) {
          readImageBlob(input.files[i]);
        } else {
          uploadFile(input.files[i]);
        }
      }
    }
    document.body.removeChild(input);
  });

  input.click();
}

// --- Init ---
export function initInput(_ctx) {
  ctx = _ctx;

  // File (clip) button — opens file picker for all types
  var attachFileBtn = document.getElementById("attach-file-btn");
  if (attachFileBtn) {
    attachFileBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      createFileInput(null, null, true);
    });
  }

  // Image button — opens image picker (OS handles camera/gallery choice)
  var attachImageBtn = document.getElementById("attach-image-btn");
  if (attachImageBtn) {
    attachImageBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      createFileInput("image/*", null, true);
    });
  }

  // Paste handler
  document.addEventListener("paste", function (e) {
    // Don't intercept paste when typing in sticky notes or other non-chat textareas
    var target = e.target;
    if (target && target.closest && target.closest(".sticky-note, #notes-archive")) return;

    var cd = e.clipboardData;
    if (!cd) return;

    var found = false;

    // Try clipboardData.files first (better Safari/iOS support)
    if (cd.files && cd.files.length > 0) {
      for (var i = 0; i < cd.files.length; i++) {
        if (cd.files[i].type.indexOf("image/") === 0) {
          found = true;
          readImageBlob(cd.files[i]);
        } else if (cd.files[i].name) {
          found = true;
          uploadFile(cd.files[i]);
        }
      }
    }

    // Fall back to clipboardData.items
    if (!found && cd.items) {
      for (var i = 0; i < cd.items.length; i++) {
        if (cd.items[i].type.indexOf("image/") === 0) {
          var blob = cd.items[i].getAsFile();
          if (blob) {
            found = true;
            readImageBlob(blob);
          }
        } else if (cd.items[i].kind === "file") {
          var fileBlob = cd.items[i].getAsFile();
          if (fileBlob && fileBlob.name) {
            found = true;
            uploadFile(fileBlob);
          }
        }
      }
    }

    // File path paste: detect file:// URIs or Finder file references
    if (!found) {
      var filePaths = extractFilePaths(cd);
      if (filePaths.length > 0) {
        e.preventDefault();
        insertTextAtCursor(filePaths.join("\n"));
        found = true;
      }
    }

    // Long text paste → pasted chip
    if (!found) {
      var pastedText = cd.getData("text/plain");
      if (pastedText && pastedText.length >= 500) {
        e.preventDefault();
        var preview = pastedText.substring(0, 50).replace(/\n/g, " ");
        if (pastedText.length > 50) preview += "...";
        pendingPastes.push({ text: pastedText, preview: preview });
        renderInputPreviews();
        found = true;
      }
    }

    if (found) e.preventDefault();
  });

  // Input event handlers
  ctx.inputEl.addEventListener("input", function () {
    autoResize();
    sendInputSync();
    if (ctx.hideSuggestionChips) ctx.hideSuggestionChips();
    var val = ctx.inputEl.value;
    if (val.startsWith("/") && !val.includes(" ") && val.length > 1) {
      showSlashMenu(val.substring(1));
    } else if (val === "/") {
      showSlashMenu("");
    } else {
      hideSlashMenu();
    }
    // @ file path completion
    var atToken = detectAtToken();
    if (atToken) {
      atTriggerPos = atToken.start;
      triggerAtMenu(atToken.query);
    } else {
      hideAtMenu();
    }
    // Toggle send/stop button based on input content during processing
    if (ctx.processing && ctx.setSendBtnMode) {
      ctx.setSendBtnMode(val.trim() ? "send" : "stop");
    }
  });

  ctx.inputEl.addEventListener("compositionstart", function () { isComposing = true; });
  ctx.inputEl.addEventListener("compositionend", function () { isComposing = false; });

  ctx.inputEl.addEventListener("keydown", function (e) {
    if (slashFiltered.length > 0 && ctx.slashMenu.classList.contains("visible")) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashActiveIdx = (slashActiveIdx + 1) % slashFiltered.length;
        updateSlashHighlight();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashActiveIdx = (slashActiveIdx - 1 + slashFiltered.length) % slashFiltered.length;
        updateSlashHighlight();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlashItem(slashActiveIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlashMenu();
        return;
      }
    }

    // @ file path menu keyboard navigation
    if (isAtMenuVisible()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        atActiveIdx = (atActiveIdx + 1) % atFiltered.length;
        updateAtHighlight();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        atActiveIdx = (atActiveIdx - 1 + atFiltered.length) % atFiltered.length;
        updateAtHighlight();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectAtItem(atActiveIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideAtMenu();
        return;
      }
    }

    // Shift+Tab: cycle permission mode (like Claude CLI)
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (ctx.cycleMode) ctx.cycleMode();
      return;
    }

    // Ctrl+J: insert newline (like Claude CLI)
    if (e.key === "j" && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      var ta = ctx.inputEl;
      var start = ta.selectionStart;
      var end = ta.selectionEnd;
      var val = ta.value;
      ta.value = val.substring(0, start) + "\n" + val.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
      autoResize();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      // Touch device: only block Enter (insert newline) when the virtual
      // keyboard is confirmed open (.keyboard-open).  When there's no
      // virtual keyboard (external keyboard), Enter sends like desktop.
      // Also respect .ipad-extkey which is set after focusin detection.
      if ("ontouchstart" in window &&
          document.documentElement.classList.contains("keyboard-open") &&
          !document.documentElement.classList.contains("ipad-extkey")) {
        return;
      }
      e.preventDefault();
      sendMessage();
    }
  });

  // Mobile: switch enterkeyhint to "enter" so keyboard shows return key
  if ("ontouchstart" in window) {
    ctx.inputEl.setAttribute("enterkeyhint", "enter");
  }

  // Send/Stop button — if input has text, always send; otherwise stop
  ctx.sendBtn.addEventListener("click", function () {
    if (ctx.inputEl.value.trim()) {
      sendMessage();
      return;
    }
    if (ctx.processing && ctx.connected) {
      ctx.ws.send(JSON.stringify({ type: "stop" }));
    }
  });
  ctx.sendBtn.addEventListener("dblclick", function (e) { e.preventDefault(); });
}
