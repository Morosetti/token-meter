/* Floating always-on-top meter. */
(() => {
  const $ = (id) => document.getElementById(id);
  let settings = {};

  function paintLine(root, pct) {
    const t = tone(pct, settings);
    const bar = root.querySelector('.bar');
    const fill = root.querySelector('.bar i');
    const num = root.querySelector('.num');
    bar.classList.toggle('over', pct > 100);
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    fill.style.backgroundColor = t.color;
    num.textContent = (pct > 999 ? '999+' : Math.round(pct)) + '%';
    num.className = 'num ' + t.cls;
  }

  function render(u) {
    if (!u) return;
    applyTheme(settings);
    document.body.classList.toggle('compact', !!settings.overlayCompact);

    if (settings.overlayCompact) {
      // One row only, so show whichever limit is closer to the edge.
      const worse = u.session.pct >= u.week.pct ? u.session : u.week;
      const label = u.session.pct >= u.week.pct ? '5H' : 'SEM';
      $('l-session').querySelector('.tag').textContent = label;
      paintLine($('l-session'), worse.pct);
      return;
    }

    $('l-session').querySelector('.tag').textContent = '5H';
    paintLine($('l-session'), u.session.pct);
    paintLine($('l-week'), u.week.pct);
    $('f-cost').textContent = usd(u.today.cost) + ' hoje';
    $('f-reset').textContent = u.session.active ? dur(u.session.resetsIn) : 'ocioso';
  }

  window.usage.onUpdate(render);

  // Double-click opens the full panel; the window itself is drag-only.
  document.addEventListener('dblclick', () => window.usage.openSettings());

  (async () => {
    settings = await window.usage.settingsGet();
    render(await window.usage.get());
  })();

  // Settings changes arrive with the next pushed update, so re-read them then.
  setInterval(async () => { settings = await window.usage.settingsGet(); }, 3000);
})();
