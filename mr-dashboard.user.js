// ==UserScript==
// @name         GitLab MR Dashboard
// @namespace    gitlab-mr-dashboard
// @homepageURL  https://github.com/ririkiller/gitlab-mr-dashboard
// @supportURL   https://github.com/ririkiller/gitlab-mr-dashboard/issues
// @downloadURL  https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-dashboard.user.js
// @updateURL    https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-dashboard.user.js
// @version      1.0.0
// @description  Replaces a GitLab project's open merge request list with a dashboard (statuses, reviews, demos, releases), with a switch back to GitLab's own list. English or French, as GitLab. Read only. Project conventions live in settings (⚙).
// @match        https://gitlab.com/*/-/merge_requests*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Read only: the script only sends GET requests and one GraphQL query, with
 * the session of the person already signed in to GitLab. It never changes an MR.
 */
(function () {
  'use strict';

  // A project's MR list, read from the page's URL (not a group's nor the
  // personal dashboard's: those have no single project to query).
  const LIST_PATH = /^\/(?!groups\/|dashboard\/)(.+?)\/-\/merge_requests\/?$/;
  const projectPath = () => location.pathname.match(LIST_PATH)?.[1] || '';
  const projectName = () => projectPath().split('/').pop();
  const STALE_DAYS = 5;
  const MODE_KEY = 'mrdash:mode';
  const VIEW_KEY = 'mrdash:view';
  const LOAD_KEY = 'mrdash:load-open';
  const SEEN_KEY = 'mrdash:seen';
  const SETTINGS_KEY = 'mrdash:settings';

  // One-time move of the per-browser marks kept under the script's first name.
  for (const name of ['mode', 'view', 'load-open', 'seen']) {
    try {
      const old = localStorage.getItem('jvmrs:' + name);
      if (old !== null && localStorage.getItem('mrdash:' + name) === null) localStorage.setItem('mrdash:' + name, old);
    } catch { /* private window */ }
  }

  // ---------- settings: the project conventions, kept per browser ----------
  // The code holds neutral defaults only; a team's labels, demo environments
  // and commands come from these settings (⚙ in the dashboard, JSON import /
  // export). "GitLab MR CI" reads the same settings.
  const DEFAULT_SETTINGS = {
    statusLabels: { review: 'Status::Needs review', test: 'Status::To be tested' },
    // "Prefix::*" matches every label of that scope.
    blockingLabels: ['Status::*', "Don't merge"],
    dontMergeLabel: "Don't merge",
    releaseLabels: { release: '', hotfix: '' },
    // Per project path ("group/sub/project"), anything below overrides `defaults`.
    defaults: {
      demoEnvironmentPrefix: '',
      demoJob: '',
      reviewCommand: '',
      prodJobs: 'prod|prd|production|rollback',
      ciWindow: false,
    },
    projects: {},
  };
  const readSettings = () => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { return {}; }
  };
  const settings = () => {
    const saved = readSettings();
    return {
      ...DEFAULT_SETTINGS, ...saved,
      statusLabels: { ...DEFAULT_SETTINGS.statusLabels, ...saved.statusLabels },
      releaseLabels: { ...DEFAULT_SETTINGS.releaseLabels, ...saved.releaseLabels },
      defaults: { ...DEFAULT_SETTINGS.defaults, ...saved.defaults },
    };
  };
  const projectSettings = () => {
    const all = settings();
    return { ...all.defaults, ...(all.projects || {})[projectPath()] };
  };
  // Labels compare without their decoration: "Status::🔎 Needs review" and
  // "status::needs review" are the same label, as are "✗ Don't merge" and
  // "Dont merge".
  const normLabel = (label) => String(label || '').toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, ' ').replace(/\s*::\s*/g, '::').replace(/\s+/g, ' ').trim();
  const labelMatches = (label, pattern) => {
    const p = normLabel(pattern);
    if (!p) return false;
    return /::\s*\*$/.test(String(pattern).trim()) ? normLabel(label).startsWith(p.replace(/::.*$/, '::')) : normLabel(label) === p;
  };
  const hasLabel = (labels, pattern) => labels.some((l) => labelMatches(l, pattern));

  // ---------- language: French or English, as GitLab's own interface ----------
  const LANG = (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const I18N = {
    fr: {
      review: 'À reviewer', test: 'À tester', merge: 'À merger', wip: 'En cours', all: 'Toutes',
      release: 'Release', hotfix: 'Hotfix',
      me: 'Reviews en attente', mine: 'Mes MR', noreviewer: 'À reviewer sans reviewer',
      noteAll: (p) => `MR ouvertes sur ${p}`, noteReview: 'Label « Needs review »', noteTest: 'Label « To be tested »',
      noteMerge: 'Approuvée, sans label bloquant', noteWip: '« Work In Progress » et MR sans statut',
      noteNoReviewer: "Personne n'est assigné", noteMe: (w) => `${w} est reviewer, sans avoir approuvé`, noteMine: (w) => `Ouvertes par ${w}`,
      takeaway: (n, c) => `${n} MR ouvertes : ${c.review} à reviewer, dont ${c.noreviewer} sans reviewer, ${c.test} à tester, ${c.merge} à merger et ${c.wip} en cours.`,
      loading: 'Chargement des MR…', loadingShort: 'Chargement…', refresh: '↻ Rafraîchir',
      updatedAt: (t) => `Mis à jour à ${t}`, loadError: (e) => `Impossible de charger les MR : ${e}`,
      seenReset: (n) => `👁 ${n} vue${n > 1 ? 's' : ''} · réinitialiser`, seenResetTip: 'Effacer toutes les marques « vue »',
      seenResetConfirm: 'Réinitialiser toutes les MR marquées vues ?',
      tableTitle: 'Merge requests ouvertes', search: 'Chercher un titre, un auteur, un ticket…', searchLabel: 'Chercher une MR',
      empty: 'Aucune MR dans cette vue.',
      cols: ['MR', 'Titre', 'Auteur', 'Statut', 'CI', 'Reviewers', 'Démo', 'Inactif'],
      draft: 'Brouillon', reviewPending: 'Review en attente', myMr: 'Ma MR', changed: 'Activité depuis ta vue',
      eyeMark: 'Marquer comme vue', eyeUnmark: 'Retirer la marque « vue »', eyeChanged: 'Activité depuis ta vue : marquer à nouveau comme vue',
      conflicts: 'Ne peut pas être mergée automatiquement',
      openCi: 'Ouvrir la CI', openCiLabel: (i) => `Ouvrir le pipeline de !${i}`,
      copy: 'Copier la commande Claude Code', copyLabel: (i) => `Copier la commande de review Claude de !${i}`, copied: 'Copié !',
      copyPrompt: 'Copie la commande :', reviewPrompt: (u) => `Fais une review de la merge request ${u}`,
      openDemo: 'Ouvrir ↗', lastActivity: (d) => `Dernière activité : ${d}`, day: 'j',
      loadTitle: 'Charge de review', loadTip: (o, p) => `${o} assignées · ${p} pas encore approuvées`,
      loadOpen: 'MR assignées', loadPending: 'Pas encore approuvées',
      switchLabel: 'Affichage des MR', gitlabView: 'Vue GitLab',
      settings: '⚙ Réglages', settingsTitle: 'Réglages (conventions des projets)',
      settingsNote: 'Labels de statut, labels bloquants, release, et par projet : démos, job de démo, commande Claude, jobs de prod, fenêtre CI. Enregistrés dans ce navigateur, partagés par les deux scripts.',
      save: 'Enregistrer', copyJson: 'Copier le JSON', reset: 'Valeurs par défaut', close: 'Fermer',
      saved: 'Réglages enregistrés.', copiedJson: 'JSON copié.', badJson: (e) => `JSON invalide : ${e}`,
      resetConfirm: 'Revenir aux valeurs par défaut ? Les réglages actuels seront perdus.',
      pipeline: {
        success: 'réussi', failed: 'échoué', running: 'en cours', pending: 'en attente', created: 'créé',
        preparing: 'préparation', waiting_for_resource: 'en attente', waiting_for_callback: 'en attente',
        scheduled: 'différé', manual: 'manuel', canceling: 'annulation', canceled: 'annulé', skipped: 'ignoré', none: 'aucun',
      },
    },
    en: {
      review: 'To review', test: 'To be tested', merge: 'To merge', wip: 'In progress', all: 'All',
      release: 'Release', hotfix: 'Hotfix',
      me: 'Pending reviews', mine: 'My MRs', noreviewer: 'To review, no reviewer',
      noteAll: (p) => `Open MRs on ${p}`, noteReview: '“Needs review” label', noteTest: '“To be tested” label',
      noteMerge: 'Approved, no blocking label', noteWip: '“Work In Progress” and MRs without a status',
      noteNoReviewer: 'Nobody assigned', noteMe: (w) => `${w} is a reviewer and has not approved`, noteMine: (w) => `Opened by ${w}`,
      takeaway: (n, c) => `${n} open MRs: ${c.review} to review, ${c.noreviewer} of them with no reviewer, ${c.test} to be tested, ${c.merge} to merge and ${c.wip} in progress.`,
      loading: 'Loading MRs…', loadingShort: 'Loading…', refresh: '↻ Refresh',
      updatedAt: (t) => `Updated at ${t}`, loadError: (e) => `Could not load the MRs: ${e}`,
      seenReset: (n) => `👁 ${n} seen · reset`, seenResetTip: 'Clear every “seen” mark',
      seenResetConfirm: 'Reset every MR marked as seen?',
      tableTitle: 'Open merge requests', search: 'Search a title, an author, a ticket…', searchLabel: 'Search an MR',
      empty: 'No MR in this view.',
      cols: ['MR', 'Title', 'Author', 'Status', 'CI', 'Reviewers', 'Demo', 'Idle'],
      draft: 'Draft', reviewPending: 'Review pending', myMr: 'My MR', changed: 'Activity since you saw it',
      eyeMark: 'Mark as seen', eyeUnmark: 'Remove the “seen” mark', eyeChanged: 'Activity since you saw it: mark as seen again',
      conflicts: 'Cannot be merged automatically',
      openCi: 'Open the CI', openCiLabel: (i) => `Open the pipeline of !${i}`,
      copy: 'Copy the Claude Code command', copyLabel: (i) => `Copy the Claude review command for !${i}`, copied: 'Copied!',
      copyPrompt: 'Copy the command:', reviewPrompt: (u) => `Review the merge request ${u}`,
      openDemo: 'Open ↗', lastActivity: (d) => `Last activity: ${d}`, day: 'd',
      loadTitle: 'Review load', loadTip: (o, p) => `${o} assigned · ${p} not approved yet`,
      loadOpen: 'Assigned MRs', loadPending: 'Not approved yet',
      switchLabel: 'MR view', gitlabView: 'GitLab view',
      settings: '⚙ Settings', settingsTitle: 'Settings (project conventions)',
      settingsNote: 'Status labels, blocking labels, releases, and per project: demos, demo job, Claude command, production jobs, CI window. Kept in this browser, shared by both scripts.',
      save: 'Save', copyJson: 'Copy JSON', reset: 'Defaults', close: 'Close',
      saved: 'Settings saved.', copiedJson: 'JSON copied.', badJson: (e) => `Invalid JSON: ${e}`,
      resetConfirm: 'Go back to the defaults? The current settings will be lost.',
      pipeline: {
        success: 'passed', failed: 'failed', running: 'running', pending: 'pending', created: 'created',
        preparing: 'preparing', waiting_for_resource: 'waiting', waiting_for_callback: 'waiting',
        scheduled: 'scheduled', manual: 'manual', canceling: 'canceling', canceled: 'canceled', skipped: 'skipped', none: 'none',
      },
    },
  };
  const T = I18N[LANG];

  // The three groups: anything neither to review nor to test is in progress,
  // an MR without a status label included.
  const groupOf = (labels) => {
    const { statusLabels } = settings();
    if (hasLabel(labels, statusLabels.review)) return 'review';
    if (hasLabel(labels, statusLabels.test)) return 'test';
    return 'wip';
  };
  // A release (or hotfix) MR comes first, then approved MRs right after the
  // ones to test.
  const GROUP_ORDER = { release: -1, review: 0, test: 1, merge: 2, wip: 3 };
  // A release or hotfix MR, by the labels the settings name (none by default).
  const releaseKindOf = (labels) => {
    const { releaseLabels } = settings();
    return hasLabel(labels, releaseLabels.release) ? 'release' : hasLabel(labels, releaseLabels.hotfix) ? 'hotfix' : null;
  };
  // The Claude Code command ⧉ copies: the project's `reviewCommand` setting
  // ({iid} and {url} filled in), else a plain review request.
  const reviewCommandOf = (m) => {
    const command = projectSettings().reviewCommand;
    return command ? command.replaceAll('{iid}', m.iid).replaceAll('{url}', m.url) : T.reviewPrompt(m.url);
  };
  const SEEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  // A blocking label (a status, "Don't merge") keeps an approved MR from
  // being ready to merge.
  const isBlocked = (labels) => settings().blockingLabels.some((pattern) => hasLabel(labels, pattern));
  // Every GitLab pipeline status, with the glyph and tone of the CI window.
  const PIPELINE_GLYPHS = {
    success: ['✓', 'ok'], failed: ['✗', 'bad'], running: ['◐', 'info'], pending: ['◷', 'warn'],
    created: ['○', 'muted'], preparing: ['◌', 'info'], waiting_for_resource: ['◷', 'warn'],
    waiting_for_callback: ['◷', 'warn'], scheduled: ['◔', 'info'], manual: ['⚙', 'muted'],
    canceling: ['⊘', 'muted'], canceled: ['⊘', 'muted'], skipped: ['»', 'muted'], none: ['—', 'muted'],
  };

  const QUERY = `query($path: ID!, $after: String) {
    project(fullPath: $path) {
      mergeRequests(state: opened, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          iid title draft createdAt updatedAt webUrl sourceBranch
          author { username }
          labels { nodes { title } }
          reviewers { nodes { username } }
          approvedBy { nodes { username } }
          approved approvalsLeft userNotesCount conflicts mergeStatusEnum
          headPipeline { status }
        }
      }
    }
  }`;

  // ---------- storage (per browser, optional) ----------
  const store = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
  };

  // ---------- data ----------
  const me = () => (window.gon && window.gon.current_username) || '';
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  const refSlug = (branch) => branch.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 63).replace(/^-+|-+$/g, '');


  async function graphql(variables) {
    const response = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify({ query: QUERY, variables }),
    });
    if (!response.ok) throw new Error(`GitLab GraphQL: HTTP ${response.status}`);
    const answer = await response.json();
    if (answer.errors?.length) throw new Error(answer.errors[0].message);
    return answer.data.project.mergeRequests;
  }

  async function fetchMergeRequests() {
    const nodes = [];
    let after = null;
    do {
      const page = await graphql({ path: projectPath(), after });
      nodes.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  }

  // Demo environments, named "<demoEnvironmentPrefix><branch slug>": only
  // where the project's settings name a prefix.
  async function fetchDemos() {
    const demos = new Map();
    const prefix = projectSettings().demoEnvironmentPrefix;
    if (!prefix) return demos;
    for (let page = 1; page; ) {
      const response = await fetch(
        `/api/v4/projects/${encodeURIComponent(projectPath())}/environments?states=available&per_page=100&page=${page}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error(`GitLab environments: HTTP ${response.status}`);
      for (const env of await response.json()) {
        if (env.name.startsWith(prefix)) demos.set(env.name.slice(prefix.length), env.external_url || '');
      }
      page = Number(response.headers.get('X-Next-Page')) || 0;
    }
    return demos;
  }

  async function load() {
    const [nodes, demos] = await Promise.all([fetchMergeRequests(), fetchDemos()]);
    const now = Date.now();
    return nodes.map((mr) => {
      const labels = mr.labels.nodes.map((l) => l.title);
      const release = releaseKindOf(labels);
      const group = release ? 'release' : groupOf(labels);
      const slug = refSlug(mr.sourceBranch);
      const pipeline = (mr.headPipeline?.status || 'NONE').toLowerCase();

      return {
        iid: Number(mr.iid),
        title: mr.title,
        url: mr.webUrl,
        author: mr.author.username,
        draft: mr.draft,
        group,
        release,
        dontMerge: hasLabel(labels, settings().dontMergeLabel),
        ready: !release && Boolean(mr.approved) && !isBlocked(labels),
        // What GitLab's list flags as "Cannot be merged automatically".
        conflicts: Boolean(mr.conflicts) || mr.mergeStatusEnum === 'CANNOT_BE_MERGED',
        updatedAt: mr.updatedAt,
        labels: labels.join(', '),
        reviewers: mr.reviewers.nodes.map((r) => r.username),
        approvedBy: mr.approvedBy.nodes.map((a) => a.username),
        approvalsLeft: mr.approvalsLeft || 0,
        pipeline,
        idleDays: Math.floor((now - Date.parse(mr.updatedAt)) / 86400000),
        hasDemo: demos.has(slug),
        demoUrl: demos.get(slug) || '',
      };
    });
  }

  // ---------- views ----------
  const waitsOn = (m, who) => !!who && m.reviewers.includes(who) && !m.approvedBy.includes(who);
  const VIEWS = {
    all: () => true,
    review: (m) => m.group === 'review',
    test: (m) => m.group === 'test',
    merge: (m) => m.ready,
    wip: (m) => m.group === 'wip' && !m.ready,
    release: (m) => m.group === 'release',
    me: (m, who) => waitsOn(m, who),
    mine: (m, who) => m.author === who,
    noreviewer: (m) => m.group === 'review' && m.reviewers.length === 0,
  };

  function reviewLoad(mrs) {
    const load = new Map();
    for (const m of mrs) {
      for (const reviewer of m.reviewers) {
        const row = load.get(reviewer) || { reviewer, open: 0, pending: 0 };
        row.open += 1;
        if (!m.approvedBy.includes(reviewer)) row.pending += 1;
        load.set(reviewer, row);
      }
    }
    return [...load.values()].sort((a, b) => b.open - a.open || b.pending - a.pending || a.reviewer.localeCompare(b.reviewer));
  }

  // ---------- styles ----------
  const CSS = `
    :host { all: initial; display: block; font-family: var(--jv-font); color: var(--jv-fg); }
    :host {
      --jv-font: "GitLab Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --jv-fg: #28272d; --jv-muted: #626168; --jv-bg: #ffffff; --jv-panel: #fbfafd; --jv-line: #dcdcde;
      --jv-review: #b85c00; --jv-test: #217645; --jv-wip: #737278; --jv-all: #28272d;
      --jv-ok: #217645; --jv-bad: #c91c00; --jv-warn: #b85c00; --jv-bar: #c5c4cb; --jv-accent: #1f75cb;
      --jv-merge: #1f75cb; --jv-changed: #c17d10; --jv-changed-bg: rgba(193, 125, 16, .10);
      --jv-release: #7b58cf; --jv-release-bg: rgba(123, 88, 207, .08);
    }
    :host([data-theme="dark"]) {
      --jv-fg: #ececef; --jv-muted: #a4a3a8; --jv-bg: #18171d; --jv-panel: #1f1e24; --jv-line: #3a383f;
      --jv-review: #e9a14a; --jv-test: #52b87a; --jv-wip: #a4a3a8; --jv-all: #ececef;
      --jv-ok: #52b87a; --jv-bad: #ec5941; --jv-warn: #e9a14a; --jv-bar: #535158; --jv-accent: #63a6e9;
      --jv-merge: #63a6e9; --jv-changed: #e9a14a; --jv-changed-bg: rgba(233, 161, 74, .12);
      --jv-release: #ac93e6; --jv-release-bg: rgba(172, 147, 230, .12);
    }
    * { box-sizing: border-box; }
    .wrap { display: grid; gap: 16px; padding-block: 16px; font-size: 14px; line-height: 1.4; }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
    .takeaway { margin: 0; color: var(--jv-muted); }
    .meta { color: var(--jv-muted); font-size: 12px; display: flex; gap: 8px; align-items: center; }
    button { font: inherit; color: inherit; }
    .refresh { background: none; border: 1px solid var(--jv-line); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .refresh:hover { border-color: var(--jv-muted); }

    .status, .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); }
    .stat, .tile { background: var(--jv-panel); border: 1px solid var(--jv-line); border-radius: 8px; padding: 12px 16px;
      display: grid; gap: 2px; text-align: left; cursor: pointer; }
    .stat:hover, .tile:hover, .stat:focus-visible, .tile:focus-visible { border-color: var(--s, var(--jv-muted)); outline: none; }
    .stat[aria-pressed="true"], .tile[aria-pressed="true"] { border-color: var(--s, var(--jv-fg)); box-shadow: inset 0 0 0 1px var(--s, var(--jv-fg)); }
    .stat-label { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--s); }
    .stat-label::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
    .stat-value { font-size: 32px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .note { font-size: 12px; color: var(--jv-muted); }
    .tile { border-style: dashed; }
    .tile-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
    [data-group="review"] { --s: var(--jv-review); } [data-group="test"] { --s: var(--jv-test); }
    [data-group="wip"] { --s: var(--jv-wip); } [data-group="merge"] { --s: var(--jv-merge); } [data-group="all"] { --s: var(--jv-all); }
    [data-group="release"] { --s: var(--jv-release); }
    tr.is-release td { background: var(--jv-release-bg); }
    tr.is-release td:first-child { box-shadow: inset 3px 0 0 var(--jv-release); }

    .card { border: 1px solid var(--jv-line); border-radius: 8px; padding: 16px; display: grid; gap: 12px; min-width: 0; }
    .card h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .card h2 span { color: var(--jv-muted); font-weight: 400; }
    .tools { display: flex; gap: 8px; }
    .search { flex: 1 1 12rem; min-width: 0; font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 6px;
      border: 1px solid var(--jv-line); background: var(--jv-bg); color: var(--jv-fg); }
    .wide { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
    th { text-align: left; font-weight: 600; color: var(--jv-muted); padding: 4px 8px; border-bottom: 1px solid var(--jv-line); white-space: nowrap; }
    td { padding: 8px; border-bottom: 1px solid var(--jv-line); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr.is-seen td { opacity: .45; }
    tr.is-seen td.iid { opacity: 1; }
    tr.is-changed td { background: var(--jv-changed-bg); }
    tr.is-changed td:first-child { box-shadow: inset 3px 0 0 var(--jv-changed); }
    .eye { margin-left: 4px; background: none; border: 0; padding: 0 2px; font-size: 14px; line-height: 1; cursor: pointer; opacity: .35; }
    .eye:hover, .eye[aria-pressed="true"] { opacity: 1; }
    .flag.changed { color: var(--jv-changed); border-color: currentColor; }
    a { color: inherit; text-decoration: none; } a:hover { text-decoration: underline; color: var(--jv-accent); }
    .iid { white-space: nowrap; color: var(--jv-muted); }
    .name { min-width: 16rem; } .name a { font-weight: 300; }
    .flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .flag { font-size: 11px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--jv-line); color: var(--jv-muted); white-space: nowrap; }
    .pill { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; color: var(--s); white-space: nowrap; }
    .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .pipe { white-space: nowrap; }
    .ci { white-space: nowrap; }
    .reviewers { display: flex; align-items: baseline; gap: 2px; }
    .icon-btn { background: none; border: 1px solid transparent; border-radius: 4px; padding: 0 3px; margin-right: 2px;
      font-size: 13px; line-height: 1.3; color: var(--jv-muted); cursor: pointer; }
    .icon-btn:hover, .icon-btn:focus-visible { border-color: var(--jv-line); color: var(--jv-fg); outline: none; }
    /* A small bubble on hover, quicker than the browser's own title. */
    .icon-btn, .conflict { position: relative; }
    .conflict { margin-right: 5px; color: var(--jv-warn); font-weight: 700; cursor: default; outline: none; }
    :is(.icon-btn, .conflict)[data-tip]:hover::after, :is(.icon-btn, .conflict)[data-tip]:focus-visible::after {
      content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%);
      background: var(--jv-fg); color: var(--jv-bg); font-size: 11px; font-weight: 500; line-height: 1.3;
      padding: 3px 7px; border-radius: 4px; white-space: nowrap; pointer-events: none; z-index: 2;
    }
    :is(.icon-btn, .conflict)[data-tip]:hover::before, :is(.icon-btn, .conflict)[data-tip]:focus-visible::before {
      content: ""; position: absolute; left: 50%; bottom: calc(100% + 1px); transform: translateX(-50%);
      border: 5px solid transparent; border-top-color: var(--jv-fg); border-bottom: 0; pointer-events: none; z-index: 2;
    }
    /* The status in grey like the MR number, only its glyph in color. */
    .pipe { color: var(--jv-muted); }
    .pipe-g { display: inline-block; width: 1.1em; font-weight: 700; color: var(--jv-muted); }
    .pipe-g.ok { color: var(--jv-ok); } .pipe-g.bad { color: var(--jv-bad); }
    .pipe-g.warn { color: var(--jv-warn); } .pipe-g.info { color: var(--jv-accent); }
    .muted { color: var(--jv-muted); }
    .idle, .demo { white-space: nowrap; }
    .stale { color: var(--jv-warn); font-weight: 600; }
    .empty, .error { color: var(--jv-muted); font-size: 13px; padding: 8px 0; }
    .error { color: var(--jv-bad); }

    .load-box { font-size: 12px; color: var(--jv-muted); }
    .load-box summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; cursor: pointer; list-style: none; }
    .load-box summary::-webkit-details-marker { display: none; }
    .load-title::before { content: "▸ "; }
    .load-box[open] .load-title::before { content: "▾ "; }
    .load-title { font-weight: 600; }
    .load-chip { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .load-chip.is-me { color: var(--jv-fg); font-weight: 600; }
    .load-box[open] > .legend { margin: 10px 0 6px; }
    .load { display: grid; gap: 6px; }
    .bar-row { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr 2.5rem; gap: 8px; align-items: center; font-size: 13px; }
    .bar-row.is-me .who { font-weight: 600; }
    .who { color: var(--jv-muted); text-align: right; white-space: nowrap; }
    .bar-row.is-me .who { color: var(--jv-fg); }
    .track { position: relative; height: 14px; }
    .bar { position: absolute; inset-block: 0; left: 0; border-radius: 4px; }
    .bar.open { background: var(--jv-bar); } .bar.pending { background: var(--jv-accent); }
    .count { color: var(--jv-muted); }
    .legend { display: flex; gap: 12px; font-size: 12px; color: var(--jv-muted); }
    .legend span::before { content: ""; display: inline-block; width: .7em; height: .7em; border-radius: 2px; margin-right: 4px; background: var(--c); }

    .settings-json { width: 100%; min-height: 18rem; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--jv-fg); background: var(--jv-bg); border: 1px solid var(--jv-line); border-radius: 6px; padding: 8px; resize: vertical; }
    .settings-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .switch { display: inline-flex; border: 1px solid var(--jv-line); border-radius: 6px; overflow: hidden; }
    .switch button { background: var(--jv-bg); border: 0; padding: 4px 12px; cursor: pointer; font-size: 13px; }
    .switch button[aria-pressed="true"] { background: var(--jv-fg); color: var(--jv-bg); }
  `;

  // ---------- DOM helpers (text only: data never goes through innerHTML) ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }
  const safeLink = (href, text) => (/^https:\/\//.test(href || '')
    ? el('a', { href, target: '_blank', rel: 'noopener', text })
    : el('span', { text }));

  // ---------- app ----------
  // "Seen" marks, per browser: the MR's last activity when it was marked. An MR
  // whose activity moved since is shown as changed. Marks expire after 90 days.
  const seen = {
    load() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch { return {}; } },
    save(map) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch { /* private window */ } },
    prune(now) {
      const map = seen.load();
      let changed = false;
      for (const [key, mark] of Object.entries(map)) {
        if (!mark || now - mark.seenAt > SEEN_TTL_MS) { delete map[key]; changed = true; }
      }
      if (changed) seen.save(map);
    },
    stateOf(m, who) {
      // No mark on my own MRs, on the ones ready to merge, nor on a release.
      if (m.ready || m.release || (who && m.author === who)) return null;
      const mark = seen.load()[m.url];
      if (!mark) return 'unseen';
      return mark.token === m.updatedAt ? 'seen' : 'changed';
    },
    toggle(m) {
      const map = seen.load();
      if (map[m.url]?.token === m.updatedAt) delete map[m.url];
      else map[m.url] = { token: m.updatedAt, seenAt: Date.now() };
      seen.save(map);
      render();
    },
    reset() {
      if (!window.confirm(T.seenResetConfirm)) return;
      seen.save({});
      render();
    },
  };

  // Compact age of the last activity: minutes under an hour, hours under a
  // day, then days.
  const ONE_MINUTE = 60 * 1000;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;
  function shortAge(iso, now) {
    const age = now - Date.parse(iso);
    if (age < ONE_MINUTE) return '<1m';
    if (age < ONE_HOUR) return `${Math.floor(age / ONE_MINUTE)}m`;
    if (age < ONE_DAY) return `${Math.floor(age / ONE_HOUR)}h`;
    return `${Math.floor(age / ONE_DAY)}${T.day}`;
  }

  const state = { settingsOpen: false, settingsMessage: '', settingsDraft: null, project: '', mrs: null, error: '', loading: false, loadedAt: 0, query: '', view: store.get(VIEW_KEY, 'all') };
  let host = null;
  let root = null;
  let switchHost = null;

  const theme = () => (document.documentElement.classList.contains('gl-dark') ? 'dark' : 'light');
  const mode = () => store.get(MODE_KEY, 'dashboard');

  function setView(view) {
    state.view = view !== 'all' && view === state.view ? 'all' : view;
    store.set(VIEW_KEY, state.view);
    render();
  }

  async function refresh() {
    state.loading = true;
    render();
    try {
      state.mrs = await load();
      state.error = '';
      state.loadedAt = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function render() {
    if (!root) return;
    const who = me();
    const mrs = state.mrs || [];
    const count = (fn) => (state.mrs ? String(mrs.filter((m) => fn(m, who)).length) : '—');

    const stat = (view, group, label, note) => el('button', {
      class: 'stat', type: 'button', dataset: { group }, 'aria-pressed': String(state.view === view), onclick: () => setView(view),
    }, el('span', { class: 'stat-label', text: label }), el('span', { class: 'stat-value', text: count(VIEWS[view]) }), el('span', { class: 'note', text: note }));

    const tile = (view, label, note) => el('button', {
      class: 'tile', type: 'button', 'aria-pressed': String(state.view === view), onclick: () => setView(view),
    }, el('span', { class: 'note', text: label }), el('span', { class: 'tile-value', text: count(VIEWS[view]) }), el('span', { class: 'note', text: note }));

    const filtered = mrs
      .filter((m) => (VIEWS[state.view] || VIEWS.all)(m, who))
      .filter((m) => !state.query || [m.title, m.author, m.reviewers.join(' '), m.labels, String(m.iid)].join(' ').toLowerCase().includes(state.query))
      .sort((a, b) => (GROUP_ORDER[a.ready ? 'merge' : a.group] ?? 9) - (GROUP_ORDER[b.ready ? 'merge' : b.group] ?? 9) || b.iid - a.iid);

    const withDemo = mrs.some((m) => m.hasDemo);
    // "↗" asks the "GitLab MR CI" script, when installed and on for this
    // project, to open its window on that MR.
    const withCiPanel = document.documentElement.dataset.mrci === projectPath();
    // "Review Claude" copies the review command, to paste into a Claude Code
    // session opened on the project's checkout.
    const reviewClaude = (m) => async (event) => {
      const button = event.currentTarget;
      const command = reviewCommandOf(m);
      try {
        await navigator.clipboard.writeText(command);
        button.textContent = '✓';
        button.dataset.tip = T.copied;
      } catch {
        window.prompt(T.copyPrompt, command);
      }
      setTimeout(() => { button.textContent = '⧉'; button.dataset.tip = T.copy; }, 1500);
    };
    const openCi = (m) => () => window.dispatchEvent(new CustomEvent('mrdash:select', { detail: { project: projectPath(), iid: m.iid } }));
    const ciButton = (m) => el('button', { class: 'icon-btn', type: 'button', 'data-tip': T.openCi, 'aria-label': T.openCiLabel(m.iid), onclick: openCi(m), text: '↗' });
    const pipeStatus = (m) => {
      const [g, tone] = PIPELINE_GLYPHS[m.pipeline] || ['•', 'muted'];
      return el('span', { class: 'pipe' }, el('span', { class: `pipe-g ${tone}`, text: g }), T.pipeline[m.pipeline] || m.pipeline);
    };
    const statusPill = (m) => {
      const group = m.release ? 'release' : m.ready ? 'merge' : m.group;
      return el('span', { class: 'pill', dataset: { group }, text: m.release ? T[m.release] : T[group] });
    };
    const now = Date.now();
    const rows = filtered.map((m) => {
      const mark = seen.stateOf(m, who);
      return el('tr', { class: m.release ? 'is-release' : mark === 'seen' ? 'is-seen' : mark === 'changed' ? 'is-changed' : '' },
      el('td', { class: 'iid' },
        '!' + m.iid,
        mark && el('button', {
          class: 'eye', type: 'button', 'aria-pressed': String(mark === 'seen'),
          title: mark === 'changed' ? T.eyeChanged : mark === 'seen' ? T.eyeUnmark : T.eyeMark,
          onclick: () => seen.toggle(m), text: '👁',
        })),
      el('td', { class: 'name' },
        m.conflicts && el('span', { class: 'conflict', tabindex: '0', 'data-tip': T.conflicts, 'aria-label': T.conflicts, text: '⚠' }),
        safeLink(m.url, m.title), el('div', { class: 'flags' },
        m.draft && el('span', { class: 'flag', text: T.draft }),
        m.dontMerge && el('span', { class: 'flag', text: "Don't merge" }),
        waitsOn(m, who) && el('span', { class: 'flag', text: T.reviewPending }),
        who && m.author === who && el('span', { class: 'flag', text: T.myMr }),
        mark === 'changed' && el('span', { class: 'flag changed', text: T.changed }))),
      el('td', { text: m.author }),
      el('td', {}, statusPill(m)),
      el('td', { class: 'ci' },
        withCiPanel && ciButton(m),
        pipeStatus(m)),
      el('td', {}, el('div', { class: 'reviewers' },
        el('button', { class: 'icon-btn', type: 'button', 'data-tip': T.copy, 'aria-label': T.copyLabel(m.iid), onclick: reviewClaude(m), text: '⧉' }),
        el('span', { class: m.reviewers.length ? '' : 'muted', text: m.reviewers.join(', ') || '—' }))),
      // The demo column only exists where the project's settings name demo environments.
      withDemo && el('td', { class: 'demo' + (m.demoUrl ? '' : ' muted') }, m.demoUrl ? safeLink(m.demoUrl, T.openDemo) : '—'),
      el('td', { class: 'idle' + (m.idleDays > STALE_DAYS ? ' stale' : ''), title: T.lastActivity(new Date(m.updatedAt).toLocaleString(LANG)), text: shortAge(m.updatedAt, now) }));
    });
    const seenCount = Object.keys(seen.load()).length;

    const loadRows = reviewLoad(mrs);
    const max = Math.max(1, ...loadRows.map((r) => r.open));
    const search = el('input', {
      class: 'search', type: 'search', placeholder: T.search, 'aria-label': T.searchLabel, value: state.query,
      oninput: (event) => { state.query = event.target.value.trim().toLowerCase(); refocus = true; render(); },
    });

    const takeaway = state.mrs
      ? T.takeaway(mrs.length, Object.fromEntries(['review', 'noreviewer', 'test', 'merge', 'wip'].map((v) => [v, count(VIEWS[v])])))
      : (state.error ? '' : T.loading);
    // ⚙ Settings: the whole settings JSON, edited in place.
    const settingsCard = state.settingsOpen && (() => {
      // The text being edited survives a redraw (a data refresh, the tab coming back).
      const area = el('textarea', {
        class: 'settings-json', spellcheck: 'false', 'aria-label': T.settingsTitle,
        oninput: (event) => { state.settingsDraft = event.target.value; },
      });
      area.value = state.settingsDraft ?? JSON.stringify(settings(), null, 2);
      const say = (text) => { state.settingsMessage = text; render(); };
      return el('section', { class: 'card settings' },
        el('h2', { text: T.settingsTitle }),
        el('p', { class: 'note', text: T.settingsNote }),
        area,
        el('div', { class: 'settings-actions' },
          el('button', { class: 'refresh', type: 'button', onclick: () => {
            try {
              localStorage.setItem(SETTINGS_KEY, JSON.stringify(JSON.parse(area.value)));
              state.settingsDraft = null;
              window.dispatchEvent(new CustomEvent('mrdash:settings'));
              state.settingsMessage = T.saved;
              refresh();
            } catch (error) { say(T.badJson(error.message)); }
          }, text: T.save }),
          el('button', { class: 'refresh', type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(area.value); say(T.copiedJson); } catch { area.select(); }
          }, text: T.copyJson }),
          el('button', { class: 'refresh', type: 'button', onclick: () => {
            if (!window.confirm(T.resetConfirm)) return;
            try { localStorage.removeItem(SETTINGS_KEY); } catch { /* private window */ }
            state.settingsDraft = null;
            state.settingsMessage = T.saved;
            refresh();
          }, text: T.reset }),
          el('button', { class: 'refresh', type: 'button', onclick: () => { state.settingsOpen = false; state.settingsMessage = ''; state.settingsDraft = null; render(); }, text: T.close }),
          state.settingsMessage && el('span', { class: 'note', text: state.settingsMessage })));
    })();

    root.replaceChildren(el('div', { class: 'wrap' },
      el('div', { class: 'head' },
        el('p', { class: 'takeaway', text: takeaway }),
        el('span', { class: 'meta' },
          seenCount > 0 && el('button', { class: 'refresh', type: 'button', title: T.seenResetTip, onclick: seen.reset, text: T.seenReset(seenCount) }),
          state.loadedAt ? T.updatedAt(new Date(state.loadedAt).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })) : '',
          el('button', { class: 'refresh', type: 'button', disabled: state.loading, onclick: refresh, text: state.loading ? T.loadingShort : T.refresh }),
          el('button', { class: 'refresh', type: 'button', 'aria-expanded': String(state.settingsOpen), onclick: () => { state.settingsOpen = !state.settingsOpen; state.settingsMessage = ''; render(); }, text: T.settings }))),
      settingsCard,
      state.error && el('p', { class: 'error', text: T.loadError(state.error) }),
      el('div', { class: 'status' },
        stat('all', 'all', T.all, T.noteAll(projectName())),
        stat('review', 'review', T.review, T.noteReview),
        stat('test', 'test', T.test, T.noteTest),
        stat('merge', 'merge', T.merge, T.noteMerge),
        stat('wip', 'wip', T.wip, T.noteWip)),
      el('div', { class: 'tiles' },
        tile('noreviewer', T.noreviewer, T.noteNoReviewer),
        who && tile('me', T.me, T.noteMe(who)),
        who && tile('mine', T.mine, T.noteMine(who))),
      el('section', { class: 'card' },
        el('h2', {}, T.tableTitle + ' ', el('span', { text: state.view !== 'all' ? '· ' + (T[state.view] || '') : '' })),
        el('div', { class: 'tools' }, search),
        el('div', { class: 'wide' }, el('table', {},
          el('thead', {}, el('tr', {}, ...T.cols.filter((c, i) => i !== 6 || withDemo).map((t) => el('th', { scope: 'col', text: t })))),
          el('tbody', {}, ...rows))),
        state.mrs && !filtered.length && el('p', { class: 'empty', text: T.empty })),
      // Review load, kept discreet: one line of names and counts, the bars
      // only once opened (remembered per browser).
      loadRows.length > 0 && el('details', {
        class: 'load-box', open: store.get(LOAD_KEY, '0') === '1',
        ontoggle: (event) => store.set(LOAD_KEY, event.currentTarget.open ? '1' : '0'),
      },
        el('summary', {},
          el('span', { class: 'load-title', text: T.loadTitle }),
          ...loadRows.map((r) => el('span', {
            class: 'load-chip' + (r.reviewer === who ? ' is-me' : ''),
            title: T.loadTip(r.open, r.pending),
            text: `${r.reviewer} ${r.open}`,
          }))),
        el('div', { class: 'legend' }, el('span', { style: '--c: var(--jv-bar)', text: T.loadOpen }), el('span', { style: '--c: var(--jv-accent)', text: T.loadPending })),
        el('div', { class: 'load' }, ...loadRows.map((r) => el('div', { class: 'bar-row' + (r.reviewer === who ? ' is-me' : ''), title: T.loadTip(r.open, r.pending) },
          el('span', { class: 'who', text: r.reviewer }),
          el('span', { class: 'track' },
            el('span', { class: 'bar open', style: `width: ${(r.open / max) * 100}%` }),
            el('span', { class: 'bar pending', style: `width: ${(r.pending / max) * 100}%` })),
          el('span', { class: 'count', text: String(r.open) }))))),
    ));

    if (refocus) {
      refocus = false;
      const input = root.querySelector('.search');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  let refocus = false;

  // ---------- mounting into GitLab ----------
  const isListPage = () => LIST_PATH.test(location.pathname);

  function applyMode() {
    const content = document.getElementById('content-body');
    if (!content || !host) return;
    const on = mode() === 'dashboard';
    content.classList.toggle('mrdash-on', on);
    // An inline style, since the shadow root's :host rule would win over `hidden`.
    host.style.display = on ? '' : 'none';
    switchHost?.shadowRoot?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode())));
    if (on && !state.mrs && !state.loading) refresh();
  }

  // Leaving the list for an MR page: take the dashboard out and show GitLab again.
  function unmount() {
    document.getElementById('content-body')?.classList.remove('mrdash-on');
    document.querySelectorAll('.mrdash').forEach((node) => node.remove());
    host = root = switchHost = null;
  }

  function mount() {
    const content = document.getElementById('content-body');
    if (!content || !isListPage()) return;
    if (content.querySelector(':scope > .mrdash')) return;
    seen.prune(Date.now());
    if (state.project !== projectPath()) {
      Object.assign(state, { project: projectPath(), mrs: null, error: '', loadedAt: 0, query: '' });
    }

    if (!document.getElementById('mrdash-page-style')) {
      // Hides GitLab's own list while the dashboard shows, without removing it.
      document.head.append(el('style', { id: 'mrdash-page-style', text: '#content-body.mrdash-on > :not(.mrdash) { display: none !important; }' }));
    }

    switchHost = el('div', { class: 'mrdash mrdash-switch', style: 'display:flex;justify-content:flex-end;padding-top:12px' });
    const switchRoot = switchHost.attachShadow({ mode: 'open' });
    switchRoot.append(el('style', { text: CSS }), el('div', { class: 'switch', role: 'group', 'aria-label': T.switchLabel },
      el('button', { type: 'button', dataset: { mode: 'dashboard' }, onclick: () => { store.set(MODE_KEY, 'dashboard'); applyMode(); }, text: '📊 Dashboard' }),
      el('button', { type: 'button', dataset: { mode: 'gitlab' }, onclick: () => { store.set(MODE_KEY, 'gitlab'); applyMode(); }, text: T.gitlabView })));

    host = el('div', { class: 'mrdash' });
    const shadow = host.attachShadow({ mode: 'open' });
    // Render into a child of the shadow root so the stylesheet survives replaceChildren.
    root = el('div');
    shadow.append(el('style', { text: CSS }), root);

    host.setAttribute('data-theme', theme());
    switchHost.setAttribute('data-theme', theme());
    content.prepend(switchHost, host);
    render();
    applyMode();
  }

  // GitLab swaps page content without a full reload: mount again when needed,
  // and follow its light / dark theme.
  new MutationObserver(() => {
    if (isListPage()) mount();
    else if (host) unmount();
    const t = theme();
    if (host && host.getAttribute('data-theme') !== t) {
      host.setAttribute('data-theme', t);
      switchHost?.setAttribute('data-theme', t);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // Coming back to the tab reloads the data, unless it is less than a minute
  // old: two requests at most, never while the tab is hidden.
  const REFRESH_ON_RETURN_MS = 60 * 1000;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !host || mode() !== 'dashboard') return;
    if (state.loading || Date.now() - state.loadedAt < REFRESH_ON_RETURN_MS) return;
    refresh();
  });
  // "GitLab MR CI" may load after this script: draw its buttons once it is there.
  window.addEventListener('mrci:ready', () => render());
  mount();
})();
