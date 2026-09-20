'use strict';
const fs = require('fs');
const path = require('path');
const { transcriptRoots, projectLabel, projectFromCwd } = require('./paths');

/**
 * Incremental reader for the CLI transcript logs.
 *
 * Transcripts are append-only JSONL. We remember the byte offset we stopped at
 * for every file and only parse the bytes that were appended since. A full
 * rescan of 18 files costs ~40ms; an incremental tick costs ~0ms. Because we
 * always cut the buffer at a newline, a multi-byte UTF-8 char can never be
 * split across two reads.
 */
class Reader {
  constructor({ retentionDays = 45 } = {}) {
    this.retentionDays = retentionDays;
    this.files = new Map();   // absolute path -> { offset, entries: [] }
    this.seen = new Set();    // entry ids, for cross-file dedup
  }

  /** Re-scan every root. Returns the flat, time-sorted entry list. */
  scan(extraRoots = []) {
    const alive = new Set();
    for (const root of transcriptRoots(extraRoots)) {
      let dirs;
      try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const project = projectLabel(d.name);
        const dir = path.join(root, d.name);
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const file = path.join(dir, name);
          alive.add(file);
          this._readFile(file, project);
        }
      }
    }
    // Drop state for transcripts that disappeared.
    for (const file of [...this.files.keys()]) {
      if (!alive.has(file)) this.files.delete(file);
    }
    return this.entries();
  }

  _readFile(file, project) {
    let st;
    try { st = fs.statSync(file); } catch { return; }

    let state = this.files.get(file);
    // File shrank => it was rotated or rewritten. Start over on it.
    if (state && st.size < state.offset) {
      for (const e of state.entries) this.seen.delete(e.id);
      state = null;
    }
    if (!state) state = { offset: 0, entries: [] };
    if (st.size === state.offset) { this.files.set(file, state); return; }

    const start = state.offset;
    const len = st.size - start;
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      text = buf.toString('utf8', 0, read);
    } catch { return; }

    // Only consume up to the last complete line; the tail is re-read next tick.
    const cut = text.lastIndexOf('\n');
    if (cut === -1) { this.files.set(file, state); return; }
    const consumed = Buffer.byteLength(text.slice(0, cut + 1), 'utf8');

    for (const line of text.slice(0, cut).split('\n')) {
      const e = parseLine(line, project);
      if (!e || this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      state.entries.push(e);
    }
    state.offset = start + consumed;
    this.files.set(file, state);
  }

  /** All entries inside the retention window, oldest first. */
  entries() {
    const floor = Date.now() - this.retentionDays * 864e5;
    const out = [];
    for (const state of this.files.values()) {
      for (const e of state.entries) if (e.t >= floor) out.push(e);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
}

/** Pull one usage record out of a transcript line, or null if it has none. */
function parseLine(line, project) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  // Cheap pre-filter: skip the JSON.parse for the ~95% of lines without usage.
  if (line.indexOf('"usage"') === -1) return null;

  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== 'assistant') return null;
  const m = o.message;
  if (!m || typeof m !== 'object') return null;
  const u = m.usage;
  if (!u) return null;
  // "<synthetic>" records are locally-generated messages, not billed API calls.
  if (!m.model || m.model === '<synthetic>') return null;

  const t = Date.parse(o.timestamp);
  if (!Number.isFinite(t)) return null;

  const cc = u.cache_creation || {};
  const cwTotal = u.cache_creation_input_tokens || 0;
  let cw5 = cc.ephemeral_5m_input_tokens || 0;
  let cw1h = cc.ephemeral_1h_input_tokens || 0;
  // Older transcripts only carry the total. Charge it at the 5m rate.
  if (!cw5 && !cw1h && cwTotal) cw5 = cwTotal;

  return {
    id: o.uuid || `${o.requestId || ''}:${m.id || ''}:${o.timestamp}`,
    t,
    model: m.model,
    // The transcript carries the real cwd, which beats guessing at the
    // directory name ("projects/C--Users-me-Desktop-padex-app" splits
    // on "-" into "app", losing the hyphen that was part of the folder name).
    project: o.cwd ? projectFromCwd(o.cwd) : project,
    sidechain: !!o.isSidechain,
    input: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    cw5,
    cw1h,
  };
}

module.exports = { Reader, parseLine };
