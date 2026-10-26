// ==UserScript==
// @name         GitLab MR CI
// @namespace    gitlab-mr-dashboard
// @homepageURL  https://github.com/ririkiller/gitlab-mr-dashboard
// @supportURL   https://github.com/ririkiller/gitlab-mr-dashboard/issues
// @downloadURL  https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-ci.user.js
// @updateURL    https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-ci.user.js
// @version      1.0.0
// @description  A window with an MR's pipeline (stages, jobs, demo) and run / retry / stop buttons, opened by ↗ in "GitLab MR Dashboard", for the projects whose settings turn it on. English or French, as GitLab.
// @match        https://gitlab.com/*/-/merge_requests*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Not read only: the job buttons play, retry or cancel real GitLab jobs with
 * the session of the person signed in, as GitLab's own buttons do. Stopping
 * the demo, cancelling a job and any job matching the project's `prodJobs`
 * setting ask for a confirmation first.
 */
(function () {
  'use strict';

  // The project of the MR list the page shows, as the dashboard reads it.
  const LIST_PATH = /^\/(?!groups\/|dashboard\/)(.+?)\/-\/merge_requests(\/|$)/;
  const projectPath = () => location.pathname.match(LIST_PATH)?.[1] || '';
  const api_ = () => `/api/v4/projects/${encodeURIComponent(projectPath())}`;

  // The settings "GitLab MR Dashboard" edits (⚙): only this project's part.
  const SETTINGS_KEY = 'mrdash:settings';
  const DEFAULTS = { demoEnvironmentPrefix: '', demoJob: '', prodJobs: 'prod|prd|production|rollback', ciWindow: false };
  const projectSettings = () => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { /* private window */ }
    return { ...DEFAULTS, ...saved.defaults, ...(saved.projects || {})[projectPath()] };
  };
  const prodPattern = () => {
    try { return new RegExp(projectSettings().prodJobs, 'i'); } catch { return new RegExp(DEFAULTS.prodJobs, 'i'); }
  };
  const FAST_MS = 15000;
  const ACTIVE = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'canceling']);

  const GLYPHS = {
    success: ['✓', 'ok'], failed: ['✗', 'bad'], tolerated: ['!', 'warn'], running: ['◐', 'info'],
    preparing: ['◌', 'info'], pending: ['◷', 'warn'], waiting_for_resource: ['◷', 'warn'], scheduled: ['◔', 'info'],
    created: ['○', 'muted'], manual: ['⚙', 'muted'], skipped: ['»', 'muted'], canceled: ['⊘', 'muted'], canceling: ['⊘', 'muted'],
  };
  // French or English, as GitLab's own interface.
  const LANG = (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const T = {
    fr: {
      labels: {
        success: 'réussi', failed: 'échoué', tolerated: 'échec toléré', running: 'en cours', preparing: 'préparation',
        pending: 'en attente', waiting_for_resource: 'en attente', scheduled: 'différé', created: 'créé', manual: 'manuel',
        skipped: 'ignoré', canceled: 'annulé', canceling: 'annulation',
      },
      play: '▶ Lancer', stop: '■ Stop', cancel: '■ Annuler',
      confirmStop: (j) => `Arrêter « ${j} » ?`, confirmCancel: (j) => `Annuler « ${j} » ?`,
      confirmProd: (j) => `« ${j} » agit sur la PRODUCTION. Lancer quand même ?`,
      loadError: (i, e) => `Impossible de charger !${i} : ${e}`, typeIid: 'Tape le numéro d’une MR ci-dessus.',
      loading: 'Chargement du pipeline…', noPipeline: 'Pas encore de pipeline.', pipeline: (l) => `Pipeline ${l}`,
      iidLabel: 'Numéro de MR', dialog: 'Pipeline de la MR', refresh: 'Rafraîchir', close: 'Fermer',
      sec: 's', min: 'min', hour: 'h',
    },
    en: {
      labels: {
        success: 'passed', failed: 'failed', tolerated: 'allowed to fail', running: 'running', preparing: 'preparing',
        pending: 'pending', waiting_for_resource: 'waiting', scheduled: 'scheduled', created: 'created', manual: 'manual',
        skipped: 'skipped', canceled: 'canceled', canceling: 'canceling',
      },
      play: '▶ Run', stop: '■ Stop', cancel: '■ Cancel',
      confirmStop: (j) => `Stop “${j}”?`, confirmCancel: (j) => `Cancel “${j}”?`,
      confirmProd: (j) => `“${j}” acts on PRODUCTION. Run it anyway?`,
      loadError: (i, e) => `Could not load !${i}: ${e}`, typeIid: 'Type an MR number above.',
      loading: 'Loading the pipeline…', noPipeline: 'No pipeline yet.', pipeline: (l) => `Pipeline ${l}`,
      iidLabel: 'MR number', dialog: 'MR pipeline', refresh: 'Refresh', close: 'Close',
      sec: 's', min: 'min', hour: 'h',
    },
  }[LANG];
  const LABELS = T.labels;
  const effective = (status, allowFailure) => (status === 'failed' && allowFailure ? 'tolerated' : status);

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  // Job names carry invisible selectors that order them within their stage.
  const visible = (name) => name.replace(/[︀-️​-‍]/gu, '').trim();
  const slugOf = (name) => visible(name).replace(/^(\p{Extended_Pictographic}️?)+_?/u, '');
  const refSlug = (branch) => branch.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 63).replace(/^-+|-+$/g, '');

  const duration = (seconds) => {
    if (seconds == null) return '';
    const s = Math.round(seconds);
    if (s < 60) return `${s} ${T.sec}`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} ${T.min} ${s % 60} ${T.sec}` : `${Math.floor(m / 60)} ${T.hour} ${m % 60} ${T.min}`;
  };

  // ---------- GitLab ----------
  async function api(path, method = 'GET') {
    const response = await fetch(api_() + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf() },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function stagesOf(pipelineId) {
    const query = `query($path: ID!, $id: CiPipelineID!) { project(fullPath: $path) { pipeline(id: $id) { stages { nodes { name } } } } }`;
    try {
      const response = await fetch('/api/graphql', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ query, variables: { path: projectPath(), id: `gid://gitlab/Ci::Pipeline/${pipelineId}` } }),
      });
      const answer = await response.json();
      return (answer.data?.project?.pipeline?.stages?.nodes || []).map((n) => n.name);
    } catch {
      return [];
    }
  }

  // The demo's URL as GitLab knows it: the environment named
  // "<demoEnvironmentPrefix><branch slug>" (none without a prefix setting).
  async function demoUrlOf(branch) {
    const prefix = projectSettings().demoEnvironmentPrefix;
    if (!prefix) return '';
    try {
      const envs = await api(`/environments?name=${encodeURIComponent(prefix + refSlug(branch))}`);
      return envs[0]?.external_url || '';
    } catch {
      return '';
    }
  }

  async function load(iid) {
    const mr = await api(`/merge_requests/${iid}`);
    const head = mr.head_pipeline;
    const base = { iid: mr.iid, title: mr.title, url: mr.web_url, branch: mr.source_branch, demoUrl: await demoUrlOf(mr.source_branch) };
    if (!head) return { ...base, pipeline: null, stages: [] };

    const [jobs, stageNames] = await Promise.all([api(`/pipelines/${head.id}/jobs?per_page=100`), stagesOf(head.id)]);
    // Stages in the pipeline's own order (a retried job gets a newer id), jobs
    // by raw name within a stage, as GitLab draws them.
    const rank = new Map(stageNames.map((name, i) => [name, i]));
    if (!rank.size) for (const j of jobs) rank.set(j.stage, Math.min(rank.get(j.stage) ?? Infinity, j.id));
    const stages = [];
    for (const j of [...jobs].sort((a, b) => (rank.get(a.stage) ?? 99) - (rank.get(b.stage) ?? 99) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      let stage = stages.find((s) => s.raw === j.stage);
      if (!stage) stages.push((stage = { raw: j.stage, name: visible(j.stage), jobs: [] }));
      stage.jobs.push({
        id: j.id, name: visible(j.name), slug: slugOf(j.name), status: j.status,
        allowFailure: Boolean(j.allow_failure), duration: j.duration, url: j.web_url,
      });
    }
    return {
      ...base,
      pipeline: { id: head.id, status: head.status, sha: head.sha, url: head.web_url, duration: head.duration, createdAt: head.created_at },
      stages,
    };
  }

  // Each button with the question it asks first, if any.
  const actionOf = (job) => {
    const prod = prodPattern().test(job.slug) ? T.confirmProd(job.name) : null;
    if (job.status === 'manual') {
      return job.slug.endsWith('_stop') && !prod
        ? { action: 'play', text: T.stop, confirm: T.confirmStop(job.name) }
        : { action: 'play', text: T.play, confirm: prod };
    }
    if (ACTIVE.has(job.status)) return { action: 'cancel', text: T.cancel, confirm: T.confirmCancel(job.name) };
    if (['success', 'failed', 'canceled'].includes(job.status)) return { action: 'retry', text: '↻', confirm: prod };
    return null;
  };

  // ---------- styles ----------
  const CSS = `
    :host { all: initial; position: fixed; z-index: 1000; font-family: "GitLab Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    :host {
      --fg: #28272d; --muted: #626168; --bg: #ffffff; --panel: #fbfafd; --line: #dcdcde;
      --ok: #217645; --bad: #c91c00; --warn: #b85c00; --info: #1f75cb; --shadow: 0 8px 24px rgba(0,0,0,.16);
    }
    :host([data-theme="dark"]) {
      --fg: #ececef; --muted: #a4a3a8; --bg: #18171d; --panel: #1f1e24; --line: #3a383f;
      --ok: #52b87a; --bad: #ec5941; --warn: #e9a14a; --info: #63a6e9; --shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .panel { position: fixed; top: 64px; right: 64px; bottom: 40px; width: min(520px, calc(100vw - 80px)); background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); display: flex; flex-direction: column; font-size: 13px; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .bar strong { flex: 1; font-size: 14px; }
    .iid { width: 6rem; font: inherit; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
    .ghost { background: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; }
    .ghost:hover { border-color: var(--muted); }
    .body { overflow-y: auto; overflow-x: hidden; padding: 12px; display: grid; gap: 10px; align-content: start; }
    .muted { color: var(--muted); }
    .error { color: var(--bad); }
    a { color: inherit; text-decoration: none; } a:hover { text-decoration: underline; color: var(--info); }
    .title a { font-weight: 600; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
    .left { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .left a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .g { font-weight: 700; width: 1.1em; text-align: center; }
    .g.ok { color: var(--ok); } .g.bad { color: var(--bad); } .g.warn { color: var(--warn); } .g.info { color: var(--info); } .g.muted { color: var(--muted); }
    .stage { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
    .stage.demo-up { border-color: var(--ok); }
    .stage h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
    .act { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 1px 8px; font-size: 12px; }
    .act:hover { border-color: var(--fg); }
    .act:disabled { opacity: .5; cursor: progress; }
  `;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }
  const link = (href, text) => (/^https:\/\//.test(href || '') ? el('a', { href, target: '_blank', rel: 'noopener', text }) : el('span', { text }));
  const glyph = (status, allowFailure) => {
    const [g, tone] = GLYPHS[effective(status, allowFailure)] || ['•', 'muted'];
    return el('span', { class: `g ${tone}`, text: g });
  };

  // ---------- panel ----------
  const state = { iid: null, data: null, error: '', loading: false, busy: null, open: false };
  let host = null;
  let view = null;
  let timer = null;

  const theme = () => (document.documentElement.classList.contains('gl-dark') ? 'dark' : 'light');

  async function refresh() {
    clearTimeout(timer);
    if (!state.iid || !state.open) return;
    state.loading = true;
    render();
    try {
      state.data = await load(state.iid);
      state.error = '';
    } catch (error) {
      state.error = T.loadError(state.iid, error instanceof Error ? error.message : error);
    } finally {
      state.loading = false;
      render();
    }
    const running = state.data?.stages.some((s) => s.jobs.some((j) => ACTIVE.has(j.status)));
    if (running) timer = setTimeout(refresh, FAST_MS);
  }

  function show(iid) {
    if (String(iid) !== String(state.iid)) state.data = null;
    state.iid = String(iid);
    setOpen(true);
  }

  function setOpen(open) {
    state.open = open;
    if (open) refresh();
    else clearTimeout(timer);
    render();
  }

  async function act(job, a) {
    if (a.confirm && !window.confirm(a.confirm)) return;
    state.busy = job.id;
    render();
    try {
      await api(`/jobs/${job.id}/${a.action}`, 'POST');
    } catch (error) {
      state.error = `${job.name} : ${error instanceof Error ? error.message : error}`;
    } finally {
      state.busy = null;
      render();
      setTimeout(refresh, 2000);
    }
  }

  function render() {
    if (!view) return;
    // Closed, the script draws nothing: the window only opens from the dashboard's ↗ button.
    if (!state.open) {
      view.replaceChildren();
      return;
    }

    const d = state.data;
    const iidInput = el('input', {
      class: 'iid', type: 'text', inputmode: 'numeric', placeholder: '!iid', 'aria-label': T.iidLabel, value: state.iid ? '!' + state.iid : '',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        const iid = event.target.value.replace(/\D/g, '');
        if (iid) show(iid);
      },
    });

    const demoName = projectSettings().demoJob;
    const demoJob = demoName && d?.stages.flatMap((s) => s.jobs).find((j) => j.slug === demoName);
    const demoUp = demoJob?.status === 'success';

    const body = !state.iid
      ? [el('p', { class: 'muted', text: T.typeIid })]
      : [
          state.error && el('p', { class: 'error', text: state.error }),
          !d && !state.error && el('p', { class: 'muted', text: T.loading }),
          d && el('div', { class: 'title' }, link(d.url, `!${d.iid} ${d.title}`), el('div', { class: 'muted', text: d.branch })),
          d && !d.pipeline && el('p', { class: 'muted', text: T.noPipeline }),
          d?.pipeline && el('div', { class: 'row' },
            el('span', { class: 'left' }, glyph(d.pipeline.status), link(d.pipeline.url, T.pipeline(LABELS[d.pipeline.status] || d.pipeline.status))),
            el('span', { class: 'muted', text: duration(d.pipeline.duration) })),
          ...(d?.stages || []).map((stage) => {
            const hasDemo = Boolean(demoName) && stage.jobs.some((j) => j.slug === demoName);
            return el('section', { class: 'stage' + (hasDemo && demoUp ? ' demo-up' : '') },
              el('h3', { text: stage.name }),
              ...stage.jobs.map((job) => {
                const a = actionOf(job);
                const shown = job.status === 'success' || (job.status === 'failed' && !job.allowFailure);
                return el('div', { class: 'row' },
                  el('span', { class: 'left' }, glyph(job.status, job.allowFailure), link(job.url, job.name)),
                  el('span', { class: 'right' },
                    el('span', { class: 'muted', text: shown ? duration(job.duration) : LABELS[effective(job.status, job.allowFailure)] || job.status }),
                    a && el('button', { class: 'act', type: 'button', disabled: state.busy === job.id, onclick: () => act(job, a), text: state.busy === job.id ? '…' : a.text })));
              }),
              hasDemo && demoUp && d.demoUrl && el('div', { class: 'row' }, link(d.demoUrl, d.demoUrl.replace('https://', '') + ' ↗')));
          }),
        ];

    view.replaceChildren(el('div', { class: 'panel', role: 'dialog', 'aria-label': T.dialog },
      el('div', { class: 'bar' },
        el('strong', { text: 'CI' }),
        iidInput,
        el('button', { class: 'ghost', type: 'button', title: T.refresh, disabled: state.loading || !state.iid, onclick: refresh, text: state.loading ? '…' : '↻' }),
        el('button', { class: 'ghost', type: 'button', title: T.close, onclick: () => setOpen(false), text: '✕' })),
      el('div', { class: 'body' }, ...body.filter(Boolean))));
  }

  // ---------- mounting ----------
  function mount() {
    if (host && document.body.contains(host)) return;
    host = el('div', { class: 'mrci' });
    host.setAttribute('data-theme', theme());
    const shadow = host.attachShadow({ mode: 'open' });
    view = el('div');
    shadow.append(el('style', { text: CSS }), view);
    document.body.append(host);
    render();
  }

  window.addEventListener('mrdash:select', (event) => {
    if (event.detail?.project === projectPath() && projectSettings().ciWindow && event.detail.iid) show(event.detail.iid);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) setOpen(false);
  });

  // Tells "GitLab MR Dashboard" whether this project has a CI window (its
  // ciWindow setting), so it shows or hides its ↗ buttons.
  function announce() {
    const on = Boolean(projectPath()) && projectSettings().ciWindow;
    const current = document.documentElement.dataset.mrci || '';
    const next = on ? projectPath() : '';
    if (current === next) return;
    if (next) document.documentElement.dataset.mrci = next;
    else delete document.documentElement.dataset.mrci;
    window.dispatchEvent(new CustomEvent('mrci:ready'));
  }

  new MutationObserver(() => {
    mount();
    announce();
    if (host && host.getAttribute('data-theme') !== theme()) host.setAttribute('data-theme', theme());
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('mrdash:settings', announce);
  mount();
  announce();
})();
