// session-message-cache.js - In-memory LRU cache for rendered session history.

var MAX_CACHED_SESSIONS = 100;
var records = {};
var lruKeys = [];
var activeCollect = null;

function clone(obj) {
  if (!obj) return obj;
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return Object.assign({}, obj); }
}

function cacheKey(slug, sessionId) {
  return (slug || "default") + ":" + sessionId;
}

function touch(key) {
  var next = [];
  for (var i = 0; i < lruKeys.length; i++) {
    if (lruKeys[i] !== key) next.push(lruKeys[i]);
  }
  next.push(key);
  lruKeys = next;
  while (lruKeys.length > MAX_CACHED_SESSIONS) {
    var evict = lruKeys.shift();
    delete records[evict];
  }
}

function messageFingerprint(item) {
  if (!item) return "";
  if (item.clientMessageId) return item.type + "|client:" + item.clientMessageId;
  if (item.uuid) return item.type + "|uuid:" + item.uuid;
  var text = "";
  if (typeof item.text === "string") text = item.text.substring(0, 120);
  return [
    item.type || "",
    item._ts || "",
    text,
    item.requestId || "",
    item.id || "",
  ].join("|");
}

function getLastItem(items) {
  for (var i = items.length - 1; i >= 0; i--) {
    if (items[i]) return items[i];
  }
  return null;
}

function getRecord(slug, sessionId) {
  var key = cacheKey(slug, sessionId);
  var rec = records[key];
  if (!rec) return null;
  touch(key);
  return clone(rec);
}

function putRecord(rec) {
  var key = cacheKey(rec.slug, rec.sessionId);
  var last = getLastItem(rec.items || []);
  rec.tailFingerprint = messageFingerprint(last);
  records[key] = clone(rec);
  touch(key);
}

function beginHistoryCollect(slug, sessionId, meta) {
  if (!sessionId || !meta) return;
  activeCollect = {
    slug: slug || "default",
    sessionId: sessionId,
    from: typeof meta.from === "number" ? meta.from : 0,
    to: typeof meta.total === "number" ? meta.total : 0,
    total: typeof meta.total === "number" ? meta.total : 0,
    items: [],
    doneMeta: null,
  };
}

function collectHistoryMessage(msg) {
  if (!activeCollect || !msg) return;
  activeCollect.items.push(clone(msg));
}

function finishHistoryCollect(doneMeta) {
  if (!activeCollect) return;
  activeCollect.doneMeta = clone(doneMeta || {});
  putRecord(activeCollect);
  activeCollect = null;
}

function cancelHistoryCollect() {
  activeCollect = null;
}

function mergePrepend(slug, sessionId, items, meta) {
  var key = cacheKey(slug, sessionId);
  var rec = records[key];
  if (!rec || !meta || typeof meta.from !== "number" || typeof meta.to !== "number") return;
  if (rec.from !== meta.to) return;
  rec.items = clone(items || []).concat(rec.items || []);
  rec.from = meta.from;
  putRecord(rec);
}

function pendingMatches(serverItem, pendingItem) {
  if (!serverItem || !pendingItem) return false;
  if (!pendingItem._pendingLocal) return false;
  if (serverItem.clientMessageId && pendingItem.clientMessageId) {
    return serverItem.clientMessageId === pendingItem.clientMessageId;
  }
  if (serverItem.type !== pendingItem.type) return false;
  if ((serverItem.text || "") !== (pendingItem.text || "")) return false;
  return true;
}

function mergeAppend(slug, sessionId, items, meta, doneMeta) {
  var key = cacheKey(slug, sessionId);
  var rec = records[key];
  if (!rec || !meta || typeof meta.from !== "number" || typeof meta.to !== "number") return;
  if (rec.to !== meta.from) return;
  var incoming = clone(items || []);
  var existing = rec.items || [];
  for (var i = 0; i < incoming.length; i++) {
    var serverItem = incoming[i];
    var last = existing.length > 0 ? existing[existing.length - 1] : null;
    if (pendingMatches(serverItem, last)) {
      existing[existing.length - 1] = serverItem;
    } else {
      existing.push(serverItem);
    }
  }
  rec.items = existing;
  rec.to = meta.to;
  rec.total = typeof meta.total === "number" ? meta.total : meta.to;
  if (doneMeta) rec.doneMeta = clone(doneMeta);
  putRecord(rec);
}

function appendLiveMessage(slug, sessionId, msg) {
  var key = cacheKey(slug, sessionId);
  var rec = records[key];
  if (!rec || !msg) return;
  rec.items.push(clone(msg));
  rec.to += 1;
  rec.total = Math.max(rec.total || 0, rec.to);
  putRecord(rec);
}

function appendOptimisticUserMessage(slug, sessionId, msg) {
  var key = cacheKey(slug, sessionId);
  var rec = records[key];
  if (!rec || !msg) return;
  var item = clone(msg);
  item._pendingLocal = true;
  rec.items.push(item);
  rec.to += 1;
  rec.total = Math.max(rec.total || 0, rec.to);
  putRecord(rec);
}

function replaceWithHistory(slug, sessionId, meta, items, doneMeta) {
  putRecord({
    slug: slug || "default",
    sessionId: sessionId,
    from: typeof meta.from === "number" ? meta.from : 0,
    to: typeof meta.to === "number" ? meta.to : (typeof meta.total === "number" ? meta.total : 0),
    total: typeof meta.total === "number" ? meta.total : 0,
    items: clone(items || []),
    doneMeta: clone(doneMeta || {}),
  });
}

export {
  getRecord,
  beginHistoryCollect,
  collectHistoryMessage,
  finishHistoryCollect,
  cancelHistoryCollect,
  mergePrepend,
  mergeAppend,
  appendLiveMessage,
  appendOptimisticUserMessage,
  replaceWithHistory,
  messageFingerprint,
};
