var pty;
try {
  pty = require("@lydell/node-pty");
} catch (e) {
  pty = null;
}

function createTerminal(cwd, cols, rows, osUserInfo) {
  if (!pty) return null;

  var shell = process.env.SHELL
    || (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/bash");

  // OS-level user isolation: spawn terminal as the mapped Linux user
  var termEnv = Object.assign({}, process.env, { TERM: "xterm-256color" });
  var spawnOpts = {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd,
    env: termEnv,
  };

  if (osUserInfo) {
    spawnOpts.uid = osUserInfo.uid;
    spawnOpts.gid = osUserInfo.gid;
    // Use the target user's shell and home
    termEnv.HOME = osUserInfo.home;
    termEnv.USER = osUserInfo.user;
    termEnv.LOGNAME = osUserInfo.user;
    // Use target user's shell if available
    if (osUserInfo.shell) shell = osUserInfo.shell;
  }

  var args = osUserInfo ? ["-l"] : [];
  var term = pty.spawn(shell, args, spawnOpts);

  return term;
}

module.exports = { createTerminal: createTerminal };
