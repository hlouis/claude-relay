// Backend registry — lazy, per-project map of agent backend instances.
//
// Why this exists (iter 2):
//
//   Iter 1 froze each session's backend identity into its JSONL. Iter 2
//   needs to honor that identity at runtime: every `sdk.xxx()` operation
//   in project.js must route to the SDK matching `session.backend`, never
//   to a single project-level SDK.
//
//   The data structure is trivial — a name → SDK map with lazy creation —
//   but it carries an important invariant: instantiation policy is
//   "lazy" (per the iter 2 plan), so a project that only ever runs
//   Claude sessions never spawns a Codex CLI subprocess, and vice versa.
//
//   Extracting this from project.js gives us:
//     1. A unit-testable seam (project.js itself has no unit tests today).
//     2. A stable contract for future helpers — kill_process, info
//        broadcasts, status panels — that need to ask "is the X SDK
//        currently alive in this project?" without forcing instantiation.
//
// Usage:
//
//   var reg = createBackendRegistry({
//     factory: function (name) { return createAgentBackend({ backend: name, ... }); },
//     defaultBackend: "claude",
//   });
//   reg.getSdkFor("codex");        // creates on first call
//   reg.sdkForSession(session);    // routes by session.backend (frozen identity)
//   reg.defaultSdk();              // always returns the project default's SDK
//   reg.hasBackend("codex");       // true iff codex was ever instantiated
//
// Caller responsibilities:
//   - factory(name) MUST return an object with the AgentBackend surface or
//     throw. The registry does not validate the surface.
//   - factory may be invoked at most once per name. The result is cached
//     for the registry's lifetime.

function createBackendRegistry(opts) {
  if (!opts || typeof opts.factory !== "function") {
    throw new Error("createBackendRegistry: factory function is required");
  }
  var defaultBackend = opts.defaultBackend || "claude";
  var instances = {};

  function getSdkFor(backendName) {
    var name = backendName || defaultBackend;
    if (!instances[name]) {
      instances[name] = opts.factory(name);
    }
    return instances[name];
  }

  // Routes by session.backend. A session created in iter 1 always has a
  // frozen `backend` field; falling back to defaultBackend handles edge
  // cases (no session in scope, or a degraded session object) so callers
  // don't need null-guards at every site.
  function sdkForSession(session) {
    return getSdkFor(session && session.backend);
  }

  function defaultSdk() {
    return getSdkFor(defaultBackend);
  }

  // Non-instantiating peek. Useful when an operation is only meaningful
  // if the backend is already in use (e.g., kill_process refuses unless
  // a Claude SDK has actually been spawned in this project).
  function hasBackend(backendName) {
    var name = backendName || defaultBackend;
    return Object.prototype.hasOwnProperty.call(instances, name);
  }

  return {
    getSdkFor: getSdkFor,
    sdkForSession: sdkForSession,
    defaultSdk: defaultSdk,
    hasBackend: hasBackend,
  };
}

module.exports = { createBackendRegistry: createBackendRegistry };
