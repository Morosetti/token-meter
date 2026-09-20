'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Where the CLI keeps its config. The directory name and the CLAUDE_CONFIG_DIR
 * env var are fixed by the CLI, not by us -- they are the only two strings in
 * this project that cannot be renamed without breaking data collection.
 */
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Directories to scan for transcripts. `extra` comes from user settings. */
function transcriptRoots(extra = []) {
  const roots = [path.join(configDir(), 'projects'), ...extra];
  return roots.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

/** Last-resort project name, from the encoded directory name. */
function projectLabel(dirName) {
  const parts = String(dirName).split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

/**
 * Name a project from the cwd recorded in the transcript. Scratch workspaces
 * the desktop app creates per session all collapse into one bucket, since their
 * random folder names mean nothing to the user.
 */
function projectFromCwd(cwd) {
  const norm = String(cwd).split(path.win32.sep).join('/').replace(/\/+$/, '');
  if (/\/scratch-workspaces\//i.test(norm)) return '(scratch)';
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || norm;
}

module.exports = { configDir, transcriptRoots, projectLabel, projectFromCwd };
