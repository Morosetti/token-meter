/* Settings window. Every control writes straight through to the store. */
(() => {
  const $ = (id) => document.getElementById(id);
  let settings = {};
  let latest = null;

  const SELECTS = ['plan', 'weekMode', 'badgeMetric', 'badgeStyle', 'theme'];
  const NUMBERS = ['customSession', 'customWeek', 'refreshSeconds', 'warnAt', 'dangerAt', 'weekResetHour'];
  const SWITCHES = [
    'autoCalibrate', 'officialSource', 'officialCalibrate',
    'badgeShowNumber', 'overlayEnabled', 'overlayCompact',
    'overlayAlwaysOnTop', 'overlayClickThrough', 'launchAtLogin',
  ];

  async function push(patch) {
    settings = await window.usage.settingsSet(patch);
    paint();
  }

  function paint() {
    applyTheme(settings);

    for (const id of SELECTS) $(id).value = String(settings[id]);
    for (const id of NUMBERS) $(id).value = String(settings[id]);
    $('weekResetDay').value = String(settings.weekResetDay);
    for (const id of SWITCHES) $(id).setAttribute('aria-checked', settings[id] ? 'true' : 'false');
    $('overlayOpacity').value = String(Math.round((settings.overlayOpacity || 0.92) * 100));

    $('custom-row').hidden = settings.plan !== 'custom';
    $('weekFixed').hidden = settings.weekMode !== 'fixed';

    const k = settings.calibration || 1;
    if (latest) {
      const scope = $('calScope').value;
      const m = scope === 'session' ? latest.session : latest.week;
      const raised = latest.autoRaised && latest.autoRaised[scope];
      const obs = latest.observed && (scope === 'session' ? latest.observed.maxSession : latest.observed.maxWeek);
      $('calNow').textContent =
        'Agora: ' + m.pct + '%  (' + usd(m.cost) + ' de ' + usd(m.budget) + ')'
        + (raised ? '  ·  orcamento elevado pelo seu maximo de ' + usd(obs) : '')
        + (k === 1 ? '' : '  ·  fator ×' + k.toFixed(2));
    } else {
      $('calNow').textContent = k === 1 ? 'Sem calibracao aplicada' : 'Fator ×' + k.toFixed(2);
    }

    if (latest && latest.roots) {
      $('sources').textContent = latest.entryCount + ' registros lidos de ' + latest.roots.length
        + ' pasta' + (latest.roots.length === 1 ? '' : 's') + ' de transcripts.';
    }
  }

  for (const id of SELECTS) {
    $(id).addEventListener('change', (e) => push({ [id]: e.target.value }));
  }
  $('weekResetDay').addEventListener('change', (e) => push({ weekResetDay: Number(e.target.value) }));

  for (const id of NUMBERS) {
    $(id).addEventListener('change', (e) => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) { paint(); return; }   // reject junk, restore the stored value
      push({ [id]: n });
    });
  }

  for (const id of SWITCHES) {
    $(id).addEventListener('click', () => push({ [id]: $(id).getAttribute('aria-checked') !== 'true' }));
  }

  $('overlayOpacity').addEventListener('input', (e) => push({ overlayOpacity: Number(e.target.value) / 100 }));

  $('calScope').addEventListener('change', paint);

  $('calApply').addEventListener('click', async () => {
    const pct = Number($('calPct').value);
    if (!(pct > 0 && pct <= 100)) { $('calPct').focus(); return; }
    settings = await window.usage.calibrate($('calScope').value, pct);
    $('calPct').value = '';
    paint();
  });

  $('officialTest').addEventListener('click', async () => {
    const out = $('officialStatus');
    out.textContent = 'consultando...';
    out.style.color = 'var(--faint)';
    const r = await window.usage.testOfficial();
    if (r.ok) {
      const bits = [];
      if (r.session) bits.push('5h ' + r.session.pct + '%');
      if (r.week) bits.push('semana ' + r.week.pct + '%');
      out.textContent = 'OK · ' + bits.join('  ·  ');
      out.style.color = 'var(--ok)';
    } else {
      out.textContent = r.error;
      out.style.color = 'var(--danger)';
    }
  });

  $('reset').addEventListener('click', async () => {
    settings = await window.usage.settingsReset();
    paint();
  });

  $('close').addEventListener('click', () => window.usage.closeSelf());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.usage.closeSelf(); });

  window.usage.onUpdate((u) => { latest = u; paint(); });

  (async () => {
    settings = await window.usage.settingsGet();
    latest = await window.usage.get();
    paint();
  })();
})();
