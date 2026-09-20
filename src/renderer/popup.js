/* Tray panel. Reads pushed updates; never computes usage itself. */
(() => {
  const $ = (id) => document.getElementById(id);
  let settings = {};

  function rows(container, items, total, nameClass) {
    container.textContent = '';
    if (!items.length) {
      const p = document.createElement('div');
      p.className = 'row';
      p.style.color = 'var(--faint)';
      p.textContent = 'sem uso nesta janela';
      container.appendChild(p);
      return;
    }
    const max = Math.max(total, ...items.map((i) => i.cost)) || 1;
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'row';

      const name = document.createElement('span');
      name.className = 'row-name truncate ' + (nameClass || '');
      name.textContent = it.name;
      name.title = it.name;

      const bar = document.createElement('span');
      bar.className = 'row-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(2, (it.cost / max) * 100) + '%';
      bar.appendChild(fill);

      const val = document.createElement('span');
      val.className = 'row-val';
      val.textContent = usd(it.cost);

      row.append(name, bar, val);
      container.appendChild(row);
    }
  }

  function sparkline(data) {
    const el = $('spark');
    el.textContent = '';
    const max = Math.max(...data.map((d) => d.cost), 0.01);
    for (const d of data) {
      const bar = document.createElement('div');
      bar.style.height = Math.max(2, (d.cost / max) * 40) + 'px';
      if (d.cost > 0) bar.classList.add('hot');
      bar.title = d.day + ' - ' + usd(d.cost);
      el.appendChild(bar);
    }
    if (data.length) {
      const first = data[0].day.split('-');
      $('spark-from').textContent = first[2] + '/' + first[1];
    }
  }

  function render(u) {
    if (!u) return;
    applyTheme(settings);

    const has = u.hasData;
    $('empty').hidden = has;
    $('content').hidden = !has;
    if (!has) return;

    $('plan').textContent = u.plan;

    paintMeter($('m-session'), u.session.pct, settings);
    $('s-cost').textContent = usd(u.session.cost) + ' · ' + tokens(u.session.tokens) + ' tok';
    $('s-reset').textContent = u.session.active
      ? 'reseta em ' + dur(u.session.resetsIn) + ' (' + clockAt(u.session.end) + ')'
      : 'sem sessao ativa';

    paintMeter($('m-week'), u.week.pct, settings);
    $('w-label').textContent = u.week.mode === 'fixed' ? 'SEMANA' : 'ULTIMOS 7 DIAS';
    $('w-cost').textContent = usd(u.week.cost) + ' · ' + tokens(u.week.tokens) + ' tok';
    $('w-reset').textContent = u.week.resetsIn != null ? 'reseta em ' + dur(u.week.resetsIn) : 'janela movel';

    $('t-cost').textContent = usd(u.today.cost);
    $('t-tokens').textContent = tokens(u.today.tokens);
    $('t-calls').textContent = String(u.today.calls);

    rows($('models'), u.byModel, u.week.cost);
    rows($('projects'), u.byProject, u.week.cost, 'wide');
    sparkline(u.sparkline);

    // The footer says where the percentages came from, because "official" and
    // "estimated" are different enough that the reader should never wonder.
    const k = settings.calibration || 1;
    const raised = u.autoRaised && (u.autoRaised.session || u.autoRaised.week);
    let text;
    if (u.source === 'official') {
      text = 'Numeros oficiais do servidor';
    } else if (u.source === 'official-stale') {
      text = 'Oficial (desatualizado) · ' + (u.officialError || 'sem conexao');
    } else {
      const parts = [];
      if (u.officialError) parts.push('Oficial falhou: ' + u.officialError);
      else if (raised) parts.push('Auto-calibrado pelo seu historico');
      if (k !== 1) parts.push('fator ×' + k.toFixed(2));
      text = parts.length ? parts.join(' · ') : 'Estimativa dos transcripts locais';
    }
    $('foot').textContent = text;
    $('foot').style.color = u.officialError ? 'var(--warn)' : '';
  }

  async function boot() {
    settings = await window.usage.settingsGet();
    render(await window.usage.get());
  }

  window.usage.onUpdate(render);

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.style.opacity = '0.4';
    render(await window.usage.refresh());
    btn.style.opacity = '';
  });

  $('settings').addEventListener('click', () => window.usage.openSettings());
  $('calib').addEventListener('click', () => window.usage.openSettings());

  // The panel hides on blur, so Esc is the only other way out.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.usage.closeSelf();
  });

  // Settings can change in the other window while this one stays open.
  window.addEventListener('focus', async () => {
    settings = await window.usage.settingsGet();
    render(await window.usage.get());
  });

  boot();
})();
