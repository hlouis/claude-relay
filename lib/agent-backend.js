var { createSDKBridge } = require("./sdk-bridge");
var { createCodexBackend } = require("./codex-backend");

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

module.exports = { createAgentBackend };
