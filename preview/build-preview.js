#!/usr/bin/env node
'use strict';
/**
 * Dev harness: renders the real UI in a plain browser, with a stubbed
 * window.usage fed by your actual transcripts. Lets you iterate on the
 * renderer without launching Electron.
 *
 *   node preview/build-preview.js && open preview/out/index.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(__dirname, 'out');

const { Reader } = require('../src/main/reader');
const { summarize } = require('../src/main/aggregate');
const { DEFAULTS } = (() => {
  // store.js pulls in electron, so read the defaults without importing it.
  const txt = fs.readFileSync(path.join(ROOT, 'src', 'main', 'store.js'), 'utf8');
  const body = txt.slice(txt.indexOf('const DEFAULTS = {') + 'const DEFAULTS = '.length);
  const end = body.indexOf('\n};');
  return { DEFAULTS: eval('(' + body.slice(0, end + 2) + ')') };
})();

fs.mkdirSync(OUT, { recursive: true });

// --- real data ---------------------------------------------------------- //
const settings = { ...DEFAULTS };
const reader = new Reader();
const entries = reader.scan();
const data = summarize(entries, settings, Date.now());
data.hasData = entries.length > 0;
data.roots = ['(preview)'];

// Copy the real stylesheet and scripts verbatim so we are previewing the
// shipping code, not a lookalike.
for (const f of ['app.css', 'format.js', 'popup.js', 'overlay.js', 'badge.html']) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

fs.writeFileSync(path.join(OUT, 'mock.js'),
  'window.__DATA__ = ' + JSON.stringify(data) + ';\n' +
  'window.__SETTINGS__ = ' + JSON.stringify(settings) + ';\n' +
  `window.usage = {
  get: async () => window.__DATA__,
  refresh: async () => window.__DATA__,
  settingsGet: async () => window.__SETTINGS__,
  settingsSet: async (p) => Object.assign(window.__SETTINGS__, p),
  settingsReset: async () => window.__SETTINGS__,
  calibrate: async () => window.__SETTINGS__,
  openSettings: () => {}, closeSelf: () => {}, quit: () => {}, openExternal: () => {},
  onUpdate: () => () => {},
};\n`);

/** Strip the Electron CSP (no preload here) and inject the stub first. */
function makePage(name) {
  let html = fs.readFileSync(path.join(SRC, name), 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '');
  html = html.replace('<script src="format.js"></script>', '<script src="mock.js"></script>\n<script src="format.js"></script>');
  fs.writeFileSync(path.join(OUT, name), html);
}
makePage('popup.html');
makePage('overlay.html');

fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>Preview</title>
<style>
  body { margin:0; padding:24px; background:#141312; color:#a3a099;
         font:13px -apple-system,"Segoe UI",system-ui,sans-serif; }
  h3 { font-size:11px; letter-spacing:.08em; text-transform:uppercase;
       color:#8f8c85; margin:0 0 10px; font-weight:700; }
  .grid { display:flex; gap:28px; align-items:flex-start; flex-wrap:wrap; }
  iframe { border:0; background:transparent; }
  .badges { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .badges figure { margin:0; text-align:center; }
  .badges canvas { image-rendering:pixelated; background:#2a2927; border-radius:6px; padding:4px; }
  .badges figcaption { font-size:10px; margin-top:5px; color:#8f8c85; }
</style>
<div class="grid">
  <div><h3>Popup (380&times;580)</h3><iframe src="popup.html" width="380" height="580"></iframe></div>
  <div>
    <h3>Overlay completo</h3><iframe src="overlay.html" width="236" height="108"></iframe>
    <h3 style="margin-top:22px">Tray badge, tamanho real (16px)</h3>
    <div class="badges" id="badges"></div>
  </div>
</div>
<iframe id="painter" src="badge.html" style="width:0;height:0;position:absolute"></iframe>
<script>
const CASES = [
  { pct: 12,  color:'#4ade80', style:'ring', showNumber:true,  cap:'12% ok' },
  { pct: 64,  color:'#4ade80', style:'ring', showNumber:true,  cap:'64% ok' },
  { pct: 87,  color:'#fbbf24', style:'ring', showNumber:true,  cap:'87% warn' },
  { pct: 99,  color:'#f87171', style:'ring', showNumber:true,  cap:'99% danger' },
  { pct: 139, color:'#f87171', style:'ring', showNumber:true,  cap:'139% over' },
  { pct: 64,  color:'#4ade80', style:'ring', showNumber:false, cap:'sem numero' },
  { pct: 64,  color:'#4ade80', style:'bar',  showNumber:false, cap:'barra' },
  { pct: 64,  color:'#4ade80', style:'dot',  showNumber:false, cap:'ponto' },
];
document.getElementById('painter').onload = () => {
  const draw = document.getElementById('painter').contentWindow.drawBadge;
  const host = document.getElementById('badges');
  for (const c of CASES) {
    const fig = document.createElement('figure');
    const img = new Image();
    // Rasterise at 32 (what a 2x tray asks for), display at 16 to judge legibility.
    img.src = draw({ ...c, size: 32 });
    img.width = 16; img.height = 16;
    const cap = document.createElement('figcaption');
    cap.textContent = c.cap;
    fig.append(img, cap);
    host.appendChild(fig);
  }
};
</script>
`);

console.log('preview built from ' + entries.length + ' real records -> preview/out/index.html');
console.log('  session ' + data.session.pct + '%   week ' + data.week.pct + '%   today $' + data.today.cost.toFixed(2));
