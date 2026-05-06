var sdkBridge = require("./sdk-bridge");
var codexBackend = require("./codex-backend");
var createSDKBridge = sdkBridge.createSDKBridge;
var createCodexBackend = codexBackend.createCodexBackend;

// AgentBackend factory.
//
// Returns the agent backend implementation for a project. Today only the
// Claude backend exists (a thin alias of the existing SDK bridge). The Codex
// backend lands in iteration 1.
//
// All backends expose the same surface so project.js stays backend-agnostic:
//
//   startQuery(session, text, images, linuxUser)
//   pushMessage(session, text, images)
//   setModel(session, model)
//   setEffort(session, effort)
//   setPermissionMode(session, mode)
//   stopTask(taskId)
//   warmup(linuxUser)
//   handleCanUseTool, handleElicitation
//   processQueryStream, processSDKMessage
//   getOrCreateRewindQuery
//   isClaudeProcess
//   permissionPushTitle, permissionPushBody
//   createMessageQueue
//
// The "internal helpers" half of that list (processSDKMessage, createMessageQueue,
// getOrCreateRewindQuery, isClaudeProcess) is Claude-specific and is expected
// to shrink as the interface settles in later iterations. project.js currently
// reaches into them; that coupling is tracked and will be cleaned up before
// Codex needs to deviate.
//
// Selection:
//   opts.backend === "claude"  (default)
//   opts.backend === "codex"   (introduced in iteration 1)
function createAgentBackend(opts) {
  var backend = (opts && opts.backend) || "claude";
  if (backend === "claude") {
    return createSDKBridge(opts);
  }
  if (backend === "codex") {
    return createCodexBackend(opts);
  }
  throw new Error("Unknown agent backend: " + backend);
}

// Returns the static capability declaration for a backend. Today only the
// supported-settings list is exposed; future capabilities (rewind / fork /
// skills / connectors) can grow into the same record without changing the
// caller contract.
//
// project.js calls this once per `info` broadcast and forwards the result
// to the frontend as `info.capabilities`. The frontend uses it (Iter 3
// step 3 onwards) to drive the settings drawer and avoid sending control
// messages for keys the backend doesn't honor.
//
// Unknown backend names return an empty settings list rather than throw —
// the createAgentBackend() call site already validates the name, and an
// info-broadcast path should never crash a project just because someone
// added a typo.
function getBackendCapabilities(backend) {
  var name = backend || "claude";
  if (name === "claude") {
    return { settings: (sdkBridge.SUPPORTED_SETTINGS || []).slice() };
  }
  if (name === "codex") {
    return { settings: (codexBackend.SUPPORTED_SETTINGS || []).slice() };
  }
  return { settings: [] };
}

module.exports = { createAgentBackend, getBackendCapabilities };
