// ==UserScript==
// @name         secret pantheon tech
// @namespace    prominence-chan/cambc
// @version      2026-11-09.7
// @description  Compact Florent-style team, matches and ladder pages for Cambridge Battlecode in its own theme, plus stats (win rate by map, vs champion, champion picks), head-to-head on the ladder, quick unranked challenges and a tournament predictor (single/double elimination, title odds, most common bracket).
// @match        https://2026a.battlecode.co.uk/game/*
// @match        https://*.battlecode.co.uk/game/*
// @updateURL    https://raw.githubusercontent.com/yufanwang07/secret-pantheon-tech/main/secret_pantheon_tech.user.js
// @downloadURL  https://raw.githubusercontent.com/yufanwang07/secret-pantheon-tech/main/secret_pantheon_tech.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Fallback if /api/v1/me isn't available (signed out): rows with this team name count as "mine".
    const TARGET_NAME = 'Pantheon';
    const PAGE_SIZE_TARGET = 50;          // rows to load up front on team pages (Florent shows 50)
    const LADDER_TTL_MS = 10 * 60 * 1000; // current ratings for unranked rows
    const LS = 'cbc-compact:';

    const origFetch = window.fetch.bind(window);
    const settings = Object.assign({ enabled: true, colorByRating: false, myTeamLeft: true },
        JSON.parse(localStorage.getItem(LS + 'settings') || '{}'));
    const save = () => localStorage.setItem(LS + 'settings', JSON.stringify(settings));

    // ---------------------------------------------------------------- api
    async function api(path) {
        let last = '';
        for (let attempt = 0; attempt < 4; attempt++) {
            const r = await origFetch('/api/v1' + path, { credentials: 'same-origin' });
            if (r.status === 429 || r.status >= 500) {
                // "Public API is busy; retry shortly" shows up as 429/503 under load
                last = String(r.status);
                const ra = Number(r.headers.get('Retry-After')) || (1 + attempt * 2);
                await sleep(Math.min(10, ra) * 1000);
                continue;
            }
            if (!r.ok) throw new Error(`${r.status} ${path}`);
            return r.json();
        }
        throw new Error(`busy (${last})`);
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let mePromise = null;
    function me() {
        mePromise ??= api('/me').then(m => ({ teamId: m?.currentTeam?.id ?? null, teamName: m?.currentTeam?.name ?? null }))
            .catch(() => ({ teamId: null, teamName: null }));
        return mePromise;
    }
    const isMine = (side, mine) => mine.teamId ? side.teamId === mine.teamId : side.teamName === TARGET_NAME;

    let ladderPromise = null;
    function ladder() {
        if (ladderPromise) return ladderPromise;
        const cached = JSON.parse(localStorage.getItem(LS + 'ladder') || 'null');
        if (cached && Date.now() - cached.at < LADDER_TTL_MS) return (ladderPromise = Promise.resolve(new Map(cached.rows)));
        ladderPromise = (async () => {
            const rows = [];
            for (let page = 1; page < 40; page++) {
                const d = await api(`/ladder?page=${page}&pageSize=100`);
                for (const t of d.teams || []) rows.push([t.teamId, { rating: t.rating, rank: t.rank }]);
                if (!d.teams || d.teams.length < 100) break;
                await sleep(150);
            }
            try { localStorage.setItem(LS + 'ladder', JSON.stringify({ at: Date.now(), rows })); } catch { }
            return new Map(rows);
        })().catch(() => new Map());
        return ladderPromise;
    }

    // The matches page fetches /match-groups itself; remember its query so our list mirrors the native filters.
    let lastNativeGroupsQuery = null;
    const groupsQueryListeners = new Set();
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : input?.url;
            if (url && /\/api\/v1\/match-groups\?/.test(url)) {
                const u = new URL(url, location.origin);
                if (!u.searchParams.has('before') && location.pathname.startsWith('/game/matches')) {
                    lastNativeGroupsQuery = u.searchParams.toString();
                    groupsQueryListeners.forEach(f => f(lastNativeGroupsQuery));
                }
            }
        } catch { }
        return origFetch(input, init);
    };

    // ---------------------------------------------------------------- helpers
    const h = (tag, attrs = {}, ...kids) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
        return el;
    };
    const fmt = n => n == null ? '' : Math.round(n).toLocaleString('en-GB');
    const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Math.round(n));
    function ago(iso) {
        const s = (Date.now() - Date.parse(iso)) / 1000;
        if (!isFinite(s)) return '';
        if (s < 60) return 'now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }
    function spaNavigate(url, ev) {
        if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return; // let the browser open a tab
        ev?.preventDefault();
        history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }
    const link = (href, cls, text, title) => h('a', { href, class: cls, title: title || text, onclick: e => { e.stopPropagation(); spaNavigate(href, e); } }, text);
    const crown = () => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cbc-crown');
        s.innerHTML = '<path fill="currentColor" d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/>';
        return s;
    };

    // ---------------------------------------------------------------- styles
    function injectStyle() {
        if (document.getElementById('cbc-style')) return;
        const css = `
.cbc-viewer-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 10px; }
.cbc-viewer-label { font-size: 12px; color: var(--cbc-muted); margin-right: 4px; }
:root { --cbc-win: #6fbf73; --cbc-loss: #e2675f; --cbc-line: color-mix(in srgb, currentColor 13%, transparent);
        --cbc-muted: color-mix(in srgb, currentColor 58%, transparent); --cbc-faint: color-mix(in srgb, currentColor 6%, transparent);
        --cbc-mono: 'IBM Plex Mono', ui-monospace, monospace; }
/* site theme: neutral near-black instead of the green-grey, gold accent (light mode keeps its paper, gold accent) */
html:root { --cbc-gold: #b8861f; --nav-active-bg: #efe3c4; --nav-active-ink: #2a2008; --switch-on: #c9a24a; --solid-bg: #1b1a17; --solid-ink: #fbf8ef;
        --docs-accent: #8a6417; --docs-accent-ink: #6b4d10; --scroll-thumb: #b7ad97; --scroll-thumb-hover: #9a8a62; }
html:root[data-theme="dark"] { --cbc-gold: #d8b25a; --page-ink: #ecebe7; --muted-ink: #a3a29c; --panel-border: #2e2e33; --panel-surface: #17171a;
        --panel-subtle: #1e1e22; --main-paper-rgb: 12,12,14; --side-paper-rgb: 16,16,19; --nav-active-bg: #2d2617; --nav-active-ink: #f3dfa8;
        --nav-active-edge: #d8b25a; --nav-hover-bg: #232327; --nav-hover-ink: #ecebe7; --nav-dim: #8e8d88; --scroll-thumb: #3d3d44;
        --scroll-track: #141417; --scroll-thumb-hover: #5a5446; --switch-on: #c9a24a; --solid-bg: #d8b25a; --solid-ink: #16130b;
        --quick-hover: #232327; --docs-accent: #d8b25a; --docs-wash: #24201a; --docs-accent-ink: #e9cf8f; --docs-on-accent: #16130b; }
:root[data-theme="dark"] a[aria-current="page"] { box-shadow: inset 2px 0 0 var(--cbc-gold); }
/* the "submission deadline" notice: one small line */
section[aria-label="Upcoming tournament submission deadline"] { padding: 5px 10px !important; margin: 6px 0 10px !important; font-size: 12.5px !important;
  line-height: 1.35 !important; border-width: 0 0 0 2px !important; border-left-color: var(--cbc-gold) !important; min-height: 0 !important;
  background: color-mix(in srgb, var(--cbc-gold) 9%, transparent) !important; box-shadow: none !important; }
section[aria-label="Upcoming tournament submission deadline"] strong { font-size: inherit !important; font-weight: 600; }
section[aria-label="Upcoming tournament submission deadline"] a { font-size: inherit !important; }
/* ladder: denser rows, no "Your team · N ranked matches" caption */
tr[data-ladder-team] .own-caption { display: none !important; }
tr[data-ladder-team], tr[data-ladder-team] > td { height: 34px !important; }
tr[data-ladder-team] > td { padding-top: 1px !important; padding-bottom: 1px !important; }
tr[data-ladder-team] img { max-height: 22px; }
tr[data-ladder-team] td button, tr[data-ladder-team] td a { min-height: 0 !important; }
tr[data-ladder-team] .rating-line, tr[data-ladder-team] td > a, tr[data-ladder-team] td > div > a { max-height: 30px; }
tr[data-ladder-team] .team-name a { font-weight: 600; }
/* tighter page: less side margin and dead vertical space */
main { flex: 1 1 0 !important; width: auto !important; max-width: none !important; min-width: 0 !important;
  margin-left: 28px !important; margin-right: 28px !important; padding-top: 10px !important; padding-bottom: 20px !important; }
main > div:first-child { row-gap: 12px !important; }
main h1 { font-size: 28px !important; line-height: 1.1 !important; margin-top: 0 !important; margin-bottom: 2px !important; }
main header, main > div:first-child > :first-child { min-height: 0 !important; padding-bottom: 0 !important; margin-bottom: 0 !important; }
/* hidden from the first paint on pages we take over, so cambc's own layout never flashes */
main.cbc-pred-main > :not(.cbc-pred) { display: none !important; }
html.cbc-pre-pred main > :not(.cbc-pred) { visibility: hidden; }
.cbc-pred { padding-top: 2px; }
.cbc-pred .cbc-card { padding: 8px 10px; }
.cbc-pred .cbc-ptab { font-size: 11.5px; } .cbc-pred .cbc-ptab td, .cbc-pred .cbc-ptab th { padding-top: 1px; padding-bottom: 1px; }
.cbc-pred .cbc-predgrid > .cbc-card.fill { min-height: 300px; } .cbc-pred .cbc-predgrid > .cbc-card.fill > .in { padding: 8px 10px; }
.cbc-pred h3 { margin: 0 0 4px; } .cbc-pred .cbc-sub { margin: 2px 0 6px !important; }
.cbc-pred .cbc-shead .big { font-size: 26px; } .cbc-pred .cbc-shead .mid { font-size: 15px; }
a.cbc-pred-nav[aria-current="page"] { background: var(--nav-active-bg) !important; color: var(--nav-active-ink) !important; box-shadow: inset 2px 0 0 var(--cbc-gold); }
.cbc-predgrid > .cbc-card { margin-top: 0 !important; }
/* the right card takes the left card's height and scrolls inside, so the row has no empty space */
.cbc-predgrid { align-items: stretch !important; }
.cbc-predgrid > .cbc-card.fill { position: relative; min-height: 380px; padding: 0; }
.cbc-predgrid > .cbc-card.fill > .in { position: absolute; inset: 0; overflow-y: auto; padding: 12px 14px; }
.cbc-predgrid > .cbc-card.fill thead th { position: sticky; top: -12px; background: var(--cbc-panel); z-index: 1; }
.cbc-ptab td:first-child, .cbc-ptab th:first-child { padding-left: 0; }
.cbc-ptab td:nth-child(3), .cbc-ptab th:nth-child(3) { text-align: right; }
.cbc-ptab.path td:nth-child(3), .cbc-ptab.path th:nth-child(3) { text-align: left; }
.cbc-treewrap { overflow-x: auto; }
.cbc-tree { display: flex; min-width: min-content; }
.cbc-tree .col { flex: 0 0 200px; display: flex; flex-direction: column; }
.cbc-tree .col.champ { flex: 0 0 200px; }
.cbc-de { position: relative; overflow: auto; height: 560px; border-top: 1px solid var(--cbc-line); cursor: grab; }
.cbc-de.drag { cursor: grabbing; user-select: none; }
.cbc-de .cv { position: relative; transform-origin: 0 0; }
.cbc-de .zm { position: sticky; float: right; top: 8px; right: 8px; z-index: 3; display: flex; flex-direction: column; gap: 4px; margin: 8px 8px 0 0; }
.cbc-de .zm button { width: 24px; height: 24px; padding: 0; font: 600 13px var(--cbc-mono); color: inherit; background: var(--cbc-panel); border: 1px solid var(--cbc-line); border-radius: 4px; cursor: pointer; }
.cbc-de .rh { position: absolute; top: 0; font: 600 10px var(--cbc-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--cbc-muted); text-align: center; }
.cbc-de .rh small { opacity: .7; font-weight: 400; margin-left: 3px; }
.cbc-de .sec { position: absolute; left: 0; font: 600 10px var(--cbc-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--cbc-gold); }
.cbc-de .m { position: absolute; width: 148px; border: 1px solid var(--cbc-line); border-radius: 4px; background: var(--cbc-panel); overflow: hidden; }
.cbc-de .m.gf { border-color: var(--cbc-gold); }
.cbc-de .t { display: grid; grid-template-columns: 26px minmax(0, 1fr) 30px; gap: 3px; align-items: center; height: 16px; padding: 0 5px; font-size: 10.5px; color: var(--cbc-muted); }
.cbc-de .t + .t { border-top: 1px solid var(--cbc-line); }
.cbc-de .t.win { color: inherit; background: color-mix(in srgb, var(--cbc-win) 14%, transparent); box-shadow: inset 2px 0 0 var(--cbc-win); font-weight: 600; }
.cbc-de .t.me { box-shadow: inset 2px 0 0 var(--cbc-gold); color: var(--cbc-gold); }
.cbc-de .t .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbc-de .t b { font: 600 10px var(--cbc-mono); text-align: right; } .cbc-de .sd { font: 10px var(--cbc-mono); opacity: .75; }
.cbc-de svg { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
.cbc-de svg path { fill: none; stroke: var(--cbc-line); stroke-width: 1; }
.cbc-lbtree { display: flex; gap: 10px; overflow-x: auto; }
.cbc-lbtree .col { flex: 0 0 168px; display: flex; flex-direction: column; justify-content: space-around; gap: 6px; }
.cbc-lbtree .rh { padding: 0 0 4px; } .cbc-lbtree .box { flex: 0 0 auto; } .cbc-lbtree .t span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cbc-ink, inherit); }
.cbc-tree .rh { font: 600 10px var(--cbc-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--cbc-muted); padding: 0 14px 6px; }
.cbc-tree .slots { display: flex; flex-direction: column; height: calc(var(--rows) * 58px); }
.cbc-tree .mt { flex: 1; display: flex; align-items: center; position: relative; padding: 0 14px; }
.cbc-tree .col:first-child .mt { padding-left: 0; }
.cbc-tree .mt.hi::after, .cbc-tree .mt.lo::after { content: ''; position: absolute; right: 0; width: 14px; height: 50%; border-right: 1px solid var(--cbc-line); }
.cbc-tree .mt.hi::after { top: 50%; border-top: 1px solid var(--cbc-line); } .cbc-tree .mt.lo::after { bottom: 50%; border-bottom: 1px solid var(--cbc-line); }
.cbc-tree .mt.to-champ::after { content: ''; position: absolute; right: 0; width: 14px; top: 50%; border-top: 1px solid var(--cbc-line); }
.cbc-tree .col + .col .mt::before { content: ''; position: absolute; left: 0; width: 14px; top: 50%; border-top: 1px solid var(--cbc-line); }
.cbc-tree .box { flex: 1; min-width: 0; border: 1px solid var(--cbc-line); border-radius: 4px; background: var(--cbc-panel); overflow: hidden; }
.cbc-tree .t { display: grid; grid-template-columns: 34px minmax(0, 1fr) 40px; gap: 4px; align-items: center; height: 22px; padding: 0 7px; font-size: 12px; color: var(--cbc-muted); }
.cbc-tree .t + .t { border-top: 1px solid var(--cbc-line); }
.cbc-tree .t.win { color: inherit; background: color-mix(in srgb, var(--cbc-win) 14%, transparent); box-shadow: inset 2px 0 0 var(--cbc-win); }
.cbc-tree .t.win a { font-weight: 600; }
.cbc-tree .t a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; color: inherit; } .cbc-tree .t a:hover { text-decoration: underline; }
.cbc-tree .t b { font: 600 10.5px var(--cbc-mono); text-align: right; } .cbc-tree .sd { font: 10.5px var(--cbc-mono); opacity: .75; }
.cbc-tree .t.me { box-shadow: inset 2px 0 0 var(--cbc-gold); } .cbc-tree .t.me a { color: var(--cbc-gold); }
.cbc-tree .col.champ .t { height: 28px; font-size: 13px; }
.cbc-predgrid { display: grid; grid-template-columns: minmax(0, 6fr) minmax(0, 5fr); gap: 12px; align-items: start; }
@media (max-width: 1150px) { .cbc-predgrid { grid-template-columns: 1fr; } }
.cbc-ptab { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.cbc-ptab th { text-align: left; font: 600 10px var(--cbc-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--cbc-muted); padding: 4px 6px; border-bottom: 1px solid var(--cbc-line); }
.cbc-ptab td { padding: 3px 6px; border-bottom: 1px solid var(--cbc-line); white-space: nowrap; }
.cbc-ptab td.p { font: 600 11.5px var(--cbc-mono); text-align: right; } .cbc-ptab th:not(:nth-child(-n+3)) { text-align: right; }
.cbc-ptab.path th:nth-child(2) { text-align: right; } .cbc-ptab.path th:nth-child(3) { text-align: left; }
.cbc-ptab td.opp { white-space: normal; } .cbc-ptab td.opp > span { margin-right: 10px; }
.cbc-ptab a, .cbc-pbr a { text-decoration: none; } .cbc-ptab a:hover, .cbc-pbr a:hover { text-decoration: underline; }
.cbc-ptab tr.me td { background: color-mix(in srgb, var(--cbc-gold) 13%, transparent); }
.cbc-ptab .mut, .cbc-pbr .mut, .cbc-ptab small { color: var(--cbc-muted); }
.cbc-pbr { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.cbc-pbr .m { border: 1px solid var(--cbc-line); border-radius: 4px; overflow: hidden; }
.cbc-pbr .t { display: grid; grid-template-columns: 34px minmax(0, 1fr) 40px; gap: 4px; align-items: baseline; padding: 4px 7px; font-size: 12.5px; }
.cbc-pbr .t + .t { border-top: 1px solid var(--cbc-line); }
.cbc-pbr .t a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbc-pbr .t b { font: 600 11px var(--cbc-mono); text-align: right; }
.cbc-pbr .t small { grid-column: 2 / -1; color: var(--cbc-muted); font: 10px var(--cbc-mono); }
.cbc-pbr .t.me { background: color-mix(in srgb, var(--cbc-gold) 13%, transparent); }
@media (max-width: 1150px) { .cbc-pbr { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
html.cbc-pre-team .team-hero, html.cbc-pre-team .team-overview, html.cbc-pre-team .team-analysis, html.cbc-pre-team .team-members,
html.cbc-pre-matches [role=region][aria-label="Match results"], html.cbc-pre-matches .match-pagination { display: none !important; }
/* the team page's lower sections render before the header we anchor to: keep the page blank until we're in */
html.cbc-pre-team body:not(.cbc-on) main { visibility: hidden; }
body.cbc-on .team-hero, body.cbc-on .team-overview, body.cbc-on .team-analysis,
body.cbc-on .cbc-hide-native, body.cbc-on .team-members { display: none !important; }
body.cbc-on-matches [role=region][aria-label="Match results"], body.cbc-on-matches .match-pagination { display: none !important; }
/* Florent-density for cambc's own chrome on these pages: smaller page header and filter bar */
body.cbc-on main h1, body.cbc-on-matches main h1 { font-size: 26px !important; line-height: 1.1 !important; margin: 2px 0 4px !important; }
body.cbc-on-matches main h1 + p { font-size: 13px; margin: 0; }
body.cbc-on-matches .match-toolbar h2 { font-size: 15px; }
body.cbc-on-matches .match-toolbar p { font-size: 12px; }
body.cbc-on-matches .match-toolbar button { min-height: 28px; padding: 2px 10px; font-size: 12.5px; }
body.cbc-on-matches .match-filters { gap: 10px !important; }
body.cbc-on-matches .match-filters label, body.cbc-on-matches details.match-advanced label { font-size: 11.5px; gap: 3px; }
body.cbc-on-matches .match-filters select, body.cbc-on-matches details.match-advanced input,
body.cbc-on-matches details.match-advanced button { min-height: 28px !important; height: 28px; padding: 2px 8px !important; font-size: 12.5px !important; }
body.cbc-on-matches details.match-advanced summary { font-size: 12px; }
.cbc-root { font-size: 13px; line-height: 1.35; }
.cbc-root a { color: inherit; }
.cbc-toggle { font: 500 11px var(--cbc-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--cbc-muted);
  background: none; border: 1px solid var(--cbc-line); border-radius: 3px; padding: 2px 7px; cursor: pointer; }
.cbc-toggle:hover { color: inherit; }
.cbc-team { display: grid; grid-template-columns: minmax(320px, 5fr) minmax(420px, 7fr); gap: 12px 14px; align-items: start; margin-bottom: 18px; }
@media (max-width: 1100px) { .cbc-team { grid-template-columns: 1fr; } }
.cbc-head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--cbc-line); padding-bottom: 8px; }
.cbc-head h1 { font-size: 22px; line-height: 1.15; margin: 0 4px 0 0; display: inline; }
.cbc-titleline { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.cbc-tag { display: inline-flex; align-items: center; height: 17px; box-sizing: border-box; font: 500 10px/1 var(--cbc-mono); border: 1px solid var(--cbc-line); border-radius: 3px;
  padding: 0 6px; color: var(--cbc-muted); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
.cbc-titleline .cbc-tag.mine { color: var(--cbc-gold); border-color: color-mix(in srgb, var(--cbc-gold) 55%, transparent); }
.cbc-sub { margin-top: 4px; color: var(--cbc-muted); font-family: var(--cbc-mono); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cbc-sub b { color: initial; color: inherit; font-weight: 600; }
.cbc-id { cursor: pointer; border: 1px solid var(--cbc-line); border-radius: 3px; padding: 0 5px; }
.cbc-bio { margin-top: 3px; color: var(--cbc-muted); }
.cbc-actions { display: flex; gap: 6px; align-items: center; }
.cbc-card { border: 1px solid var(--cbc-line); border-radius: 4px; padding: 12px 14px; background: var(--cbc-panel); }
.cbc-card + .cbc-card { margin-top: 14px; }
.cbc-card h3 { margin: 0 0 8px; font: 600 11px var(--cbc-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cbc-muted); }
.cbc-bigrow { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.cbc-big { font-size: 28px; font-weight: 500; letter-spacing: -.01em; }
.cbc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
.cbc-stat { border: 1px solid var(--cbc-line); border-radius: 3px; padding: 7px 9px; }
.cbc-stat dt { font: 500 10px var(--cbc-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cbc-muted); }
.cbc-stat dd { margin: 2px 0 0; font-size: 18px; font-weight: 600; }
.cbc-stat small { display: block; color: var(--cbc-muted); font-size: 11px; font-weight: 400; }
.cbc-chart { position: relative; }
.cbc-chart svg { width: 100%; height: 190px; display: block; overflow: visible; }
.cbc-chart .ax { font: 10.5px var(--cbc-mono); fill: var(--cbc-muted); }
.cbc-chart .grid { stroke: var(--cbc-line); stroke-width: 1; }
.cbc-chart .rating { fill: none; stroke: currentColor; stroke-width: 1.4; }
.cbc-chart .rank { fill: none; stroke: var(--cbc-muted); stroke-width: 1; stroke-dasharray: 1.5 2.5; opacity: .8; }
.cbc-chart .hover { stroke: var(--cbc-muted); stroke-dasharray: 2 2; }
.cbc-tip { position: absolute; top: 0; pointer-events: none; font: 11px var(--cbc-mono); background: var(--cbc-bg, #111);
  border: 1px solid var(--cbc-line); border-radius: 3px; padding: 3px 6px; white-space: nowrap; transform: translateX(-50%); }
.cbc-ranges { display: flex; gap: 4px; }
.cbc-ranges button[aria-pressed=true] { color: inherit; border-color: currentColor; }
.cbc-members { display: flex; flex-direction: column; }
.cbc-member { display: flex; gap: 9px; align-items: center; text-decoration: none; padding: 5px 2px; line-height: 22px; }
.cbc-member + .cbc-member { border-top: 1px solid var(--cbc-line); }
.cbc-member:hover span { text-decoration: underline; }
.cbc-member img { width: 22px; height: 22px; border-radius: 50%; flex: none; object-fit: cover; }
.cbc-member small { color: var(--cbc-muted); margin-left: auto; font: 11px/22px var(--cbc-mono); }
.cbc-card h3 + .cbc-members { margin-top: 2px; }
/* left column is narrow: the Live list drops the rating columns there */
.cbc-team > div:nth-child(3) > .cbc-block + .cbc-block { margin-top: 14px; }
.cbc-team > div:nth-child(2) .cbc-row { grid-template-columns: minmax(0,1fr) 3.4em minmax(0,1fr) 4.6em 3.8em; }
.cbc-team > div:nth-child(2) .cbc-row .rt, .cbc-team > div:nth-child(2) .cbc-row .dl { display: none; }
.cbc-team > div > .cbc-block { margin-top: 16px; }
.cbc-block .cbc-listhead { margin-bottom: 6px; }
.cbc-listhead { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
.cbc-listhead h2 { font-size: 15px; margin: 0; }
.cbc-listhead .cnt { color: var(--cbc-muted); font-size: 12px; }
.cbc-listhead .sp { flex: 1; }
.cbc-list { border: 1px solid var(--cbc-line); border-radius: 4px; overflow-y: auto; background: var(--cbc-panel); }
.cbc-list.tall { max-height: 78vh; }
.cbc-list.short { max-height: 34vh; }
.cbc-row { display: grid; grid-template-columns: minmax(0,1fr) 3.4em 2.8em 3.6em 2.8em 3.4em minmax(0,1fr) 4.6em 4.4em;
  align-items: center; gap: 0 6px; padding: 0 10px; height: 29px; border-top: 1px solid var(--cbc-line); cursor: pointer;
  font-variant-numeric: tabular-nums; text-decoration: none; }
.cbc-row:first-child { border-top: 0; }
.cbc-row:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
:root { --cbc-winbg: #cfe9d3; --cbc-lossbg: #f4cdc9; --cbc-tiebg: #e9e2c6; --cbc-panel: #fbfbf9; }
:root[data-theme="dark"] { --cbc-winbg: #1f3d28; --cbc-lossbg: #4a2323; --cbc-tiebg: #3a3622; --cbc-panel: #17171a; }
.cbc-row.win { background: var(--cbc-winbg); }
.cbc-row.loss { background: var(--cbc-lossbg); }
.cbc-row.tie { background: var(--cbc-tiebg); }
.cbc-row.tie:hover { background: color-mix(in srgb, var(--cbc-tiebg) 82%, currentColor); }
.cbc-row.win:hover { background: color-mix(in srgb, var(--cbc-winbg) 82%, currentColor); }
.cbc-row.loss:hover { background: color-mix(in srgb, var(--cbc-lossbg) 82%, currentColor); }
.cbc-row.runhead { cursor: pointer; }
.cbc-row .tg.run { font-weight: 600; }
.cbc-runkids { border-left: 2px solid color-mix(in srgb, currentColor 18%, transparent); background: color-mix(in srgb, currentColor 3%, transparent); }
.cbc-runkids .cbc-row { opacity: .92; }
.cbc-row.mine { box-shadow: inset 2px 0 0 var(--cbc-accent, currentColor); }
.cbc-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbc-row .nm.l { text-align: right; }
.cbc-row .nm a { text-decoration: none; }
.cbc-row .nm a:hover { text-decoration: underline; }
.cbc-row .nm.me a { text-decoration: underline; text-underline-offset: 2px; }
.cbc-row .rt { font: 11.5px var(--cbc-mono); color: var(--cbc-muted); }
.cbc-row .rt.l { text-align: right; }
.cbc-row .rt.cur { font-style: italic; opacity: .75; }
.cbc-row .dl { font: 11px var(--cbc-mono); }
.cbc-row .dl.l { text-align: right; }
.cbc-row .dl.up { color: var(--cbc-win); } .cbc-row .dl.down { color: var(--cbc-loss); }
.cbc-row .sc { text-align: center; font-weight: 700; font-family: var(--cbc-mono); }
.cbc-row .sc.pending { color: var(--cbc-muted); font-weight: 400; }
.cbc-row .cbc-crown { width: 12px; height: 12px; color: #e8b84a; vertical-align: -1px; margin: 0 5px; flex: none; }
.cbc-row .nm { display: flex; align-items: center; min-width: 0; }
.cbc-row .nm.l { justify-content: flex-end; }
.cbc-row .nm a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cbc-row .tg { justify-self: end; font: 500 9.5px var(--cbc-mono); letter-spacing: .04em; color: var(--cbc-muted);
  border: 1px solid var(--cbc-line); border-radius: 3px; padding: 0 4px; text-transform: uppercase; white-space: nowrap; }
.cbc-row .tg.live { color: var(--cbc-win); border-color: color-mix(in srgb, var(--cbc-win) 50%, transparent); }
.cbc-row .tg.err { color: var(--cbc-loss); }
.cbc-row .tm { text-align: right; color: var(--cbc-muted); font-size: 11.5px; white-space: nowrap; }
.cbc-more { display: block; margin: 8px auto 0; }
.cbc-empty { padding: 10px; color: var(--cbc-muted); }
.cbc-opts { display: flex; gap: 10px; align-items: center; font-size: 11.5px; color: var(--cbc-muted); }
.cbc-opts label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
.cbc-matches { margin: 2px 16px 14px; }
body.cbc-on-matches main > div:first-child { grid-template-columns: minmax(0, 1fr) 320px; column-gap: 14px; align-items: start; }
body.cbc-on-matches main > div:first-child > :first-child { grid-column: 1 / -1; }
body.cbc-on-matches main > div:first-child > .cbc-stats-panel { grid-column: 2; grid-row: 2; }
@media (max-width: 1200px) { body.cbc-on-matches main > div:first-child { grid-template-columns: 1fr; }
  body.cbc-on-matches main > div:first-child > .cbc-stats-panel { grid-column: 1; grid-row: auto; } }
.cbc-stats-panel { position: sticky; top: 8px; border: 1px solid var(--cbc-line); border-radius: 4px; padding: 10px 12px; background: var(--cbc-panel); }
.cbc-stats-panel h3 { margin: 12px 0 5px; font: 600 10.5px var(--cbc-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cbc-muted); }
.cbc-statctl { display: flex; gap: 6px; margin-bottom: 8px; }
.cbc-sel { font: 11px/1.2 var(--cbc-mono) !important; height: 22px !important; min-height: 0 !important; color: inherit; background: transparent;
  border: 1px solid var(--cbc-line) !important; border-radius: 3px; padding: 0 4px !important; width: auto !important; }
.cbc-sel option { color: #111; }
.cbc-shead { display: flex; gap: 14px; align-items: flex-end; padding-bottom: 6px; border-bottom: 1px solid var(--cbc-line); }
.cbc-shead .big { font-size: 26px; font-weight: 600; line-height: 1; }
.cbc-shead .mid { font-size: 15px; font-weight: 600; line-height: 1.2; }
.cbc-shead small { color: var(--cbc-muted); font: 10px var(--cbc-mono); }
.cbc-sbar { display: grid; grid-template-columns: 96px 1fr 34px 26px; gap: 6px; align-items: center; height: 19px; font-size: 12px; }
.cbc-pick { display: grid; grid-template-columns: 22px 92px 1fr 40px 44px; gap: 6px; align-items: center; height: 24px; font-size: 12px; }
.cbc-pick .pt { width: 22px; height: 22px; border-radius: 4px; background-repeat: no-repeat; background-color: var(--cbc-line); }
.cbc-pick .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbc-pick .tr { height: 6px; border-radius: 3px; background: var(--cbc-line); overflow: hidden; }
.cbc-pick .tr i { display: block; height: 100%; border-radius: 3px; background: #c9a24a; }
.cbc-pick b { font: 600 11.5px var(--cbc-mono); text-align: right; }
.cbc-pick small { font: 11px var(--cbc-mono); text-align: right; opacity: .75; }
.cbc-sbar .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbc-sbar .tr { height: 6px; border-radius: 3px; background: var(--cbc-line); overflow: hidden; }
.cbc-sbar .tr i { display: block; height: 100%; border-radius: 3px; }
.cbc-sbar b { font: 600 11.5px var(--cbc-mono); text-align: right; }
.cbc-sbar small { color: var(--cbc-muted); font: 10px var(--cbc-mono); text-align: right; }
.cbc-mrow { grid-template-columns: 36px minmax(0, 1fr) 70px 34px 26px; }
.cbc-mrow .rk { color: var(--cbc-muted); font: 10.5px var(--cbc-mono); }
.cbc-mrow .lb a { text-decoration: none; } .cbc-mrow .lb a:hover { text-decoration: underline; }
.cbc-stats-panel .cbc-listhead h3 { margin: 0; }
.cbc-sline { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; padding: 1px 0; }
.cbc-sline span { color: var(--cbc-muted); } .cbc-sline b { font-weight: 500; text-align: right; }
td[data-challenge] { white-space: nowrap; padding-left: 4px !important; padding-right: 8px !important; text-align: right; width: 70px; min-width: 70px; box-sizing: border-box; }
/* both buttons: same 28px box, same 17px icon, centred, small gap */
td[data-challenge] > a, .cbc-quick { display: inline-flex !important; align-items: center; justify-content: center; vertical-align: middle;
  width: 28px !important; height: 28px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; box-sizing: border-box;
  border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.cbc-quick { margin-left: 2px !important; --cbc-boltedge: #5a4310; --cbc-bolt: #f5b800; --cbc-blue: #2f7ff0; }
:root[data-theme="dark"] .cbc-quick { --cbc-boltedge: #1a150a; --cbc-bolt: #ffd23f; --cbc-blue: #4b95ff; }
.cbc-quick.info { --cbc-boltedge: #10305e; }
:root[data-theme="dark"] .cbc-quick.info { --cbc-boltedge: #0b1a30; }
.cbc-quick svg { width: 19px !important; height: 19px !important; }
html body table:has(tr[data-ladder-team]) tr > td[data-challenge], html body table:has(tr[data-ladder-team]) tr > th:last-child { width: 102px !important; min-width: 102px !important; max-width: none !important; }
td[data-challenge] > a svg, .cbc-quick svg { width: 17px !important; height: 17px !important; flex: none; }
td[data-challenge] > a:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.cbc-quick:hover { background: color-mix(in srgb, var(--cbc-gold) 18%, transparent); }
.cbc-quick.info.full { opacity: .3; }
.cbc-quick.info.full:hover { opacity: .8; }
.cbc-quick.busy { opacity: .45; cursor: progress; }
.cbc-quick.done { color: var(--cbc-gold); }
#cbc-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.cbc-toast { font: 13px/1.35 Archivo, system-ui, sans-serif; padding: 9px 13px; border-radius: 5px; max-width: 420px;
  background: var(--cbc-panel, #17171a); color: inherit; border: 1px solid var(--cbc-line); border-left: 3px solid var(--cbc-gold);
  box-shadow: 0 6px 20px rgba(0,0,0,.35); transition: opacity .35s, transform .35s; }
.cbc-toast.err { border-left-color: var(--cbc-loss); }
.cbc-toast.out { opacity: 0; transform: translateY(6px); }
.cbc-toast a { color: var(--cbc-gold); margin-left: 6px; }
.cbc-vsus { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 36px; font: 600 11px/1 var(--cbc-mono);
  text-align: right; font-variant-numeric: tabular-nums; }
.cbc-vsus.none { color: var(--cbc-muted); font-weight: 400; opacity: .45; font-size: 10px; }
/* rank icons: ours replace the platform's from Diamond up; wings/crowns draw outside the 24px box */
.cbc-rank-svg { overflow: visible; width: 1.3rem; height: 1.3rem; color: var(--tier-color); }
span[data-icon-only] .cbc-rank-svg { width: 1.35rem; height: 1.35rem; }
.cbc-rank-gm .cbc-rank-svg { filter: drop-shadow(0 0 2.5px rgba(232,48,74,.6)); }
.cbc-rank-challenger .cbc-rank-svg { filter: drop-shadow(0 0 3px rgba(63,180,255,.7)) drop-shadow(0 0 1.5px rgba(243,201,92,.5)); animation: cbc-chall 3.2s ease-in-out infinite; }
@keyframes cbc-chall { 50% { filter: drop-shadow(0 0 5px rgba(63,180,255,.9)) drop-shadow(0 0 2.5px rgba(243,201,92,.7)); } }
/* qualified teams: golden eligibility icon and rank, gold tint fading out across the row. Our own row: its cells go
   transparent so the tint shows, and the platform's light "you" fill is laid on top of the tint instead */
body:not(.cbc-noqhl) tr.cbc-qrow .cbc-qicon { color: #e9c96b !important; filter: drop-shadow(0 0 3px rgba(233,201,107,.65)); }
body:not(.cbc-noqhl) tr.cbc-qrow .cbc-qicon svg { color: #e9c96b !important; stroke: currentColor; }
body:not(.cbc-noqhl) tr.cbc-qrow td[data-rank] > span:first-child, body:not(.cbc-noqhl) tr.cbc-qrow .cbc-qrank { color: #e9c96b !important; }
body:not(.cbc-noqhl) tr.cbc-qrow { background-image: linear-gradient(90deg, rgba(228,200,126,.13), transparent 45%) !important; }
body:not(.cbc-noqhl) tr.cbc-qrow[data-you="true"] > td { background-color: transparent !important; }
body:not(.cbc-noqhl) tr.cbc-qrow[data-you="true"] { background-image: linear-gradient(rgba(0,0,0,.045), rgba(0,0,0,.045)), linear-gradient(90deg, rgba(228,200,126,.16), transparent 45%) !important; }
html[data-theme="dark"] body:not(.cbc-noqhl) tr.cbc-qrow[data-you="true"] { background-image: linear-gradient(rgba(255,255,255,.075), rgba(255,255,255,.075)), linear-gradient(90deg, rgba(228,200,126,.13), transparent 45%) !important; }
.cbc-qual-label { cursor: pointer; }
body.cbc-qonly tr[data-ladder-team]:not(.cbc-qrow) { display: none !important; }
body.cbc-qonly tr.cbc-qrow td[data-rank] > span:not(.cbc-qrank):not(.cbc-vsus) { display: none !important; }
td[data-rank] span > small, .cbc-qrank small { font-size: 9.5px; color: var(--cbc-muted); opacity: .75; margin-left: 2px; }
#cbc-qhl-toggle { position: absolute; top: 0; right: 0; font-size: 11px; }
#cbc-qhl-toggle.on { border-color: rgba(217,180,83,.7); color: #e9c96b; }
table:has(tr[data-ladder-team]) tr > td:first-child { position: relative; }
/* the header cell keeps the platform's sticky positioning (the vs label inside it is placed against it) */
table:has(tr[data-ladder-team]) thead th:first-child { position: sticky; }
table:has(tr[data-ladder-team]) tr > :first-child { white-space: nowrap; width: 84px; min-width: 84px; box-sizing: border-box;
  padding-right: 50px !important; font-variant-numeric: tabular-nums; }
table:has(tr[data-ladder-team]) thead th:first-child .cbc-vsus { font-weight: 400; font-size: 10px; opacity: .7; }
.cbc-matches .cbc-block + .cbc-block { margin-top: 14px; }
`;
        const st = document.createElement('style');
        st.id = 'cbc-style';
        st.textContent = css;
        (document.head || document.documentElement)?.append(st);
    }
    function sampleTheme(root) {
        const main = document.querySelector('main');
        let bg = 'transparent';
        for (let el = main; el; el = el.parentElement) {
            const c = getComputedStyle(el).backgroundColor;
            if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) { bg = c; break; }
        }
        if (bg === 'transparent') bg = getComputedStyle(document.body).backgroundColor;
        root.style.setProperty('--cbc-bg', bg);
        const active = document.querySelector('nav a[aria-current="page"]');
        const acc = active && getComputedStyle(active).backgroundColor;
        if (acc && !/rgba\(.*,\s*0\)$/.test(acc)) root.style.setProperty('--cbc-accent', acc);
    }

    // ---------------------------------------------------------------- rows
    function orient(group, ctx) {
        // ctx: { mine, focusTeamId } -> [left, right]
        let [a, b] = [group.sides.find(s => s.side === 'a') || group.sides[0], group.sides.find(s => s.side === 'b') || group.sides[1]];
        const wantLeft = s => (settings.myTeamLeft && isMine(s, ctx.mine)) || (!isMineIn(group, ctx.mine) && ctx.focusTeamId && s.teamId === ctx.focusTeamId);
        if (!wantLeft(a) && wantLeft(b)) [a, b] = [b, a];
        return [a, b];
    }
    const isMineIn = (g, mine) => g.sides.some(s => isMine(s, mine));

    // the platform's tiers (rating.js) plus our Challenger at 2800+
    const PLATFORM_TIERS = [[2600, '#cf4848'], [2400, '#e36db6'], [2200, '#ad7dbb'], [2000, '#648dcb'], [1800, '#45a28d'], [1600, '#b99a3c'], [1400, '#8c9eac'], [0, '#b58159']];
    const tierHex = r => r >= 2800 ? '#3fb4ff' : PLATFORM_TIERS.find(([m]) => r >= m)[1];
    // opt.run: the row stands for a run of matches; clicking it toggles them instead of opening a match
    function renderRow(g, ctx, opt = {}) {
        const [L, R] = orient(g, ctx);
        const finished = g.status === 'finished';
        const ranked = g.kind === 'ranked';
        const perspective = (isMine(L, ctx.mine) && (settings.myTeamLeft || !ctx.focusTeamId)) || L.teamId === ctx.focusTeamId;
        const dL = L.ratingAfter != null && L.ratingBefore != null ? L.ratingAfter - L.ratingBefore : null;
        const dR = R.ratingAfter != null && R.ratingBefore != null ? R.ratingAfter - R.ratingBefore : null;

        let cls = 'cbc-row';
        if (perspective && finished) {
            if (settings.colorByRating && dL != null) cls += dL > 0 ? ' win' : dL < 0 ? ' loss' : ' tie';
            else cls += L.wins > R.wins ? ' win' : L.wins < R.wins ? ' loss' : ' tie';
        }
        if (isMineIn(g, ctx.mine) && !perspective) cls += ' mine';

        const rating = (s) => {
            if (s.ratingBefore != null) return h('span', { class: 'rt', title: 'rating before this match' }, fmt(s.ratingBefore));
            const cur = ctx.ladder?.get(s.teamId);
            return cur ? h('span', { class: 'rt cur', title: `current rating · rank #${cur.rank}` }, fmt(cur.rating)) : h('span', { class: 'rt' });
        };
        const delta = (d) => d == null ? h('span', { class: 'dl' }) :
            h('span', { class: 'dl ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') }, signed(d));
        const winL = finished && (g.winnerTeamId ? g.winnerTeamId === L.teamId : L.wins > R.wins);
        const winR = finished && (g.winnerTeamId ? g.winnerTeamId === R.teamId : R.wins > L.wins);
        const name = (s, side, won) => {
            const ver = s.version != null ? h('span', { class: 'cbc-tag', style: `margin:0 ${side === 'l' ? '0 0 5px' : '5px 0 0'}`, title: 'bot version' }, 'v' + s.version) : null;
            const a = link(`/game/team/${s.teamId}`, '', s.teamName);
            // team names in their rank tier's colour, like the ladder: rating at the time, else the current one
            const r = s.ratingBefore ?? ctx.ladder?.get(s.teamId)?.rating;
            if (r != null) { const ink = tierInk(tierHex(r), document.documentElement.dataset.theme === 'dark'); if (ink) { a.style.color = ink; a.dataset.cbcR = Math.round(r); } }
            return h('span', { class: `nm ${side}${isMine(s, ctx.mine) ? ' me' : ''}` },
                ...(side === 'l' ? [ver, won ? crown() : null, a] : [a, won ? crown() : null, ver]));
        };
        const lRating = rating(L); lRating.classList.add('l');
        const lDelta = delta(dL); lDelta.classList.add('l');
        const tag = opt.run ? h('span', { class: 'tg run' }, `${opt.open ? '▾' : '▸'} ×${opt.run}`)
            : g.status === 'running' ? h('span', { class: 'tg live' }, 'live')
            : g.status === 'queued' ? h('span', { class: 'tg' }, 'queued')
                : g.status === 'error' ? h('span', { class: 'tg err' }, 'error')
                    : !ranked ? h('span', { class: 'tg' }, g.kind === 'tournament' ? 'tournament' : 'unranked') : h('span');
        const href = `/game/match-groups/${g.id}`;
        const row = opt.run
            ? h('div', { class: cls + ' runhead' + (opt.open ? ' open' : ''), role: 'button', title: opt.title, onclick: e => { if (!e.target.closest('a')) opt.onToggle(); } },
            name(L, 'l', winL), lRating, lDelta,
            h('span', { class: 'sc' + (finished ? '' : ' pending') }, `${L.wins}-${R.wins}`),
            delta(dR), rating(R), name(R, 'r', winR),
            tag,
            h('span', { class: 'tm', title: new Date(g.finishedAt || g.createdAt).toLocaleString() }, ago(g.finishedAt || g.createdAt)))
            : h('a', { class: cls, href, title: `${L.teamName} vs ${R.teamName} · ${g.kind} · ${g.gameCount} maps`, onclick: e => spaNavigate(href, e) },
            name(L, 'l', winL), lRating, lDelta,
            h('span', { class: 'sc' + (finished ? '' : ' pending') }, `${L.wins}-${R.wins}`),
            delta(dR), rating(R), name(R, 'r', winR),
            tag,
            h('span', { class: 'tm', title: new Date(g.finishedAt || g.createdAt).toLocaleString() }, ago(g.finishedAt || g.createdAt)));
        row.dataset.group = g.id;
        return row;
    }

    // queued + running games live in their own "Live" box; history is finished games only
    const isLive = g => g.status === 'queued' || g.status === 'running';
    const notLive = g => !isLive(g);

    // Finished unranked matches between the same two teams on the same two versions fold into one row, even with other
    // matches in between, as long as each is within RUN_GAP of the previous one in the run.
    const RUN_GAP = 10 * 60 * 1000;
    const when = g => Date.parse(g.finishedAt || g.createdAt);
    const runKey = g => g.kind === 'unranked' && g.status === 'finished' && g.sides.length === 2
        ? g.sides.map(s => `${s.teamId}@${s.version}`).sort().join('|') : null;
    function foldRuns(rows) {
        const out = [], open = new Map();
        for (const g of rows) {
            const k = runKey(g), run = k && open.get(k);
            if (run && Math.abs(when(run.groups.at(-1)) - when(g)) <= RUN_GAP) { run.groups.push(g); continue; }
            const r = { key: k, groups: [g] };
            out.push(r);
            if (k) open.set(k, r);
        }
        return out;
    }
    const wonBy = g => g.winnerTeamId ?? (() => { const [a, b] = g.sides; return a.wins > b.wins ? a.teamId : b.wins > a.wins ? b.teamId : null; })();
    function renderRun(run, ctx, open, onToggle) {
        const newest = run[0];
        const wins = id => run.filter(g => wonBy(g) === id).length;
        const maps = id => run.reduce((n, g) => n + (g.sides.find(s => s.teamId === id)?.wins || 0), 0);
        // the run as one pseudo match: score = maps summed over the run, rating = current ladder rating
        const g = { ...newest, winnerTeamId: undefined,
            sides: newest.sides.map(s => ({ ...s, wins: maps(s.teamId), ratingBefore: null, ratingAfter: null })) };
        const [A, B] = newest.sides;
        const title = `${run.length} unranked matches · ${A.teamName} ${maps(A.teamId)}-${maps(B.teamId)} ${B.teamName} · matches won ${wins(A.teamId)}-${wins(B.teamId)}`;
        const head = renderRow(g, ctx, { run: run.length, open, onToggle, title });
        if (!open) return [head];
        return [head, h('div', { class: 'cbc-runkids' }, run.map(x => renderRow(x, ctx)))];
    }

    // A paginated list of match groups backed by /match-groups?<query>.
    function groupList({ query, ctx, title, size = 'tall', minRows = 25, refreshMs = 0, filter = null, emptyText = 'No matches', noMore = false }) {
        const state = { groups: [], next: null, more: false, loading: false, dead: false, total: null, open: new Set() };
        const count = h('span', { class: 'cnt' });
        const list = h('div', { class: `cbc-list ${size}` }, h('div', { class: 'cbc-empty' }, 'Loading…'));
        const more = h('button', { class: 'cbc-toggle cbc-more', style: 'display:none', onclick: () => load(true) }, 'Load more');
        const block = h('div', { class: 'cbc-block' }, h('div', { class: 'cbc-listhead' }, h('h2', {}, title), count, h('span', { class: 'sp' }), ctx.headExtra || null), list, more);

        function paint() {
            const rows = (filter ? state.groups.filter(filter) : state.groups);
            const els = foldRuns(rows).flatMap(r => {
                if (r.groups.length < 2) return [renderRow(r.groups[0], ctx)];
                const id = r.groups.at(-1).id; // oldest match: stays put as new ones land on top
                return renderRun(r.groups, ctx, state.open.has(id), () => { state.open.has(id) ? state.open.delete(id) : state.open.add(id); paint(); });
            });
            list.replaceChildren(...(rows.length ? els : [h('div', { class: 'cbc-empty' }, state.loading ? 'Loading…' : emptyText)]));
            count.textContent = rows.length ? `${rows.length}${state.more ? '+' : ''} ${size === 'short' ? '' : 'loaded'}`.trim() : '';
            more.style.display = state.more && !noMore ? '' : 'none';
        }
        async function load(append) {
            if (state.loading || state.dead) return;
            state.loading = true;
            try {
                do {
                    const q = new URLSearchParams(query);
                    if (append && state.next) q.set('before', state.next);
                    const d = await api('/match-groups?' + q);
                    if (state.dead) return;
                    const fresh = d.groups || [];
                    if (append) state.groups.push(...fresh.filter(g => !state.groups.some(x => x.id === g.id)));
                    else state.groups = fresh;
                    state.next = d.next; state.more = !!d.more; ctx.onLive?.(d.live);
                    append = true;
                } while (state.more && state.groups.length < minRows);
            } catch (e) {
                if (!state.groups.length) list.replaceChildren(h('div', { class: 'cbc-empty' }, 'Could not load matches (' + e.message + ')'));
                return;
            } finally { state.loading = false; }
            paint();
            if (ctx.needLadder && state.groups.some(g => g.sides.some(s => s.ratingBefore == null))) {
                ladder().then(m => { if (!state.dead && ctx.ladder !== m) { ctx.ladder = m; paint(); } });
            }
        }
        // Refresh just the newest page and merge it on top (live / queued matches move fast).
        async function refresh() {
            if (state.loading || state.dead || document.hidden) return;
            try {
                const d = await api('/match-groups?' + query);
                const fresh = d.groups || [];
                const ids = new Set(fresh.map(g => g.id));
                state.groups = [...fresh, ...state.groups.filter(g => !ids.has(g.id) && Date.parse(g.createdAt) < Date.parse(fresh.at(-1)?.createdAt || 0))];
                ctx.onLive?.(d.live);
                paint();
            } catch { }
        }
        const timer = refreshMs ? setInterval(refresh, refreshMs) : null;
        ctx.repaint = paint;
        load(false);
        return { el: block, paint, destroy() { state.dead = true; timer && clearInterval(timer); } };
    }

    // ---------------------------------------------------------------- chart
    function ratingChart(history) {
        const wrap = h('div', { class: 'cbc-chart' });
        const tip = h('div', { class: 'cbc-tip', style: 'display:none' });
        const ranges = h('div', { class: 'cbc-ranges' });
        let range = localStorage.getItem(LS + 'range') || 'all';
        const opts = [['1d', 864e5], ['7d', 7 * 864e5], ['30d', 30 * 864e5], ['all', Infinity]];
        for (const [k] of opts) {
            ranges.append(h('button', { class: 'cbc-toggle', 'aria-pressed': String(k === range), onclick: () => { range = k; localStorage.setItem(LS + 'range', k); draw(); } }, k));
        }
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        wrap.append(svg, tip);
        const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

        function draw() {
            for (const b of ranges.children) b.setAttribute('aria-pressed', String(b.textContent === range));
            svg.replaceChildren();
            const span = opts.find(o => o[0] === range)[1];
            const now = Date.now();
            let pts = history.map(p => ({ t: Date.parse(p.at), r: p.rating, k: p.rank, m: p.matches })).filter(p => isFinite(p.t));
            if (isFinite(span)) {
                const cut = now - span;
                const before = pts.filter(p => p.t < cut).at(-1);
                pts = pts.filter(p => p.t >= cut);
                if (before) pts.unshift({ ...before, t: cut });
            }
            if (pts.length < 2) { svg.append(el('text', { x: 10, y: 20, class: 'ax' })); svg.lastChild.textContent = 'Not enough history yet'; return; }
            const W = wrap.clientWidth || 480, H = 190, padL = 40, padR = 28, padT = 8, padB = 20;
            svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
            const t0 = pts[0].t, t1 = Math.max(pts.at(-1).t, t0 + 1);
            let rMin = Math.min(...pts.map(p => p.r)), rMax = Math.max(...pts.map(p => p.r));
            const pad = Math.max(10, (rMax - rMin) * 0.08); rMin -= pad; rMax += pad;
            const kMax = Math.max(...pts.map(p => p.k || 1)), kMin = 1;
            const x = t => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
            const y = r => padT + (rMax - r) / (rMax - rMin) * (H - padT - padB);
            const yk = k => padT + (Math.log(k) - Math.log(kMin)) / Math.max(1e-6, Math.log(kMax) - Math.log(kMin)) * (H - padT - padB);
            // grid + axes
            const step = niceStep((rMax - rMin) / 4);
            for (let v = Math.ceil(rMin / step) * step; v <= rMax; v += step) {
                svg.append(el('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'grid' }));
                const tx = el('text', { x: padL - 5, y: y(v) + 3.5, 'text-anchor': 'end', class: 'ax' }); tx.textContent = fmt(v); svg.append(tx);
            }
            for (const k of rankTicks(kMax)) {
                const tx = el('text', { x: W - padR + 5, y: yk(k) + 3.5, class: 'ax' }); tx.textContent = '#' + k; svg.append(tx);
            }
            const days = (t1 - t0) / 864e5;
            const nT = Math.max(2, Math.min(8, Math.floor((W - padL - padR) / 70)));
            for (let i = 0; i <= nT; i++) {
                const t = t0 + (t1 - t0) * i / nT;
                const d = new Date(t);
                const tx = el('text', { x: x(t), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === nT ? 'end' : 'middle', class: 'ax' });
                tx.textContent = days <= 2 ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                svg.append(tx);
            }
            const path = (f) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${f(p).toFixed(1)}`).join('');
            svg.append(el('path', { d: path(p => yk(p.k || 1)), class: 'rank' }));
            svg.append(el('path', { d: path(p => y(p.r)), class: 'rating' }));
            const hover = el('line', { y1: padT, y2: H - padB, class: 'hover', style: 'display:none' });
            const dot = el('circle', { r: 3, fill: 'currentColor', style: 'display:none' });
            svg.append(hover, dot);
            svg.onmousemove = (ev) => {
                const bb = svg.getBoundingClientRect();
                const px = (ev.clientX - bb.left) * (W / bb.width);
                const t = t0 + (px - padL) / (W - padL - padR) * (t1 - t0);
                let best = pts[0];
                for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
                hover.setAttribute('x1', x(best.t)); hover.setAttribute('x2', x(best.t)); hover.style.display = '';
                dot.setAttribute('cx', x(best.t)); dot.setAttribute('cy', y(best.r)); dot.style.display = '';
                tip.style.display = ''; tip.style.left = (x(best.t) / W * 100) + '%';
                tip.textContent = `${fmt(best.r)} · #${best.k} · ${new Date(best.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
            };
            svg.onmouseleave = () => { hover.style.display = 'none'; dot.style.display = 'none'; tip.style.display = 'none'; };
        }
        new ResizeObserver(() => draw()).observe(wrap);
        return { el: wrap, ranges, draw };
    }
    function niceStep(raw) {
        const p = Math.pow(10, Math.floor(Math.log10(raw)));
        for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
        return 10 * p;
    }
    function rankTicks(kMax) {
        const out = [1];
        for (const k of [2, 5, 10, 20, 50, 100, 200, 500]) if (k < kMax * 0.75) out.push(k);
        if (kMax > 1 && !out.includes(kMax)) out.push(kMax);
        return out.slice(-6);
    }

    // ---------------------------------------------------------------- pages
    let mounted = null; // { key, destroy() }

    function unmount() {
        mounted?.destroy();
        mounted = null;
        document.body?.classList.remove('cbc-on', 'cbc-on-matches');
    }

    function optsBar(onChange, extra = []) {
        const mk = (key, label, title, cb = onChange) => h('label', { title: title || null },
            h('input', { type: 'checkbox', checked: settings[key] || null, onchange: e => { settings[key] = e.target.checked; save(); cb(); } }), label);
        return h('span', { class: 'cbc-opts' }, mk('myTeamLeft', 'my team left'), mk('colorByRating', 'colour by rating'), ...extra.map(x => mk(...x)));
    }
    function compactSwitch() {
        return h('button', {
            class: 'cbc-toggle', title: 'Switch between the compact view and cambc\'s original layout',
            onclick: () => { settings.enabled = !settings.enabled; save(); prehide(); unmount(); route(); }
        }, settings.enabled ? 'original view' : 'compact view');
    }

    async function mountTeam(key, teamParam) {
        const anchor = document.querySelector('.team-hero');
        if (!anchor) return false;
        // put our block in place right away (holding its space), so nothing jumps when the data lands
        const root = h('div', { class: 'cbc-root cbc-team', 'data-cbc': key, style: 'min-height:640px' });
        const subs = [];
        mounted = { key, destroy() { subs.forEach(s => s.destroy?.()); root.remove(); } };
        anchor.parentElement.insertBefore(root, anchor);
        document.body.classList.add('cbc-on');
        const mine = await me();
        const teamId = teamParam || mine.teamId;
        if (!teamId) { root.remove(); mounted = null; document.body.classList.remove('cbc-on'); prehideOff(); return false; }
        sampleTheme(root);

        const head = h('div', { class: 'cbc-head' }, h('div', {}, h('h1', {}, '…')), h('div', { class: 'cbc-actions' }, compactSwitch()));
        const left = h('div', {}, h('div', { class: 'cbc-card cbc-empty' }, 'Loading…'));
        const right = h('div', {});
        root.append(head, left, right);

        // last copy of this team's performance renders instantly; a fresh one replaces it below
        const perfKey = LS + 'perf:' + teamId;
        let perf = null;
        try { const c = JSON.parse(sessionStorage.getItem(perfKey) || 'null'); if (c && Date.now() - c.at < 3 * 60e3) perf = c.d; } catch { }
        const fresh = api(`/teams/${encodeURIComponent(teamId)}/performance`).then(d => { try { sessionStorage.setItem(perfKey, JSON.stringify({ at: Date.now(), d })); } catch { } return d; });
        try { perf ??= await fresh; }
        catch (e) {
            left.replaceChildren(h('div', { class: 'cbc-card cbc-empty' }, 'Could not load team (' + e.message + '). ',
                h('button', { class: 'cbc-toggle', onclick: () => { unmount(); route(); } }, 'retry')));
            return true;
        }
        if (mounted?.key !== key) return true;
        left.replaceChildren();
        const { team, rating = {}, history = [] } = perf;
        const tier = document.querySelector('.team-rating > span')?.textContent?.trim();
        const isMyTeam = teamId === mine.teamId || (!mine.teamId && team.name === TARGET_NAME);

        // header: name · tags / rating · id / bio
        head.firstChild.replaceChildren(
            h('div', { class: 'cbc-titleline' }, h('h1', {}, team.name),
                team.category ? h('span', { class: 'cbc-tag' }, team.category.replace(/_/g, ' ')) : null,
                tier ? h('span', { class: 'cbc-tag' }, tier) : null,
                isMyTeam ? h('span', { class: 'cbc-tag mine' }, 'my team') : null),
            h('div', { class: 'cbc-sub' },
                h('b', {}, fmt(rating.rating)),
                rating.delta7d != null ? h('span', { style: `color:var(${rating.delta7d >= 0 ? '--cbc-win' : '--cbc-loss'})` }, signed(rating.delta7d) + ' 7d') : null,
                '·', h('span', { class: 'cbc-id', title: 'copy team id ' + team.id, onclick: e => { navigator.clipboard?.writeText(team.id); e.target.textContent = 'copied'; setTimeout(() => e.target.textContent = team.id.slice(0, 8), 900); } }, team.id.slice(0, 8)),
                h('span', {}, `${team.members?.length ?? 0} members`)),
            team.bio ? h('div', { class: 'cbc-bio' }, team.bio) : null);
        if (!isMyTeam) {
            head.lastChild.prepend(link(`/game/matches?challenge=${encodeURIComponent(team.id)}`, 'cbc-toggle', 'play unranked', 'Challenge this team (unranked)'));
        }

        // stats + chart
        const total = await ladder().then(m => m.size || null);
        const chart = ratingChart(history);
        const winRate = rating.wins + rating.losses ? Math.round(100 * rating.wins / (rating.wins + rating.losses)) : null;
        left.append(
            h('div', { class: 'cbc-card' },
                h('div', { class: 'cbc-bigrow' }, h('span', { class: 'cbc-big' }, fmt(rating.rating)), h('span', { class: 'cnt', style: 'color:var(--cbc-muted)' }, `${fmt(rating.matches)} matches`)),
                h('dl', { class: 'cbc-stats' },
                    h('div', { class: 'cbc-stat' }, h('dt', {}, 'Rank'), h('dd', {}, rating.rank ? '#' + rating.rank : '–', total ? h('small', {}, 'of ' + total) : null)),
                    h('div', { class: 'cbc-stat' }, h('dt', {}, 'Peak rank'), h('dd', {}, rating.peakRank ? '#' + rating.peakRank : '–')),
                    h('div', { class: 'cbc-stat' }, h('dt', {}, 'Peak rating'), h('dd', {}, fmt(rating.peakRating) || '–')),
                    h('div', { class: 'cbc-stat' }, h('dt', {}, 'Ranked W/L'), h('dd', {}, winRate != null ? winRate + '%' : '–', h('small', {}, `${rating.wins ?? 0}-${rating.losses ?? 0}`)))),
                h('div', { class: 'cbc-listhead', style: 'margin-top:4px' }, h('h3', { style: 'margin:0' }, 'Rating · rank'), h('span', { class: 'sp' }), chart.ranges),
                chart.el),
            h('div', { class: 'cbc-card' }, h('h3', {}, `Members (${team.members?.length ?? 0})`),
                h('div', { class: 'cbc-members' }, (team.members || []).map(m =>
                    h('a', { class: 'cbc-member', href: `/game/profile/${m.userId}`, onclick: e => spaNavigate(`/game/profile/${m.userId}`, e) },
                        m.avatarUrl ? h('img', { src: m.avatarUrl, alt: '', referrerpolicy: 'no-referrer' })
                            : h('span', { style: 'width:22px;height:22px;border-radius:50%;background:var(--cbc-line);flex:none' }),
                        h('span', {}, m.displayName),
                        h('small', {}, 'since ' + new Date(m.joinedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })))))));
        requestAnimationFrame(chart.draw);
        const picks = pickCard(teamId);
        subs.push(picks); left.append(picks.el);

        // win rate by map: against this team, or (own page) normalized across opponents
        if (mine.teamId) {
            const mapCard = h('div', { class: 'cbc-card cbc-stats-panel', style: 'position:static' });
            const paintMaps = () => {
                const own = teamId === mine.teamId;
                const recs = own ? statsScope(stats.recs) : vsRecs(teamId);
                const rows = [...groupBy(recs, r => [r.map])].map(([k, rs]) => [k, normWR(rs)]).sort((a, b) => b[1].wr - a[1].wr);
                const tot = own ? normWR(recs) : mapNormWR(recs);
                mapCard.replaceChildren(
                    h('h3', { style: 'margin-top:0' }, own ? 'Win rate by map (normalized across opponents)' : `${mine.teamName || 'Us'} v${stats.main} vs ${team.name} by map · 7d`,
                        tot ? h('span', { style: `float:right;color:${wrColor(tot.wr)}` }, pct(tot.wr) + (own ? '' : ' map-norm.')) : null),
                    ...(rows.length ? rows.map(([k, s2]) => h('div', { class: 'cbc-sbar', title: `${pct(s2.wr)} · ${s2.n} games` },
                        h('span', { class: 'lb' }, k.replace(/^\d\d/, '')), h('span', { class: 'tr' }, h('i', { style: `width:${Math.round(s2.wr * 100)}%;background:${wrColor(s2.wr)}` })),
                        h('b', { style: `color:${wrColor(s2.wr)}` }, pct(s2.wr)), h('small', {}, s2.n)))
                        : [h('div', { class: 'cbc-empty', style: 'padding:2px 0' }, stats.loading ? `loading ${stats.fetched}/${stats.toFetch}…` : own ? 'No games yet' : `N/A: no games against ${team.name} on v${stats.main} in the last 7 days`)]));
            };
            left.append(mapCard);
            left.append(matchupCard(teamId, team.name, subs));
            stats.listeners.add(paintMaps);
            subs.push({ destroy() { stats.listeners.delete(paintMaps); } });
            paintMaps();
            loadStats();
        }

        // right column: matches of interest (vs my team) + full history
        const ctx = { mine, focusTeamId: teamId, needLadder: true };
        const repaintAll = () => subs.forEach(s => s.paint?.());
        ctx.headExtra = optsBar(repaintAll);
        if (!isMyTeam && mine.teamId) {
            const interest = groupList({
                query: `scope=all&team=${teamId}&opponent=${mine.teamId}`, ctx: { ...ctx, headExtra: null }, title: 'Matches of interest',
                size: 'short', minRows: 10, refreshMs: 30000, emptyText: `No matches against ${mine.teamName || 'your team'} yet`,
            });
            subs.push(interest); right.append(interest.el);
        }
        const live = groupList({
            query: `scope=all&team=${teamId}`, ctx: { ...ctx, headExtra: null }, title: 'Live', size: 'short', minRows: 0,
            refreshMs: 15000, filter: isLive, emptyText: 'Nothing queued or playing', noMore: true,
        });
        subs.push(live);
        if (isMyTeam) right.prepend(live.el); else left.append(live.el); // own page: top right, above the history
        const hist = groupList({ query: `scope=all&team=${teamId}`, ctx, title: 'Match History', minRows: PAGE_SIZE_TARGET, refreshMs: 30000, filter: notLive });
        subs.push(hist); right.append(hist.el);
        root.style.minHeight = '';
        fresh.catch(() => { });
        return true;
    }

    async function mountMatches(key) {
        const region = document.querySelector('[role=region][aria-label="Match results"]');
        const section = region?.parentElement;
        if (!region || !section) return false;
        const mine = await me();
        const root = h('div', { class: 'cbc-root cbc-matches', 'data-cbc': key });
        const subs = [];
        let unsub = null;
        mounted = { key, destroy() { subs.forEach(s => s.destroy()); unsub?.(); root.remove(); } };
        section.insertBefore(root, region);
        document.body.classList.add('cbc-on-matches');
        sampleTheme(root);

        const ctx = { mine, focusTeamId: null, needLadder: true };
        const repaintAll = () => subs.forEach(s => s.paint());
        // "active bot unranked": history becomes just our unranked matches played by the bot currently set active
        // (asked server-side for our unranked groups, then narrowed to that version here)
        const activeVer = () => stats.active ?? (stats.main >= 0 ? stats.main : null);
        const onlyActive = g => { const v = activeVer(); return v == null || g.sides?.find(x => x.teamId === mine.teamId)?.version === v; };
        const histQuery = () => settings.activeUnranked && mine.teamId ? `scope=team&team=${mine.teamId}&kind=unranked` : (lastNativeGroupsQuery || nativeQueryFromUrl());
        const bar = h('div', { class: 'cbc-listhead', style: 'justify-content:flex-end' }, optsBar(repaintAll, mine.teamId ? [['activeUnranked', 'active bot unranked only',
            'Only our unranked matches played with the bot version currently set active', () => { if (settings.activeUnranked) loadStats(); build(histQuery()); }]] : []), compactSwitch());
        const liveBox = h('div');
        const histBox = h('div');
        const panel = statsPanel();
        subs.push(panel);
        root.append(bar, liveBox, histBox);
        section.parentElement.append(panel.el); // beside the whole "Match history" card, not inside it
        const destroy0 = mounted.destroy;
        mounted.destroy = () => { destroy0(); panel.el.remove(); };

        if (mine.teamId) {
            // "Live (matches of interest)": my team's running + queued groups, pinned on top.
            const live = groupList({
                query: `scope=team&team=${mine.teamId}`, ctx: { ...ctx, headExtra: null }, filter: isLive,
                title: 'Live · ' + (mine.teamName || 'my team'), size: 'short', minRows: 0, refreshMs: 15000, emptyText: 'Nothing queued or playing', noMore: true,
            });
            subs.push(live); liveBox.append(live.el);
        }
        let hist = null;
        const build = (query) => {
            if (hist) { hist.destroy(); subs.splice(subs.indexOf(hist), 1); }
            const act = settings.activeUnranked && mine.teamId;
            hist = groupList({ query, ctx, title: act ? 'History · active bot, unranked' : 'History', minRows: 50, refreshMs: 20000, filter: act ? g => notLive(g) && onlyActive(g) : notLive });
            hist.query = query;
            subs.push(hist); histBox.replaceChildren(hist.el);
        };
        build(histQuery());
        const onQuery = q => { if (!(settings.activeUnranked && mine.teamId) && q !== hist?.query) build(q); };
        groupsQueryListeners.add(onQuery);
        const onStats = () => hist?.paint(); // the active version can land after the list does
        stats.listeners.add(onStats);
        if (settings.activeUnranked) loadStats();
        unsub = () => { groupsQueryListeners.delete(onQuery); stats.listeners.delete(onStats); };
        return true;
    }
    function nativeQueryFromUrl() {
        const u = new URLSearchParams(location.search), o = new URLSearchParams();
        for (const k of ['scope', 'kind', 'team', 'opponent', 'version', 'from', 'to', 'map', 'result', 'status']) {
            const v = u.get('group-' + k); if (v) o.set(k, v);
        }
        if (!o.has('scope')) o.set('scope', 'all');
        return o.toString();
    }

    // ---------------------------------------------------------------- stats data
    // Our finished match groups with per-map detail (map, drafts, end reason), cached in localStorage: finished groups
    // never change, so after the first load only new groups are fetched.
    const STATS_KEY = LS + 'stats-v2';
    const STATS_MAX_GROUPS = 4000;
    const STATS_BACKFILL_MS = 3 * 864e5; // how far back the first load lists our matches
    const EXCLUDED_VERSIONS = new Set([46]); // our versions left out of every win rate (v46 = troll bot)
    const CHAMP_NAMES = ['Ryth', 'Vesper Vale', 'Vendetta', 'Cassi & Issac', 'Stellar', 'Prism', 'Marcella', 'Willow', 'Ren', 'Varg', 'Tavi', 'Heart of Ruin']; // platform draft ids = the SDK's champion_draft order, then HoR (11)
    const stats = { cache: null, recs: [], loading: false, done: false, fetched: 0, toFetch: 0, listeners: new Set(), promise: null };
    function statsCache() {
        if (!stats.cache) { try { stats.cache = JSON.parse(localStorage.getItem(STATS_KEY) || 'null'); } catch { } }
        if (!stats.cache || stats.cache.team == null) stats.cache = { team: null, groups: {} };
        return stats.cache;
    }
    function statsSave() {
        const c = statsCache();
        const ids = Object.keys(c.groups).sort((a, b) => c.groups[b].t - c.groups[a].t);
        for (const id of ids.slice(STATS_MAX_GROUPS)) delete c.groups[id];
        try { localStorage.setItem(STATS_KEY, JSON.stringify(c)); } catch { }
    }
    function statsRebuild() {
        const c = statsCache();
        stats.recs = Object.values(c.groups).flatMap(g => g.m.map(([map, opp, oppName, ver, res, oppDraft, ourDraft, end, rounds, oppVer]) =>
            ({ t: g.t, kind: g.k, map, opp, oppName, ver, res, oppDraft, ourDraft, end, rounds, oppVer: oppVer ?? null })));
        stats.recs = stats.recs.filter(r => !EXCLUDED_VERSIONS.has(r.ver));
        stats.latest = Math.max(-1, ...stats.recs.map(r => r.ver ?? -1));
        // "latest version" for win rates = newest version with a real sample (a just-uploaded bot doesn't wipe the numbers)
        const perVer = {}; for (const r of stats.recs) perVer[r.ver] = (perVer[r.ver] || 0) + 1;
        const vs = Object.keys(perVer).map(Number).filter(v => v >= 0).sort((a, b) => b - a);
        stats.main = stats.active ?? vs.find(v => perVer[v] >= 150) ?? vs[0] ?? -1; // the bot set active for submission, when known
        stats.listeners.forEach(f => f());
    }
    function compactGroup(d, teamId) {
        const g = d.group || {};
        const m = (d.matches || []).filter(x => x.status === 'finished').map(x => {
            const us = x.sides.find(s => s.teamId === teamId), them = x.sides.find(s => s.teamId !== teamId);
            if (!us || !them) return null;
            const res = us.result === 'win' ? 1 : us.result === 'loss' ? 0 : 0.5;
            return [x.map, them.teamId, them.teamName, us.version, res, (them.draft || []).join(','), (us.draft || []).join(','), x.endReason, x.rounds, them.version ?? null];
        }).filter(Boolean);
        return { t: Date.parse(g.finishedAt || g.createdAt) || 0, k: g.kind, m };
    }
    function loadStats() {
        if (stats.promise) return stats.promise;
        stats.promise = (async () => {
            const mine = await me();
            if (!mine.teamId) return;
            const c = statsCache();
            if (c.team !== mine.teamId) { c.team = mine.teamId; c.groups = {}; }
            try { const sub = await api('/submissions'); stats.active = sub?.active?.version ?? sub?.selected?.version ?? null; } catch { }
            statsRebuild();
            stats.loading = true;
            // newest first: stop listing once a whole page is already cached, or at the cap
            const want = [];
            let before = null, seen = 0;
            // after one full backfill only new groups need listing; until then keep going back STATS_BACKFILL_MS
            for (let page = 0; page < 200 && seen < STATS_MAX_GROUPS; page++) {
                const d = await api(`/match-groups?scope=team&team=${mine.teamId}&status=finished` + (before ? `&before=${encodeURIComponent(before)}` : ''));
                const gs = d.groups || [];
                seen += gs.length;
                const fresh = gs.filter(g => !c.groups[g.id] && !EXCLUDED_VERSIONS.has(g.sides.find(x => x.teamId === mine.teamId)?.version));
                want.push(...fresh.map(g => g.id));
                const oldest = Math.min(...gs.map(g => Date.parse(g.finishedAt || g.createdAt)));
                if (!fresh.length && c.backfilled) break;
                if (!d.more || Date.now() - oldest > STATS_BACKFILL_MS) { c.backfilled = true; break; }
                before = d.next;
                if (page % 10 === 9) { stats.toFetch = want.length; stats.listing = seen; stats.listeners.forEach(f => f()); }
            }
            c.backfilled = true; // reached the time window or the group cap: later loads only list new groups
            stats.toFetch = want.length; stats.fetched = 0;
            stats.listeners.forEach(f => f());
            let i = 0;
            const worker = async () => {
                while (i < want.length) {
                    const id = want[i++];
                    try { c.groups[id] = compactGroup(await api(`/match-groups/${id}`), mine.teamId); } catch { }
                    stats.fetched++;
                    if (stats.fetched % 60 === 0) { statsRebuild(); statsSave(); }
                }
            };
            await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
            statsSave();
            stats.loading = false; stats.done = true;
            statsRebuild();
        })().catch(e => { stats.loading = false; stats.error = e.message; stats.listeners.forEach(f => f()); });
        return stats.promise;
    }
    // Win rate with every opponent weighted equally: mean over opponents of our win rate against them.
    function normWR(recs) {
        const by = new Map();
        for (const r of recs) { const o = by.get(r.opp) || [0, 0]; o[0] += r.res; o[1]++; by.set(r.opp, o); }
        if (!by.size) return null;
        let s = 0; for (const [w, n] of by.values()) s += w / n;
        return { wr: s / by.size, n: recs.length, opps: by.size, raw: recs.reduce((a, r) => a + r.res, 0) / recs.length };
    }
    // Our win rate against one team with every map weighted equally.
    function mapNormWR(recs) {
        const by = new Map();
        for (const r of recs) { const o = by.get(r.map) || [0, 0]; o[0] += r.res; o[1]++; by.set(r.map, o); }
        if (!by.size) return null;
        let s = 0; for (const [w, n] of by.values()) s += w / n;
        return { wr: s / by.size, n: recs.length, maps: by.size, byMap: [...by].map(([map, [w, n]]) => ({ map, wr: w / n, n })).sort((a, b) => a.wr - b.wr) };
    }
    function groupBy(recs, keys) {
        const m = new Map();
        for (const r of recs) for (const k of keys(r)) { if (k == null || k === '') continue; (m.get(k) || m.set(k, []).get(k)).push(r); }
        return m;
    }
    // red (bad) -> amber -> green (good); readable on both themes
    function wrColor(wr) {
        const dark = document.documentElement.dataset.theme === 'dark';
        const hue = Math.round(Math.max(0, Math.min(1, (wr - 0.30) / 0.50)) ** 1.25 * 125); // red up to ~30%, full green from ~80%
        return dark ? `hsl(${hue} 72% 62%)` : `hsl(${hue} 75% 34%)`;
    }
    const pct = x => Math.round(x * 100) + '%';
    const pctFit = x => Math.min(99, Math.round(x * 100)) + '%'; // ladder column: never three digits
    // Head-to-head numbers only count recent games on our latest version (and their latest, when we know it).
    const H2H_WINDOW = 7 * 864e5;
    function vsRecs(oppId, list) {
        let rs = (list || stats.recs).filter(r => r.opp === oppId && r.ver === stats.main && Date.now() - r.t < H2H_WINDOW);
        const theirs = Math.max(-1, ...rs.map(r => r.oppVer ?? -1));
        if (theirs >= 0) rs = rs.filter(r => r.oppVer === theirs);
        return rs;
    }
    // Time windows a stat can be looked at over (Yufan: down to the last hour).
    const WINDOWS = { '1h': 36e5, '3h': 3 * 36e5, '12h': 12 * 36e5, '24h': 864e5, '2d': 2 * 864e5, '7d': 7 * 864e5 };
    function statsScope(recs) {
        const sc = settings.statsScope || 'latest';
        let out = recs;
        if (settings.statsKind && settings.statsKind !== 'all') out = out.filter(r => r.kind === settings.statsKind);
        if (sc === 'latest') out = out.filter(r => r.ver === stats.main);
        else if (sc === 'newest') out = out.filter(r => r.ver === stats.latest);
        else if (WINDOWS[sc]) out = out.filter(r => Date.now() - r.t < WINDOWS[sc]);
        return out;
    }

    function statsPanel() {
        const body = h('div', { class: 'cbc-statbody' });
        const status = h('span', { class: 'cnt' });
        const sel = (key, opts, def) => h('select', { class: 'cbc-sel', onchange: e => { settings[key] = e.target.value; save(); paint(); } },
            opts.map(([v, l]) => { const o = h('option', { value: v }, l); if ((settings[key] || def) === v) o.selected = true; return o; }));
        const el = h('div', { class: 'cbc-block cbc-stats-panel' },
            h('div', { class: 'cbc-listhead' }, h('h2', {}, 'Statistics of interest'), status),
            h('div', { class: 'cbc-statctl' },
                sel('statsScope', [['latest', 'active bot'], ['newest', 'newest upload'], ['1h', 'last hour'], ['3h', 'last 3h'], ['12h', 'last 12h'],
                    ['24h', 'last 24h'], ['7d', 'last 7 days'], ['all', 'all loaded']], 'latest'),
                sel('statsKind', [['all', 'all kinds'], ['ranked', 'ranked'], ['unranked', 'unranked']], 'all')),
            body);
        const bar = (label, s, extra) => h('div', { class: 'cbc-sbar', title: `${pct(s.wr)} normalized · ${s.n} games${s.opps ? ` · ${s.opps} opponents` : ''}${s.raw != null ? ` · raw ${pct(s.raw)}` : ''}` },
            h('span', { class: 'lb' }, label),
            h('span', { class: 'tr' }, h('i', { style: `width:${Math.round(s.wr * 100)}%;background:${wrColor(s.wr)}` })),
            h('b', { style: `color:${wrColor(s.wr)}` }, pct(s.wr)),
            h('small', {}, extra ?? s.n));
        const section = (title, rows) => rows.length ? [h('h3', {}, title), ...rows] : [];
        function paint() {
            const recs = statsScope(stats.recs);
            status.textContent = stats.loading ? (stats.toFetch ? `loading ${stats.fetched}/${stats.toFetch}…` : `listing ${stats.listing || 0}…`) : stats.error ? 'error: ' + stats.error : `${recs.length} games`;
            if (!recs.length) { body.replaceChildren(h('div', { class: 'cbc-empty' }, stats.loading ? 'Loading match details…' : 'No games in this range')); return; }
            const all = normWR(recs);
            const v = recs[0] && ['latest', 'newest', undefined].includes(settings.statsScope) ? recs[0].ver : null;
            const maps = [...groupBy(recs, r => [r.map])].map(([k, rs]) => [k, normWR(rs)]).filter(([, s]) => s.n >= 3).sort((a, b) => b[1].wr - a[1].wr);
            const vsChamp = [...groupBy(recs, r => r.oppDraft.split(','))].map(([k, rs]) => [CHAMP_NAMES[k] ?? k, normWR(rs)]).filter(([, s]) => s.n >= 5).sort((a, b) => b[1].wr - a[1].wr);
            const ourChamp = [...groupBy(recs, r => r.ourDraft.split(','))].map(([k, rs]) => [CHAMP_NAMES[k] ?? k, normWR(rs)]);
            const opps = [...groupBy(recs, r => [r.opp])].map(([k, rs]) => [rs[0].oppName, mapNormWR(rs)]).filter(([, s]) => s.n >= 4).sort((a, b) => a[1].wr - b[1].wr);
            const wins = recs.filter(r => r.res === 1), losses = recs.filter(r => r.res === 0);
            const avg = rs => rs.length ? Math.round(rs.reduce((a, r) => a + (r.rounds || 0), 0) / rs.length) : '–';
            const ends = rs => { const m = {}; for (const r of rs) m[r.end || '?'] = (m[r.end || '?'] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${Math.round(100 * n / rs.length)}%`).join(' · '); };
            body.replaceChildren(
                h('div', { class: 'cbc-shead' },
                    h('div', {}, h('div', { class: 'big', style: `color:${wrColor(all.wr)}` }, pct(all.wr)), h('small', {}, 'normalized win rate')),
                    h('div', {}, h('div', { class: 'mid' }, pct(all.raw)), h('small', {}, 'raw')),
                    h('div', {}, h('div', { class: 'mid' }, String(all.opps)), h('small', {}, 'opponents')),
                    v != null && v >= 0 ? h('div', {}, h('div', { class: 'mid' }, 'v' + v), h('small', {}, 'version')) : null),
                ...section('By map', maps.map(([k, s]) => bar(k.replace(/^\d\d/, ''), s))),
                ...section('Vs enemy champion', vsChamp.map(([k, s]) => bar(k, s))),
                ...(new Set(recs.map(r => r.ourDraft)).size > 1 ? section('With our pick', ourChamp.filter(([, s]) => s.n >= 5).sort((a, b) => b[1].wr - a[1].wr).map(([k, s]) => bar(k, s))) : []),
                ...section('Toughest opponents (map-normalized)', opps.slice(0, 6).map(([k, s]) => bar(k, s))),
                ...section('Games', [
                    h('div', { class: 'cbc-sline' }, h('span', {}, 'avg length'), h('b', {}, `${avg(wins)} won · ${avg(losses)} lost`)),
                    h('div', { class: 'cbc-sline' }, h('span', {}, 'wins end by'), h('b', {}, ends(wins) || '–')),
                    h('div', { class: 'cbc-sline' }, h('span', {}, 'losses end by'), h('b', {}, ends(losses) || '–'))]));
        }
        stats.listeners.add(paint);
        paint();
        loadStats();
        return { el, paint, destroy() { stats.listeners.delete(paint); } };
    }

    // ---------------------------------------------------------------- champion picks
    // How often a team drafted each champion over its last N games (like the ladder's "Top picks", which is fixed
    // at 50), N chosen from 5 / 50 / 500, ranked only or all. Finished groups never change, so their drafts are
    // cached (both sides, so other team pages reuse them).
    const PICK_KEY = LS + 'picks-v1';
    const PICK_MAX_GROUPS = 3000;
    const PICK_SPRITE = '/service/assets/champion-portraits-small-BLRnSYpX.webp'; // the ladder's own icon atlas
    const PICK_SPRITE_XY = { 0: [86, 2], 1: [170, 2], 2: [86, 170], 3: [170, 86], 4: [254, 170], 5: [2, 170], 6: [254, 2], 7: [2, 86], 8: [86, 86], 9: [2, 2], 10: [170, 170] };
    const PICK_HOR = '/service/assets/heart-of-ruin-portrait-DiF91UP-.webp';
    let pickCache = null;
    function pickStore() {
        if (!pickCache) { try { pickCache = JSON.parse(localStorage.getItem(PICK_KEY) || 'null'); } catch { } }
        return (pickCache ??= {});
    }
    function pickSave() {
        const c = pickStore();
        const ids = Object.keys(c).sort((a, b) => c[b].t - c[a].t);
        for (const id of ids.slice(PICK_MAX_GROUPS)) delete c[id];
        try { localStorage.setItem(PICK_KEY, JSON.stringify(c)); } catch { }
    }
    function pickGroup(d) {
        const g = d.group || {}, by = {};
        for (const x of d.matches || []) {
            if (x.status !== 'finished') continue;
            for (const sd of x.sides || []) (by[sd.teamId] ||= []).push([(sd.draft || []).join(','), sd.result === 'win' ? 1 : sd.result === 'loss' ? 0 : 0.5]);
        }
        return { t: Date.parse(g.finishedAt || g.createdAt) || 0, k: g.kind, d: by };
    }
    function portraitStyle(id) {
        if (id === 11) return `background-image:url(${PICK_HOR});background-size:cover;background-position:center`;
        const xy = PICK_SPRITE_XY[id];
        if (!xy) return '';
        const sc = 22 / 80; // atlas is 336x252 with 80px icons
        return `background-image:url(${PICK_SPRITE});background-size:${336 * sc}px ${252 * sc}px;background-position:-${xy[0] * sc}px -${xy[1] * sc}px`;
    }
    function pickCard(teamId) {
        const status = h('span', { class: 'cnt' });
        const body = h('div', {});
        let alive = true, token = 0;
        const sel = (key, opts, def) => h('select', { class: 'cbc-sel', onchange: e => { settings[key] = e.target.value; save(); load(); } },
            opts.map(([v, l]) => { const o = h('option', { value: v }, l); if ((settings[key] || def) === v) o.selected = true; return o; }));
        const el = h('div', { class: 'cbc-card' },
            h('div', { class: 'cbc-listhead', style: 'margin-bottom:4px' }, h('h3', { style: 'margin:0' }, 'Champion picks'), h('span', { class: 'sp' }),
                sel('pickN', [['5', 'last 5'], ['50', 'last 50'], ['500', 'last 500']], '50'),
                sel('pickKind', [['ranked', 'ranked'], ['all', 'all kinds']], 'ranked'), status),
            body);
        function paint(games, want, loading) {
            const n = games.length;
            status.textContent = loading ? `loading ${n}/${want}…` : `${n} games`;
            if (!n) { body.replaceChildren(h('div', { class: 'cbc-empty', style: 'padding:2px 0' }, loading ? 'Loading…' : 'No games yet')); return; }
            const cnt = new Map();
            for (const [draft, res] of games) for (const k of new Set(draft.split(',').filter(x => x !== ''))) {
                const c = cnt.get(k) || [0, 0]; c[0]++; c[1] += res; cnt.set(k, c);
            }
            const rows = [...cnt].sort((a, b) => b[1][0] - a[1][0]);
            body.replaceChildren(...rows.map(([k, [p, w]]) => {
                const id = Number(k), name = CHAMP_NAMES[id] ?? k, f = p / n, wr = w / p;
                return h('div', { class: 'cbc-pick', title: `${name}: picked in ${p} of ${n} games (${pct(f)}) · ${pct(wr)} won when picked` },
                    h('span', { class: 'pt', style: portraitStyle(id) }), h('span', { class: 'lb' }, name),
                    h('span', { class: 'tr' }, h('i', { style: `width:${Math.round(f * 100)}%` })),
                    h('b', {}, pct(f)), h('small', { style: `color:${wrColor(wr)}` }, pct(wr) + ' W'));
            }));
        }
        async function load() {
            const my = ++token, want = Number(settings.pickN || 50), kind = settings.pickKind || 'ranked';
            const c = pickStore();
            const games = [];
            let before = null, fetched = 0;
            paint(games, want, true);
            try {
                for (let page = 0; page < 60 && games.length < want; page++) {
                    const d = await api(`/match-groups?scope=all&team=${encodeURIComponent(teamId)}&status=finished` + (kind === 'ranked' ? '&kind=ranked' : '') + (before ? `&before=${encodeURIComponent(before)}` : ''));
                    if (!alive || my !== token) return;
                    const gs = (d.groups || []).filter(g => g.status === 'finished' && (kind !== 'ranked' || g.kind === 'ranked'));
                    // fetch the groups we don't have yet, six at a time, newest first
                    const need = gs.filter(g => !c[g.id]);
                    for (let i = 0; i < need.length; i += 6) {
                        await Promise.all(need.slice(i, i + 6).map(async g => { try { c[g.id] = pickGroup(await api(`/match-groups/${g.id}`)); fetched++; } catch { } }));
                        if (!alive || my !== token) return;
                    }
                    for (const g of gs) {
                        for (const m of c[g.id]?.d?.[teamId] || []) if (games.length < want) games.push(m);
                    }
                    paint(games, want, true);
                    if (!d.more || !d.next) break;
                    before = d.next;
                }
            } catch (e) { status.textContent = 'error: ' + e.message; }
            if (fetched) pickSave();
            if (alive && my === token) paint(games, want, false);
        }
        load();
        return { el, paint() { }, destroy() { alive = false; } };
    }

    // ---------------------------------------------------------------- team matchups
    // This team's map win rate against each opponent over its recent match groups (listing only: group scores are
    // maps won, so no per-match detail fetches). Sortable by the opponent's ladder rank or by win rate.
    const MATCHUP_PAGES = 24; // listing pages at most per load (50 groups each)
    const MATCHUP_SPANS = ['1h', '3h', '12h', '24h', '2d', '7d'];
    function matchupCard(teamId, teamName, subs) {
        const span = () => MATCHUP_SPANS.includes(settings.matchupSpan) ? settings.matchupSpan : '2d';
        const body = h('div', { style: 'max-height:430px;overflow-y:auto;margin-right:-6px;padding-right:6px' }, h('div', { class: 'cbc-empty', style: 'padding:2px 0' }, 'Loading…'));
        const sortBtn = (k, label) => h('button', { class: 'cbc-toggle', 'aria-pressed': String((settings.matchupSort || 'rank') === k),
            onclick: () => { settings.matchupSort = k; save(); for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.k === settings.matchupSort)); paint(); } }, label);
        const bar = h('span', { class: 'cbc-ranges' }, sortBtn('rank', 'rank'), sortBtn('wr', 'wr'));
        [...bar.children].forEach((b, i) => b.dataset.k = ['rank', 'wr'][i]);
        const spanSel = h('select', { class: 'cbc-sel', title: 'time window', onchange: e => { settings.matchupSpan = e.target.value; save(); load(); } },
            MATCHUP_SPANS.map(v => { const o = h('option', { value: v }, v); if (span() === v) o.selected = true; return o; }));
        const head = h('h3', { style: 'margin:0' }, `${teamName} matchups`);
        const card = h('div', { class: 'cbc-card cbc-stats-panel', style: 'position:static' }, h('div', { class: 'cbc-listhead' }, head, h('span', { class: 'sp' }), spanSel, bar), body);
        let rows = null, ranks = new Map(), dead = false, loadId = 0;
        subs.push({ destroy() { dead = true; } });
        function paint() {
            if (!rows) return;
            const list = [...rows.values()].map(r => ({ ...r, wr: r.w / r.n, rank: ranks.get(r.id)?.rank ?? 1e9 }));
            list.sort(settings.matchupSort === 'wr' ? (a, b) => b.wr - a.wr || b.n - a.n : (a, b) => a.rank - b.rank || b.n - a.n);
            body.replaceChildren(...(list.length ? list.map(r => h('div', { class: 'cbc-sbar cbc-mrow', title: `${pct(r.wr)} of ${r.n} maps over ${r.g} matches` },
                h('span', { class: 'rk' }, r.rank < 1e9 ? '#' + r.rank : '–'),
                h('span', { class: 'lb' }, link(`/game/team/${r.id}`, '', r.name)),
                h('span', { class: 'tr' }, h('i', { style: `width:${Math.round(r.wr * 100)}%;background:${wrColor(r.wr)}` })),
                h('b', { style: `color:${wrColor(r.wr)}` }, pct(r.wr)), h('small', {}, r.n)))
                : [h('div', { class: 'cbc-empty', style: 'padding:2px 0' }, `No finished matches in the last ${span()}`)]));
        }
        const load = () => (async () => {
            const id = ++loadId, windowMs = WINDOWS[span()], m = new Map();
            rows = null;
            body.replaceChildren(h('div', { class: 'cbc-empty', style: 'padding:2px 0' }, 'Loading…'));
            let before = null;
            for (let page = 0; page < MATCHUP_PAGES && !dead && id === loadId; page++) {
                const d = await api(`/match-groups?scope=all&team=${teamId}&status=finished` + (before ? `&before=${encodeURIComponent(before)}` : ''));
                let old = false;
                for (const g of d.groups || []) {
                    if (Date.now() - Date.parse(g.finishedAt || g.createdAt) > windowMs) { old = true; continue; }
                    const us = g.sides.find(x => x.teamId === teamId), them = g.sides.find(x => x.teamId !== teamId);
                    if (!us || !them) continue;
                    const r = m.get(them.teamId) || { id: them.teamId, name: them.teamName, w: 0, n: 0, g: 0 };
                    r.w += us.wins || 0; r.n += (us.wins || 0) + (them.wins || 0); r.g++;
                    m.set(them.teamId, r);
                }
                if (id !== loadId) return;
                rows = new Map([...m].filter(([, r]) => r.n > 0)); paint();
                if (old || !d.more) break;
                before = d.next;
            }
            if (id === loadId) head.textContent = `${teamName} matchups · ${span()} · ${rows?.size ?? 0} teams`;
        })().catch(e => body.replaceChildren(h('div', { class: 'cbc-empty' }, 'Could not load matchups (' + e.message + ')')));
        load();
        ladder().then(l => { ranks = l; paint(); });
        return card;
    }

    // ---------------------------------------------------------------- tournament predictor
    // Projects the next tournament from the current ladder: seeds = ladder order of the eligible field (dev teams are
    // never eligible), standard single-elimination bracket padded to a power of two with byes for the top seeds, every
    // series best of GAMES. Per-game win chance is the Elo expectation, nudged by our own recent head-to-head games
    // (Beta prior worth PRIOR_GAMES); the bracket is then solved exactly (a tree of independent subtrees).
    // Once the upcoming tournament's seeding has frozen, its real field, seeds and bracket slots replace the ladder
    // guess (see frozenSeeding); Elo still comes from the live ladder.
    const PRED_FIELDS = {
        sprint: { label: 'Sprint', format: 'single', test: t => ['uk', 'international', 'non_student'].includes(t.category) },
        uk: { label: 'UK', format: 'double', test: t => t.category === 'uk' },
        international: { label: 'International', format: 'double', test: t => t.category === 'international' },
        // Finals: the qualifiers' fields together; qualifiers and finals are double elimination, only sprints are single
        finals: { label: 'Finals', format: 'double', test: t => ['uk', 'international'].includes(t.category) },
    };
    const PRIOR_GAMES = 12, US_PRIOR_GAMES = 3;
    let predLadderP = null;
    function predLadder() {
        predLadderP ??= (async () => {
            const rows = [];
            for (let page = 1; page < 30; page++) {
                const d = await api(`/ladder?page=${page}&pageSize=100`);
                for (const t of d.teams || []) rows.push({ id: t.teamId, name: t.name, category: t.category, rating: t.rating, rank: t.rank,
                    dev: !!t.isDev, hasBot: t.hasBot !== false, qualifies: t.qualifiesForTournament !== false, provisional: !!t.provisional });
                if (!d.teams || d.teams.length < 100) break;
            }
            return rows;
        })().catch(e => { predLadderP = null; throw e; });
        return predLadderP;
    }
    function seedOrder(size) { // standard bracket: seed list per slot pair, top seeds spread apart
        let L = [1];
        while (L.length < size / 2) { const k = L.length * 2; L = L.flatMap(s => [s, k + 1 - s]); }
        return L.flatMap(s => [s, size + 1 - s]);
    }
    // first-round slots (field index or null = bye) from each team's .seed, standard bracket
    function seedSlots(field) {
        let size = 1; while (size < field.length) size *= 2;
        const at = new Map(field.map((t, i) => [t.seed, i]));
        return seedOrder(size).map(s => at.get(s) ?? null);
    }
    // Frozen seeding: once `seededAt` has passed, /tournaments/<id> carries the qualified field with its captured seeds
    // (snapshots[].seed, ordered by seedingRating) and a bracket preview (bracket[]: code w<round>-<pos>, sides a/b
    // {teamId, seed} or null = bye, winnerTo/winnerSide links). Slots are read off the upper bracket from its final
    // down the winnerTo links, so the platform's own pairings are used; null if seeding isn't frozen yet.
    const predTourP = new Map();
    const predTournament = id => {
        if (!predTourP.has(id)) predTourP.set(id, api(`/tournaments/${id}`).catch(e => { predTourP.delete(id); throw e; }));
        return predTourP.get(id);
    };
    function frozenSeeding(d, ladderRows) {
        const t = d?.tournament;
        if (!t?.seededAt || Date.parse(t.seededAt) > Date.now()) return null;
        const snaps = (d.snapshots || []).filter(s => s.qualified !== false && s.seed != null);
        if (!snaps.length) return null;
        const live = new Map(ladderRows.map(r => [r.id, r]));
        const field = snaps.sort((a, b) => a.seed - b.seed).map(s => { const l = live.get(s.teamId);
            // frozen: the ratings captured with the seeds, not the live ladder (owner, 11-03)
            return { id: s.teamId, name: l?.name ?? s.teamName, category: s.category, rating: s.seedingRating ?? s.rating ?? l?.rating ?? s.liveRating, rank: l?.rank ?? s.liveRank, seed: s.seed }; });
        const at = new Map(field.map((f, i) => [f.id, i]));
        const ub = (d.bracket || []).filter(m => m.bracket === 'upper'), codes = new Set(ub.map(m => m.code));
        const feed = new Map(); // match code -> { a: feeder match, b: feeder match }
        for (const m of ub) if (codes.has(m.winnerTo)) { const f = feed.get(m.winnerTo) || {}; f[m.winnerSide] = m; feed.set(m.winnerTo, f); }
        const top = ub.filter(m => !codes.has(m.winnerTo)); // upper final (its winner leaves the upper bracket)
        const leaves = m => ['a', 'b'].flatMap(s => feed.get(m.code)?.[s] ? leaves(feed.get(m.code)[s]) : [m[s] ? at.get(m[s].teamId) ?? -1 : null]);
        let slots = top.length === 1 ? leaves(top[0]) : [], fromBracket = true;
        const used = slots.filter(x => x != null);
        // our solvers need a full power-of-two tree holding every seeded team once; otherwise rebuild from the seeds
        if (slots.length < field.length || slots.length & (slots.length - 1) || used.includes(-1) || new Set(used).size !== field.length) { slots = seedSlots(field); fromBracket = false; }
        return { name: t.name, at: t.seededAt, format: t.elimination === 'double' ? 'double' : 'single', field, slots, fromBracket };
    }
    function seriesP(p, games) { // P(win a majority of `games`)
        const need = Math.floor(games / 2) + 1;
        let tot = 0, c = 1;
        for (let k = 0; k <= games; k++) { if (k >= need) tot += c * p ** k * (1 - p) ** (games - k); c = c * (games - k) / (k + 1); }
        return tot;
    }
    // Which of our bot versions the predictor's head-to-head uses: the chosen one, else the active bot.
    const predVersion = () => { const v = settings.predVer; return v != null && v !== '' && stats.recs.some(r => r.ver === +v) ? +v : stats.main; };
    function predictPairs(field, games, mineId) {
        // our games: only the selected (default: active) bot, recent, map-normalized, same numbers as the ladder "vs" column
        const ver = predVersion();
        const h2h = mineId ? groupBy(stats.recs.filter(r => r.ver === ver && Date.now() - r.t < H2H_WINDOW), r => [r.opp]) : new Map();
        const pcache = new Map();
        const pBeat = (a, b) => {
            const key = a * 4096 + b;
            let v = pcache.get(key);
            if (v != null) return v;
            const A = field[a], B = field[b];
            let p = 1 / (1 + 10 ** ((B.rating - A.rating) / 400));
            const vs = A.id === mineId ? h2h.get(B.id) : B.id === mineId ? h2h.get(A.id) : null;
            if (vs?.length) { // our real results dominate: the Elo guess only counts as US_PRIOR_GAMES games
                const pm = A.id === mineId ? p : 1 - p, d = mapNormWR(vs).wr;
                const post = (US_PRIOR_GAMES * pm + vs.length * d) / (US_PRIOR_GAMES + vs.length); p = A.id === mineId ? post : 1 - post; }
            v = seriesP(p, games);
            pcache.set(key, v); pcache.set(b * 4096 + a, 1 - v);
            return v;
        };
        return pBeat;
    }
    // Double elimination (UK / International): sampled, since a team's path depends on who else has lost.
    // Upper bracket as in single elim; losers bracket alternates "drop-in" rounds (survivors vs the newest upper-
    // bracket losers, in reversed order to dodge rematches) and plain rounds; grand final with no reset.
    // place = 1 + teams still alive after the round a team went out in (so top4 = place <= 4).
    function simulateDE(field, games, mineId, sims, onDone, slots = seedSlots(field)) {
        const n = field.length, size = slots.length;
        const P2 = predictPairs(field, games, mineId);
        const place = field.map(() => new Float64Array(6)); // [win, 2nd, top4, top8, top16, sum place]
        const elimBy = field.map(() => new Map());
        const ubCols = {}; // ubCols[k][slot] = Map(team -> count) once k upper-bracket slots are left
        const lbCols = []; // lbCols[r] = { len, drop, slots: [Map(team -> count)] }: lower-bracket round r's winners (r counts from the first)
        const gf = [new Map(), new Map()]; // grand final: upper-bracket winner, lower-bracket winner
        // every match of the late rounds, both brackets: ubM[u][i] / lbM[r].pairs[i] = [Map(team -> count) per side]
        const ubM = [], lbM = [];
        const tally = (m, t) => { if (t != null) m.set(t, (m.get(t) || 0) + 1); };
        const noteM = (slot, pairs) => pairs.forEach(([a, b], i) => { const c = slot[i] ??= [new Map(), new Map()]; tally(c[0], a); tally(c[1], b); });
        const noteLb = (r, lb, drop) => { if (lb.length > 32) return; const c = lbCols[r] ??= { len: lb.length, drop, slots: lb.map(() => new Map()) };
            lb.forEach((t, k) => { if (t != null) c.slots[k].set(t, (c.slots[k].get(t) || 0) + 1); }); };
        let done = 0;
        const play = (a, b) => a == null ? b : b == null ? a : (Math.random() < P2(a, b) ? a : b);
        // Per-run log of every tracked match (late rounds, both brackets, grand final) in play order: [a, b, winner] as
        // field index + 1 (0 = bye). The most common bracket is read off this by descending the run tree (mostCommon).
        const keys = []; let K = -1, log = null, k = 0;
        const rec = (key, a, b, w) => { if (K < 0) keys.push(key); else { const o = (done * K + k) * 3; log[o] = (a ?? -1) + 1; log[o + 1] = (b ?? -1) + 1; log[o + 2] = (w ?? -1) + 1; } k++; };
        function one() {
            let alive = n; k = 0;
            const out = (loser, by, after) => { const pl = after + 1; const p = place[loser];
                if (pl <= 2) p[1]++; if (pl <= 4) p[2]++; if (pl <= 8) p[3]++; if (pl <= 16) p[4]++; p[5] += pl;
                elimBy[loser].set(by, (elimBy[loser].get(by) || 0) + 1); };
            let ub = slots.slice(), lb = null, dropFlip = false, lr = 0, ur = 0;
            while (ub.length > 1) {
                const nu = [], losers = [];
                const trackU = ub.length <= 64;
                if (trackU) { const pr = []; for (let i = 0; i < ub.length; i += 2) pr.push([ub[i], ub[i + 1]]); noteM(ubM[ur] ??= [], pr); }
                for (let i = 0; i < ub.length; i += 2) { const w = play(ub[i], ub[i + 1]); nu.push(w); losers.push(w == null ? null : w === ub[i] ? ub[i + 1] : ub[i]);
                    if (trackU) rec(`u${ur}:${i / 2}`, ub[i], ub[i + 1], w); }
                ur++;
                ub = nu;
                if (ub.length <= 64) { const c = ubCols[ub.length] ??= ub.map(() => new Map()); ub.forEach((t, k) => { if (t != null) c[k].set(t, (c[k].get(t) || 0) + 1); }); }
                if (lb == null) lb = losers; // first round's losers seed the losers bracket
                else { // drop-in round
                    const drops = dropFlip ? losers.slice().reverse() : losers; dropFlip = !dropFlip;
                    const nl = [], elim = [];
                    if (lb.length <= 32) { lbM[lr] ??= { drop: true, pairs: [] }; noteM(lbM[lr].pairs, lb.map((a, i) => [a, drops[i]])); }
                    for (let i = 0; i < lb.length; i++) { const a = lb[i], b = drops[i], w = play(a, b); nl.push(w); if (a != null && b != null) elim.push([w === a ? b : a, w]);
                        if (lb.length <= 32) rec(`l${lr}:${i}`, a, b, w); }
                    alive -= elim.length; for (const [l, w] of elim) out(l, w, alive);
                    lb = nl; noteLb(lr++, lb, true);
                }
                while (lb.length > Math.max(1, ub.length / 2)) { // plain rounds until it matches the next batch of drop-ins
                    const nl = [], elim = [];
                    if (lb.length <= 64) { const pr = []; for (let i = 0; i < lb.length; i += 2) pr.push([lb[i], lb[i + 1]]); lbM[lr] ??= { drop: false, pairs: [] }; noteM(lbM[lr].pairs, pr); }
                    for (let i = 0; i < lb.length; i += 2) { const a = lb[i], b = lb[i + 1], w = play(a, b); nl.push(w); if (a != null && b != null) elim.push([w === a ? b : a, w]);
                        if (lb.length <= 64) rec(`l${lr}:${i / 2}`, a, b, w); }
                    alive -= elim.length; for (const [l, w] of elim) out(l, w, alive);
                    lb = nl; noteLb(lr++, lb, false);
                }
            }
            // losers final already folded in: lb[0] met the upper-bracket finalist's loser in the last drop-in round
            const champ = ub[0], chall = lb[0];
            if (champ != null) gf[0].set(champ, (gf[0].get(champ) || 0) + 1);
            if (chall != null) gf[1].set(chall, (gf[1].get(chall) || 0) + 1);
            const w = play(champ, chall);
            rec('gf', champ, chall, w);
            if (K < 0) { K = keys.length; log = new Int16Array(sims * K * 3); }
            if (champ != null && chall != null) { const l = w === champ ? chall : champ; alive--; out(l, w, alive); }
            if (w != null) { place[w][0]++; place[w][1]++; place[w][2]++; place[w][3]++; place[w][4]++; place[w][5] += 1; }
        }
        function chunk() {
            const t = performance.now();
            while (done < sims && performance.now() - t < 30) { one(); done++; }
            onDone({ n, size, done, sims, place, elimBy, ubCols, lbCols, gf, ubM, lbM, keys, K, log, logFrom: 1 });
            if (done < sims) setTimeout(chunk, 0);
        }
        chunk();
    }

    function predict(field, games, mineId, slots = seedSlots(field)) { // slots: first-round field index per slot, null = bye
        const n = field.length, size = slots.length;
        const pBeat = predictPairs(field, games, mineId);
        const rounds = Math.log2(size);
        // reach[i][r] = P(team i wins its round-r match) (r = 0..rounds-1); lossTo[i][r] = Map(opponent -> P(lose to them in r))
        const reach = field.map(() => new Float64Array(rounds));
        const lossTo = field.map(() => Array.from({ length: rounds }, () => new Map()));
        const cols = {}; // cols[k] = the k slots left after a round: Map(team -> P(team holds the slot))
        let blocks = slots.map(i => i != null ? new Map([[i, 1]]) : new Map());
        for (let r = 0; r < rounds; r++) {
            const next = [];
            for (let i = 0; i < blocks.length; i += 2) {
                const A = blocks[i], B = blocks[i + 1], out = new Map();
                const side = (X, Y) => {
                    for (const [a, pa] of X) {
                        if (!Y.size) { out.set(a, pa); reach[a][r] += pa; continue; }
                        let w = 0;
                        for (const [b, pb] of Y) {
                            const q = pBeat(a, b);
                            w += pb * q;
                            const lm = lossTo[a][r]; lm.set(b, (lm.get(b) || 0) + pa * pb * (1 - q));
                        }
                        out.set(a, pa * w); reach[a][r] += pa * w;
                    }
                };
                side(A, B); side(B, A);
                next.push(out);
            }
            blocks = next;
            if (blocks.length <= 64) cols[blocks.length] = blocks;
        }
        return { n, size, rounds, reach, lossTo, pBeat, cols };
    }
    const roundName = (size, r) => { const left = size >> r; return left === 2 ? 'Final' : left === 4 ? 'Semis' : left === 8 ? 'Quarters' : 'Ro' + left; };

    async function mountPredictor(key) {
        const main = document.querySelector('main');
        if (!main) return false;
        const root = h('div', { class: 'cbc-root cbc-pred', 'data-cbc': key });
        mounted = { key, destroy() { root.remove(); main.classList.remove('cbc-pred-main'); } };
        main.classList.add('cbc-pred-main');
        main.append(root);
        sampleTheme(root);
        const mine = await me();
        const me_id = mine.teamId;
        loadStats();
        const tabs = h('span', { class: 'cbc-ranges' });
        let subLine, runId = 0;
        const gamesSel = h('select', { class: 'cbc-sel', title: 'games per series' }, [5, 7, 9, 15, 21].map(g => { const o = h('option', { value: g }, 'bo' + g); if ((settings.predGames || 15) == g) o.selected = true; return o; }));
        // series length per format: sprints (single elim) bo15, qualifiers / finals (double elim) bo21, each saved on its own
        let curFormat = 'single';
        const gamesKey = () => curFormat === 'double' ? 'predGamesDE' : 'predGames';
        const gamesFor = fmt => settings[fmt === 'double' ? 'predGamesDE' : 'predGames'] || (fmt === 'double' ? 21 : 15);
        gamesSel.onchange = () => { settings[gamesKey()] = +gamesSel.value; save(); paint(); };
        // our bot version for the head-to-head part of the odds (versions with games in the last 7 days)
        const verSel = h('select', { class: 'cbc-sel', title: 'which of our bot versions the head-to-head odds use' });
        verSel.onchange = () => { settings.predVer = verSel.value; save(); paint(); };
        let verKey = '';
        const fillVersions = () => {
            const n = {}; for (const r of stats.recs) if (r.ver >= 0 && Date.now() - r.t < H2H_WINDOW) n[r.ver] = (n[r.ver] || 0) + 1;
            const vs = Object.keys(n).map(Number).sort((a, b) => b - a);
            const key = vs.map(v => v + ':' + n[v]).join(',') + '|' + stats.main + '|' + (settings.predVer ?? '');
            if (key === verKey) return; verKey = key;
            verSel.replaceChildren(h('option', { value: '' }, stats.main >= 0 ? `active bot (v${stats.main})` : 'active bot'),
                ...vs.map(v => h('option', { value: String(v) }, `v${v} · ${n[v]} games`)));
            verSel.value = settings.predVer != null && vs.includes(+settings.predVer) ? String(settings.predVer) : '';
        };
        const body = h('div', {}, h('div', { class: 'cbc-empty' }, 'Loading ladder…'));
        root.append(h('div', { class: 'cbc-head' },
            h('div', {}, h('div', { class: 'cbc-titleline' }, h('h1', {}, 'Tournament predictor')),
                subLine = h('div', { class: 'cbc-sub' }, '')),
            h('div', { class: 'cbc-actions' }, tabs, verSel, gamesSel)), body);
        for (const [k, f] of Object.entries(PRED_FIELDS)) tabs.append(h('button', { class: 'cbc-toggle', 'data-k': k,
            onclick: () => { sessionStorage.setItem(LS + 'predField', k); paint(); } }, f.label));
        // default tab = the next scheduled tournament's field
        let upcoming = null;
        try {
            const ts = (await api('/tournaments')).tournaments || [];
            upcoming = ts.filter(t => t.status !== 'complete').sort((a, b) => Date.parse(a.qualificationAt || a.seedingEndsAt) - Date.parse(b.qualificationAt || b.seedingEndsAt))[0] || null;
        } catch { }
        const upcomingKey = !upcoming ? 'sprint' : upcoming.kind === 'sprint' || upcoming.eligibility === 'sprint' ? 'sprint'
            : (upcoming.eligibilityGroups || []).length === 1 && PRED_FIELDS[upcoming.eligibilityGroups[0]] ? upcoming.eligibilityGroups[0] : 'finals';
        // the upcoming tournament's own series length is the default (qualifiers are bo21)
        let ladderRows = null;
        try { ladderRows = await predLadder(); } catch (e) { body.replaceChildren(h('div', { class: 'cbc-empty' }, 'Could not load the ladder (' + e.message + ')')); return true; }
        // the upcoming tournament's real seeds, once frozen (only for its own tab; others stay ladder-seeded)
        let frozen = null;
        if (upcoming?.seededAt && Date.parse(upcoming.seededAt) <= Date.now())
            try { frozen = frozenSeeding(await predTournament(upcoming.id), ladderRows); } catch { }
        if (mounted?.key !== key) return true;
        // field + first-round slots for a tab: frozen tournament seeding, or the eligible ladder in rating order
        // qualifiers and finals are double elimination: the upcoming one's own format wins over the tab's default
        const formatFor = fk => (upcoming && fk === upcomingKey && upcoming.elimination) || (upcoming && fk === upcomingKey && upcoming.kind !== 'sprint' ? 'double' : PRED_FIELDS[fk].format);
        const fieldFor = fk => frozen && fk === upcomingKey ? { ...frozen, format: formatFor(fk) } : { field: ladderRows.filter(t => !t.dev && t.hasBot && PRED_FIELDS[fk].test(t))
            .sort((a, b) => b.rating - a.rating).map((t, i) => ({ ...t, seed: i + 1 })), format: formatFor(fk) };
        const seedNote = F => F.slots ? `frozen tournament seeding (${F.fromBracket ? 'platform bracket' : 'seeds'}, captured ${new Date(F.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`
            : 'current ladder seeding · dev teams excluded';
        const pctS = x => x === 0 ? '–' : x >= 0.995 ? '>99%' : x > 0 && x < 0.001 ? '<0.1%' : x < 0.1 ? (x * 100).toFixed(1) + '%' : Math.round(x * 100) + '%';
        const cell = x => h('td', { class: 'p', style: `color:${x > 0.004 ? wrColor(Math.min(1, 0.3 + x * 0.7)) : 'var(--cbc-muted)'}` }, pctS(x));
        function paint() {
            if (!ladderRows) return;
            fillVersions();
            const fk = sessionStorage.getItem(LS + 'predField') || upcomingKey;
            curFormat = fieldFor(fk).format === 'double' ? 'double' : 'single';
            const games = gamesFor(curFormat); gamesSel.value = String(games);
            for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.k === fk));
            const F = fieldFor(fk), field = F.field;
            if (F.format === 'double') return paintDouble(fk, games, F);
            runId++;
            subLine.textContent = `${upcoming && upcomingKey === fk ? upcoming.name + ' · ' : ''}${seedNote(F)} · single elimination · exact solve`;
            const t0 = performance.now();
            const P = predict(field, games, mine.teamId, F.slots);
            const ms = Math.round(performance.now() - t0);
            const R = P.rounds, champ = i => P.reach[i][R - 1];
            const idx = field.findIndex(t => t.id === mine.teamId);
            const out = [];
            out.push(h('div', { class: 'cbc-sub', style: 'margin:8px 0 10px' },
                `${P.n} teams · ${P.size}-slot bracket · ${P.size - P.n} byes · bo${games} · ${F.slots ? 'qualified field as frozen by the platform' : `excluded: ${ladderRows.filter(t => t.dev).length} dev, ${ladderRows.filter(t => !t.dev && t.category === 'pending').length} eligibility-pending, ${ladderRows.filter(t => !t.dev && !t.hasBot).length} without a bot`} · solved in ${ms} ms`));
            const grid = h('div', { class: 'cbc-predgrid' });
            out.push(grid);
            // --- our run
            if (idx >= 0) {
                const me_ = field[idx], rr = P.reach[idx];
                const exp = rr.reduce((s, x) => s + x, 0);
                let deepest = 0; for (let r = 0; r < R; r++) if (rr[r] >= 0.5) deepest = r + 1;
                const rows = [];
                for (let r = 0; r < R; r++) {
                    const alive = r ? rr[r - 1] : 1;
                    if (alive < 1e-4) break;
                    const opps = [...P.lossTo[idx][r]].sort((a, b) => b[1] - a[1]).slice(0, 2);
                    const bye = P.lossTo[idx][r].size === 0 && Math.abs(rr[r] - alive) < 1e-9;
                    rows.push(h('tr', {}, h('td', {}, roundName(P.size, r)), cell(rr[r]),
                        h('td', { class: 'opp' }, bye ? h('span', { class: 'mut' }, 'bye') : opps.map(([o, p]) =>
                            h('span', { title: `P(lose to them here) ${pctS(p)}` }, link(`/game/team/${field[o].id}`, '', `#${field[o].seed} ${field[o].name}`), h('small', {}, ' ' + pctS(p / Math.max(alive, 1e-12)) + ' '))))));
                }
                grid.append(h('div', { class: 'cbc-card' }, h('h3', {}, `${me_.name} · seed #${me_.seed}`),
                    h('div', { class: 'cbc-shead' },
                        h('div', {}, h('div', { class: 'big', style: `color:${wrColor(Math.min(1, 0.3 + champ(idx) * 1.5))}` }, pctS(champ(idx))), h('small', {}, 'win it all')),
                        h('div', {}, h('div', { class: 'mid' }, pctS(rr[R - 2] ?? 0)), h('small', {}, 'make final')),
                        h('div', {}, h('div', { class: 'mid' }, pctS(rr[R - 3] ?? 0)), h('small', {}, 'top 4')),
                        h('div', {}, h('div', { class: 'mid' }, exp.toFixed(1)), h('small', {}, 'exp. wins')),
                        h('div', {}, h('div', { class: 'mid' }, deepest >= R ? 'Champion' : roundName(P.size, deepest)), h('small', {}, 'likely exit'))),
                    h('table', { class: 'cbc-ptab path' }, h('thead', {}, h('tr', {}, h('th', {}, 'round'), h('th', {}, 'win it'), h('th', {}, 'most likely to knock us out (if we get there)'))), h('tbody', {}, rows))));
            } else grid.append(h('div', { class: 'cbc-card cbc-empty' }, mine.teamId ? 'Your team isn\'t in this field.' : 'Sign in to see your own run.'));
            // --- favourites
            const fav = field.map((t, i) => i).sort((a, b) => champ(b) - champ(a) || a - b).slice(0, 64);
            const ks = [5, 4, 3, 2].filter(k => R - k >= 0); // made Ro16 / quarters / semis / final
            grid.append(h('div', { class: 'cbc-card fill' }, h('div', { class: 'in' }, h('h3', {}, 'Title odds'),
                h('table', { class: 'cbc-ptab' }, h('thead', {}, h('tr', {}, h('th', {}, 'seed'), h('th', {}, 'team'), h('th', {}, 'elo'),
                    ...ks.map(k => h('th', {}, roundName(P.size, R - k + 1).toLowerCase())), h('th', {}, 'win'))),
                    h('tbody', {}, fav.map(i => h('tr', { class: field[i].id === mine.teamId ? 'me' : '' },
                        h('td', { class: 'mut' }, '#' + field[i].seed), h('td', {}, link(`/game/team/${field[i].id}`, '', field[i].name)), h('td', { class: 'mut' }, fmt(field[i].rating)),
                        ...ks.map(k => cell(P.reach[i][R - k])), cell(champ(i)))))))));
            // --- the bracket from the chosen round on
            const from = Math.min(settings.predFrom || 32, P.size);
            const colsSE = [];
            for (let k = from; k >= 1; k /= 2) colsSE.push((P.cols[k] || []).map(m => [...m].sort((a, b) => b[1] - a[1])));
            out.push(bracketCard(`Bracket · ${roundName(P.size, P.rounds - Math.log2(from))} onwards`, colsSE, field, from, P.size, P.pBeat));
            body.replaceChildren(...out);
        }
        function paintDouble(fk, games, F) {
            const field = F.field;
            const my = ++runId, SIMS = 20000;
            subLine.textContent = `${upcoming && upcomingKey === fk ? upcoming.name + ' · ' : ''}${seedNote(F)} · double elimination (no reset) · ${SIMS.toLocaleString()} simulations`;
            const idx = field.findIndex(t => t.id === mine.teamId);
            simulateDE(field, games, mine.teamId, SIMS, R => {
                if (my !== runId || mounted?.key !== key) return;
                const fr = i => R.place[i].map(x => x / R.done);
                const out = [h('div', { class: 'cbc-sub', style: 'margin:8px 0 10px' },
                    `${R.n} teams · ${R.size}-slot bracket · ${R.size - R.n} byes · bo${games} · ${R.done < R.sims ? `simulating ${R.done.toLocaleString()}/${R.sims.toLocaleString()}…` : `${R.sims.toLocaleString()} runs`}`)];
                const grid = h('div', { class: 'cbc-predgrid' }); out.push(grid);
                if (idx >= 0) {
                    const f = fr(idx), by = [...R.elimBy[idx]].sort((a, b) => b[1] - a[1]).slice(0, 5);
                    grid.append(h('div', { class: 'cbc-card' }, h('h3', {}, `${field[idx].name} · seed #${field[idx].seed}`),
                        h('div', { class: 'cbc-shead' },
                            h('div', {}, h('div', { class: 'big', style: `color:${wrColor(Math.min(1, 0.3 + f[0] * 1.5))}` }, pctS(f[0])), h('small', {}, 'win it all')),
                            h('div', {}, h('div', { class: 'mid' }, pctS(f[1])), h('small', {}, 'top 2')),
                            h('div', {}, h('div', { class: 'mid' }, pctS(f[2])), h('small', {}, 'top 4')),
                            h('div', {}, h('div', { class: 'mid' }, pctS(f[3])), h('small', {}, 'top 8')),
                            h('div', {}, h('div', { class: 'mid' }, f[5].toFixed(1)), h('small', {}, 'avg place'))),
                        h('table', { class: 'cbc-ptab path' }, h('thead', {}, h('tr', {}, h('th', {}, 'who knocks us out'), h('th', {}, 'how often'), h('th', {}, ''))),
                            h('tbody', {}, by.map(([o, c]) => h('tr', {}, h('td', {}, link(`/game/team/${field[o].id}`, '', `#${field[o].seed} ${field[o].name}`)), cell(c / R.done), h('td', {}, '')))))));
                } else grid.append(h('div', { class: 'cbc-card cbc-empty' }, mine.teamId ? 'Your team isn\'t in this field.' : 'Sign in to see your own run.'));
                const fav = field.map((t, i) => i).sort((a, b) => R.place[b][0] - R.place[a][0] || R.place[b][2] - R.place[a][2] || a - b).slice(0, 64);
                grid.append(h('div', { class: 'cbc-card fill' }, h('div', { class: 'in' }, h('h3', {}, 'Title odds'),
                    h('table', { class: 'cbc-ptab' }, h('thead', {}, h('tr', {}, h('th', {}, 'seed'), h('th', {}, 'team'), h('th', {}, 'elo'), h('th', {}, 'top 16'), h('th', {}, 'top 8'), h('th', {}, 'top 4'), h('th', {}, 'top 2'), h('th', {}, 'win'))),
                        h('tbody', {}, fav.map(i => { const f = fr(i); return h('tr', { class: field[i].id === mine.teamId ? 'me' : '' },
                            h('td', { class: 'mut' }, '#' + field[i].seed), h('td', {}, link(`/game/team/${field[i].id}`, '', field[i].name)), h('td', { class: 'mut' }, fmt(field[i].rating)),
                            cell(f[4]), cell(f[3]), cell(f[2]), cell(f[1]), cell(f[0])); }))))));
                const from = Math.min(settings.predFrom || 32, R.size), colsDE = [];
                for (let k = from; k >= 1; k /= 2) colsDE.push((R.ubCols[k] || []).map(m => [...m].map(([t, c]) => [t, c / R.done]).sort((a, b) => b[1] - a[1])));
                const pB = predictPairs(field, games, mine.teamId);
                out.push(deBracket(R, field, from, games, pB));
                body.replaceChildren(...out);
            }, F.slots);
        }
        // Florent-style double elimination: both brackets on one zoomable canvas, columns are rounds in play order
        // (upper round, then the lower bracket's plain round beside the next upper round and its drop-in round after),
        // then the grand final. Each match: the most likely team on each side (chance they get there; hover for who
        // else), the favourite highlighted by the chance to win if it's these two.
        // The most common bracket: every match's two teams come from the runs (where each side came from is read off
        // the run log: a slot fed by an earlier tracked match takes that match's winner or loser; a slot fed from
        // outside the shown rounds takes its most frequent team), and each match goes to the side with the better
        // bo-N series chance, so the whole bracket is one consistent path.
        let mcCache = null, mcSrc = null;
        function mostCommon(R, pBeat) {
            if (!R.log || R.K <= 0 || R.done - R.logFrom < 50) return null;
            if (mcCache && mcCache.R === R.log && (mcCache.done === R.done || (R.done < R.sims && R.done - mcCache.done < 2500))) return mcCache.best;
            const K = R.K, L = R.log, r0 = R.logFrom, r1 = R.done, probe = Math.min(r1, r0 + 400);
            const at = (r, j, x) => L[(r * K + j) * 3 + x] - 1;
            // source of each side: [j', 0 = its winner | 1 = its loser], or null; worked out once per run log
            const full = probe - r0 >= 400;
            let src = full && mcSrc?.log === L ? mcSrc.src : null;
            if (!src) { src = [];
            for (let j = 0; j < K; j++) {
                src[j] = [0, 1].map(side => {
                    let found = null, bestHit = 0;
                    for (let q = j - 1; q >= 0 && !found; q--) for (const kind of [0, 1]) {
                        let hit = 0, tot = 0;
                        for (let r = r0; r < probe; r++) { const v = at(r, j, side); if (v < 0) continue; tot++;
                            const w = at(r, q, 2), lo = at(r, q, 0) === w ? at(r, q, 1) : at(r, q, 0);
                            if ((kind === 0 ? w : lo) === v) hit++; }
                        if (tot > 20 && hit >= 0.98 * tot && hit > bestHit) { bestHit = hit; found = [q, kind]; }
                    }
                    return found;
                });
            }
            if (full) mcSrc = { log: L, src }; }
            const mode = (j, side) => { const c = new Map(); for (let r = r0; r < r1; r++) { const v = at(r, j, side); c.set(v, (c.get(v) || 0) + 1); }
                let b = -1, n = -1; for (const [v, k] of c) if (k > n) { n = k; b = v; } return b; };
            const best = new Map(), pick = [];
            for (let j = 0; j < K; j++) {
                const side = s => { const f = src[j][s]; if (!f) return mode(j, s); const m = pick[f[0]]; return f[1] === 0 ? m.w : (m.w === m.a ? m.b : m.a); };
                const a = side(0), b = side(1);
                const w = a < 0 ? b : b < 0 ? a : pBeat(a, b) >= 0.5 ? a : b;
                pick[j] = { a, b, w };
                best.set(R.keys[j], pick[j]);
            }
            mcCache = { R: R.log, done: R.done, p: pBeat, best };
            return best;
        }
        function deBracket(R, field, from, games, pBeat) {
            const W = 148, MH = 34, GAP = 5, CW = 166, TOP = 20;
            const top = m => [...m].map(([t, c]) => [t, c / R.done]).sort((a, b) => b[1] - a[1]);
            const name = i => field[i] ? `#${field[i].seed} ${field[i].name}` : '?';
            const U = Math.log2(R.size); // upper rounds 0..U-1; round u has size >> (u + 1) matches
            const u0 = Math.max(0, U - Math.log2(from));
            const lbRounds = (R.lbM || []).map((x, r) => x && { ...x, r }).filter(x => x && x.pairs.length <= Math.max(1, from / 4));
            // play-order column of each round: upper u -> 2u; lower plain r=2k -> 2k+2; lower drop-in r=2k-1 -> 2k+1
            const colOfU = u => 2 * u, colOfL = r => r + 2;
            const ubRounds = []; for (let u = u0; u < U; u++) if (R.ubM?.[u]) ubRounds.push({ u, pairs: R.ubM[u] });
            const cols = [...new Set([...ubRounds.map(x => colOfU(x.u)), ...lbRounds.map(x => colOfL(x.r))])].sort((a, b) => a - b);
            const X = c => cols.indexOf(c) * CW;
            const gfX = cols.length * CW;
            // vertical layout: upper bracket on top, lower bracket below it
            const pos = new Map(); // key -> {x, y}
            const M0 = ubRounds[0]?.pairs.length || 1, unit = MH + GAP;
            ubRounds.forEach(({ u, pairs }, k) => pairs.forEach((_, i) => pos.set(`u${u}:${i}`, { x: X(colOfU(u)), y: TOP + 18 + unit * ((2 ** k) * i + ((2 ** k) - 1) / 2) })));
            const ubH = TOP + 18 + unit * M0;
            const lbTop = ubH + 34;
            let prev = null;
            lbRounds.forEach(({ r, pairs, drop }) => {
                pairs.forEach((_, i) => {
                    let y;
                    if (!prev) y = lbTop + 18 + unit * i;
                    else if (prev.pairs.length === pairs.length) y = pos.get(`l${prev.r}:${i}`)?.y ?? lbTop + 18 + unit * i;
                    else { const a = pos.get(`l${prev.r}:${2 * i}`), b = pos.get(`l${prev.r}:${2 * i + 1}`); y = a && b ? (a.y + b.y) / 2 : (a || b)?.y ?? lbTop + 18 + unit * i; }
                    pos.set(`l${r}:${i}`, { x: X(colOfL(r)), y });
                });
                prev = { r, pairs };
            });
            const lastU = ubRounds.at(-1), lastL = lbRounds.at(-1);
            const uf = lastU && pos.get(`u${lastU.u}:0`), lf = lastL && pos.get(`l${lastL.r}:0`);
            const gfY = uf && lf ? (uf.y + lf.y) / 2 : (uf || lf)?.y ?? TOP;
            let maxY = 0; for (const p of pos.values()) maxY = Math.max(maxY, p.y + MH);
            const cv = h('div', { class: 'cv', style: `width:${gfX + W + 20}px;height:${maxY + 20}px` });
            // round headers
            const label = c => { const i = cols.indexOf(c);
                if (lastU && c === colOfU(lastU.u)) return lastL && colOfL(lastL.r) === c ? 'Finals' : 'UB final';
                if (lastL && c === colOfL(lastL.r)) return 'LB final';
                if (lastU && ubRounds.length > 1 && c === colOfU(ubRounds.at(-2).u)) return 'UB semis';
                return 'R' + (i + 1); };
            const count = c => [...ubRounds.filter(x => colOfU(x.u) === c), ...lbRounds.filter(x => colOfL(x.r) === c)].reduce((a, x) => a + x.pairs.length * 2, 0);
            cols.forEach(c => cv.append(h('div', { class: 'rh', style: `left:${X(c)}px;width:${W}px` }, label(c), h('small', {}, `(${count(c)})`))));
            cv.append(h('div', { class: 'rh', style: `left:${gfX}px;width:${W}px` }, 'GF', h('small', {}, '(2)')));
            cv.append(h('div', { class: 'sec', style: `top:${TOP}px` }, 'Upper bracket'), h('div', { class: 'sec', style: `top:${lbTop}px` }, 'Lower bracket'));
            // matches
            const MC = mostCommon(R, pBeat);
            const mcBox = (key, p, gf) => {
                const m = MC?.get(key);
                if (!m) return null;
                const row = (i, win) => {
                    if (i < 0) return h('div', { class: 't' }, h('span', {}, ''), h('span', { class: 'nm' }, 'bye'), h('b', {}, ''));
                    return h('div', { class: 't' + (win ? ' win' : '') + (field[i].id === mine.teamId ? ' me' : '') },
                        h('span', { class: 'sd' }, '#' + field[i].seed), h('span', { class: 'nm' }, field[i].name), h('b', {}, m.a >= 0 && m.b >= 0 ? pctS(pBeat(i, i === m.a ? m.b : m.a)) : ''));
                };
                return h('div', { class: 'm' + (gf ? ' gf' : ''), style: `left:${p.x}px;top:${p.y}px`,
                    title: m.a >= 0 && m.b >= 0 ? `bo${games} series: ${field[m.a].name} ${pctS(pBeat(m.a, m.b))} · ${field[m.b].name} ${pctS(pBeat(m.b, m.a))}` : '' }, row(m.a, m.w === m.a), row(m.b, m.w === m.b));
            };
            const box = (pair, p, gf, key) => {
                const mc = key && mcBox(key, p, gf);
                if (mc) return mc;
                const A = top(pair[0]), B = top(pair[1]);
                const a = A[0]?.[0], b = B[0]?.[0];
                const pa = a != null && b != null ? pBeat(a, b) : a != null ? 1 : 0;
                const row = (occ, win) => { const [i, pr] = occ[0] || [];
                    if (i == null) return h('div', { class: 't' }, h('span', {}, ''), h('span', { class: 'nm' }, 'bye'), h('b', {}, ''));
                    return h('div', { class: 't' + (win ? ' win' : '') + (field[i].id === mine.teamId ? ' me' : ''), title: occ.slice(0, 6).map(([t, c]) => `${name(t)} ${pctS(c)} to get here`).join('\n') },
                        h('span', { class: 'sd' }, '#' + field[i].seed), h('span', { class: 'nm' }, field[i].name), h('b', {}, pctS(pr))); };
                return h('div', { class: 'm' + (gf ? ' gf' : ''), style: `left:${p.x}px;top:${p.y}px`, title: a != null && b != null ? `if it's these two: ${field[a].name} ${pctS(pa)}` : '' },
                    row(A, pa >= 0.5), row(B, pa < 0.5));
            };
            const lines = [];
            const link = (p, q) => { if (!p || !q) return; const x1 = p.x + W, y1 = p.y + MH / 2, x2 = q.x, y2 = q.y + MH / 2, mx = (x1 + x2) / 2;
                lines.push(`M${x1},${y1}H${mx}V${y2}H${x2}`); };
            ubRounds.forEach(({ u, pairs }, k) => pairs.forEach((pr, i) => { const p = pos.get(`u${u}:${i}`); cv.append(box(pr, p, false, `u${u}:${i}`));
                if (k + 1 < ubRounds.length) link(p, pos.get(`u${ubRounds[k + 1].u}:${i >> 1}`)); }));
            lbRounds.forEach(({ r, pairs }, k) => pairs.forEach((pr, i) => { const p = pos.get(`l${r}:${i}`); cv.append(box(pr, p, false, `l${r}:${i}`));
                const nx = lbRounds[k + 1]; if (nx) link(p, pos.get(`l${nx.r}:${nx.pairs.length === pairs.length ? i : i >> 1}`)); }));
            const gfp = { x: gfX, y: gfY };
            cv.append(box(R.gf || [new Map(), new Map()], gfp, true, 'gf'));
            link(uf, gfp); link(lf, gfp);
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', gfX + W + 20); svg.setAttribute('height', maxY + 20);
            for (const d of lines) { const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pth.setAttribute('d', d); svg.append(pth); }
            cv.prepend(svg);
            // zoom (buttons, ctrl/cmd + wheel) and drag to pan
            const wrap = h('div', { class: 'cbc-de' });
            let z = settings.predZoom || 1;
            const apply = () => { cv.style.transform = `scale(${z})`; cv.parentElement && (holder.style.width = `${(gfX + W + 20) * z}px`, holder.style.height = `${(maxY + 20) * z}px`); };
            const holder = h('div', {}, cv);
            const setZ = v => { z = Math.min(1.6, Math.max(0.3, v)); settings.predZoom = z; save(); apply(); };
            const zm = h('div', { class: 'zm' },
                h('button', { title: 'zoom in', onclick: () => setZ(z * 1.2) }, '+'),
                h('button', { title: 'zoom out', onclick: () => setZ(z / 1.2) }, '−'),
                h('button', { title: 'fit', onclick: () => setZ(Math.min((wrap.clientWidth - 40) / (gfX + W + 20), (wrap.clientHeight - 20) / (maxY + 20))) }, '⤢'));
            wrap.append(zm, holder);
            wrap.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
            let drag = null;
            wrap.addEventListener('mousedown', e => { if (e.target.closest('button,a')) return; drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop }; wrap.classList.add('drag'); });
            addEventListener('mousemove', e => { if (!drag) return; wrap.scrollLeft = drag.l - (e.clientX - drag.x); wrap.scrollTop = drag.t - (e.clientY - drag.y); });
            addEventListener('mouseup', () => { drag = null; wrap.classList.remove('drag'); });
            apply();
            const sel = h('select', { class: 'cbc-sel' }, [64, 32, 16, 8].filter(k => k <= R.size).map(k => { const o = h('option', { value: k }, `from ${roundName(R.size, Math.log2(R.size) - Math.log2(k))}`); if (k === from) o.selected = true; return o; }));
            sel.onchange = () => { settings.predFrom = +sel.value; save(); paint(); };
            const nRounds = cols.length + 1;
            return h('div', { class: 'cbc-card', style: 'margin-top:12px;padding-bottom:0' },
                h('div', { class: 'cbc-listhead' }, h('h3', { style: 'margin:0' }, `Most common bracket · ${nRounds} rounds · double elim bo${games}`), h('span', { class: 'sp' }),
                    h('small', { class: 'mut' }, `most common bracket over ${Math.max(0, R.done - 1).toLocaleString()} simulated tournaments, favourite advances · % = each team's bo${games} series win chance in that matchup · drag to pan, ctrl+scroll to zoom `), sel),
                wrap);
        }
        // Lower bracket: its last rounds (from settings.predLbFrom teams left) as columns of the most likely winner per
        // slot, then the grand final (upper-bracket winner vs lower-bracket winner, no reset).
        function lowerCard(R, field, pBeat) {
            const lbFrom = settings.predLbFrom || 8;
            const sel = h('select', { class: 'cbc-sel' }, [16, 8, 4].map(k => { const o = h('option', { value: k }, `last ${k} teams`); if (k === lbFrom) o.selected = true; return o; }));
            sel.onchange = () => { settings.predLbFrom = +sel.value; save(); paint(); };
            const top = m => [...m].map(([t, c]) => [t, c / R.done]).sort((a, b) => b[1] - a[1]);
            const name = i => field[i] ? `#${field[i].seed} ${field[i].name}` : '?';
            const slot = occ => {
                const [i, pr] = occ[0] || [];
                if (i == null) return h('div', { class: 't mut' }, h('span', {}, '–'));
                return h('div', { class: 't' + (field[i].id === mine.teamId ? ' me' : ''), title: occ.slice(0, 6).map(([t, c]) => `${name(t)} ${pctS(c)}`).join('\n') },
                    h('span', { class: 'sd' }, '#' + field[i].seed), h('span', {}, field[i].name), h('b', {}, pctS(pr)));
            };
            const cols = (R.lbCols || []).map((c, r) => ({ ...c, r })).filter(c => c && c.len <= lbFrom);
            const tree = h('div', { class: 'cbc-tree cbc-lbtree' });
            cols.forEach((c, k) => tree.append(h('div', { class: 'col' }, h('div', { class: 'rh' }, c.len === 1 ? 'lower final' : `${c.drop ? 'drop-in' : 'lower'} · ${c.len} left`),
                ...c.slots.map(m => top(m)).filter(o => o.length).map(o => h('div', { class: 'box' }, slot(o))))));
            const a = top(R.gf[0]), b = top(R.gf[1]);
            const ai = a[0]?.[0], bi = b[0]?.[0];
            const pa = ai != null && bi != null ? pBeat(ai, bi) : null;
            tree.append(h('div', { class: 'col' }, h('div', { class: 'rh' }, 'grand final'),
                h('div', { class: 'box' }, slot(a), slot(b)),
                pa != null ? h('small', { class: 'mut' }, `if it's these two: ${field[ai].name} ${pctS(pa)}`) : null));
            return h('div', { class: 'cbc-card', style: 'margin-top:12px' }, h('div', { class: 'cbc-listhead' }, h('h3', { style: 'margin:0' }, 'Lower bracket and grand final'), h('span', { class: 'sp' }),
                h('small', { class: 'mut' }, 'most likely team per slot · % = chance they get there · hover for who else could be there '), sel), h('div', { class: 'cbc-treewrap' }, tree));
        }
        // Columns of slots, each slot = its most likely team (chance they hold it); hover for the runners-up.
        function bracketCard(title, cols, field, from, size, pBeat) {
            const sel = h('select', { class: 'cbc-sel' }, [64, 32, 16, 8].filter(k => k <= size).map(k => { const o = h('option', { value: k }, roundName(size, Math.log2(size) - Math.log2(k))); if (k === from) o.selected = true; return o; }));
            sel.onchange = () => { settings.predFrom = +sel.value; save(); paint(); };
            // one box per match: both teams (most likely occupant of each slot, with the chance they get there); the one
            // projected to advance (most likely occupant of the next round's slot) is highlighted
            const tree = h('div', { class: 'cbc-tree', style: `--rows:${from / 2}` });
            // % = chance to win this match if it's these two
            const row = (occ, win, opp) => {
                const [i] = occ?.[0] || [], o = opp?.[0]?.[0];
                if (i == null) return h('div', { class: 't mut' }, h('span', { class: 'sd' }, ''), h('span', {}, 'bye'), h('b', {}, ''));
                const q = o == null ? 1 : pBeat(i, o);
                return h('div', { class: 't' + (win ? ' win' : '') + (field[i].id === me_id ? ' me' : ''),
                    title: 'most likely here:\n' + occ.slice(0, 5).map(([j, p]) => `#${field[j].seed} ${field[j].name} ${pctS(p)}`).join('\n') },
                    h('span', { class: 'sd' }, '#' + field[i].seed), link(`/game/team/${field[i].id}`, '', field[i].name), h('b', { style: o == null ? '' : `color:${wrColor(q)}` }, o == null ? 'bye' : pctS(q)));
            };
            const shown = cols.slice(0, -1); // the champion slot is just the final's winner
            shown.forEach((col, ci) => {
                const last = ci === shown.length - 1;
                const c = h('div', { class: 'col' }, h('div', { class: 'rh' }, roundName(size, Math.log2(size) - Math.log2(from >> ci))));
                const slots = h('div', { class: 'slots' });
                const nxt = cols[ci + 1];
                for (let k = 0; k < col.length; k += 2) {
                    const a = col[k], b = col[k + 1], ai = a?.[0]?.[0], bi = b?.[0]?.[0];
                    // highlight whoever wins this pairing more often than not
                    const aw = ai != null && (bi == null || pBeat(ai, bi) >= 0.5);
                    slots.append(h('div', { class: 'mt' + (last ? '' : ((k / 2) % 2 ? ' lo' : ' hi')) },
                        h('div', { class: 'box' }, row(a, aw, b), row(b, bi != null && !aw, a))));
                }
                c.append(slots); tree.append(c);
            });
            return h('div', { class: 'cbc-card', style: 'margin-top:12px' }, h('div', { class: 'cbc-listhead' }, h('h3', { style: 'margin:0' }, title), h('span', { class: 'sp' }), h('small', { class: 'mut' }, 'most likely team per slot · % = chance to win that match · hover for who else could be there '), sel), h('div', { class: 'cbc-treewrap' }, tree));
        }
        paint();
        const onStats = () => { if (!stats.loading) paint(); };
        stats.listeners.add(onStats);
        const d0 = mounted.destroy; mounted.destroy = () => { stats.listeners.delete(onStats); runId++; d0(); };
        return true;
    }
    function predictorNav() {
        const team = [...document.querySelectorAll('nav a.nav-item')].find(a => a.getAttribute('href') === '/game/team');
        if (!team) return;
        let a = document.querySelector('a.cbc-pred-nav');
        if (!a) {
            a = team.cloneNode(false);
            a.classList.add('cbc-pred-nav');
            a.setAttribute('href', '/game/predictor'); a.setAttribute('aria-label', 'Predictor'); a.setAttribute('title', 'Predictor');
            a.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h4v4H3zM3 15h4v4H3zM7 7h3v10H7M10 12h4M14 10h4v4h-4M18 12h3"/></svg><span class="nav-label">Predictor</span>';
            a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); history.pushState({}, '', '/game/predictor'); window.dispatchEvent(new PopStateEvent('popstate')); });
        }
        if (a.nextElementSibling !== team) team.parentElement.insertBefore(a, team);
        const on = location.pathname.replace(/\/$/, '') === '/game/predictor';
        // take the look of an idle nav item (the clone may have carried the active styling); ours is styled in CSS
        const idle = [...team.parentElement.querySelectorAll('a.nav-item')].find(x => x !== a && !x.getAttribute('aria-current'));
        if (idle) { const cls = idle.className.replace(/\bactive\b/g, '').trim() + ' cbc-pred-nav'; if (a.className !== cls) a.className = cls; }
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }

    // ---------------------------------------------------------------- theme
    // Most of the site's green-grey is baked into styled-components rules as literal colours (per theme), not variables.
    // Rewrite those in place: low-saturation greens/teals become neutral greys of the same lightness. Saturated greens
    // (win/positive markers) are left alone.
    const seenRules = new WeakSet();
    function neutralize(v) {
        return v.replace(/#([0-9a-f]{6})\b|#([0-9a-f]{3})\b|rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)/gi, (m, h6, h3, R, G, B, A) => {
            let r, g, b;
            if (h6) [r, g, b] = [0, 2, 4].map(i => parseInt(h6.slice(i, i + 2), 16));
            else if (h3) [r, g, b] = [...h3].map(c => parseInt(c + c, 16));
            else [r, g, b] = [+R, +G, +B];
            const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2, d = mx - mn;
            if (!d) return m;
            const sat = d / (1 - Math.abs(2 * l - 1));
            let hue = mx === r / 255 ? ((g - b) / 255 / d) % 6 : mx === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
            hue = (hue * 60 + 360) % 360;
            if (hue < 75 || hue > 200 || sat > .32) return m;
            const k = Math.round(l * 255), t = Math.min(255, k + 2); // a hair cool, otherwise neutral
            return A != null ? `rgba(${k}, ${k}, ${t}, ${A})` : `rgb(${k}, ${k}, ${t})`;
        });
    }
    const COLOR_PROPS = ['background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
        'outline-color', 'box-shadow', 'color', 'fill', 'stroke', 'text-decoration-color'];
    function retintRules(rules) {
        for (const r of rules) {
            if (r.cssRules && !r.style) { retintRules(r.cssRules); continue; }
            if (!r.style || seenRules.has(r)) continue;
            seenRules.add(r);
            if (r.selectorText?.startsWith('html:root')) continue; // our own variables
            for (const prop of COLOR_PROPS) {
                const v = r.style.getPropertyValue(prop);
                if (!v || !/#|rgb/.test(v)) continue;
                const nv = neutralize(v);
                if (nv !== v) r.style.setProperty(prop, nv, r.style.getPropertyPriority(prop));
            }
            for (const prop of r.style) {
                if (!prop.startsWith('--')) continue;
                const v = r.style.getPropertyValue(prop);
                if (/#|rgb/.test(v) && !/^--(cbc|patch-buff)/.test(prop)) { const nv = neutralize(v); if (nv !== v) r.style.setProperty(prop, nv); }
            }
        }
    }
    const sheetSizes = new WeakMap();
    function retint() {
        for (const sh of document.styleSheets) {
            let rules; try { rules = sh.cssRules; } catch { continue; }
            if (sheetSizes.get(sh) === rules.length) continue;
            sheetSizes.set(sh, rules.length);
            retintRules(rules);
        }
    }

    // ---------------------------------------------------------------- ladder
    // Team names take their rank tier's colour, pushed brighter/more saturated so it reads on both themes.
    function tierInk(hex, dark) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return null;
        let [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
        let hue = 0, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
        if (d) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        hue = Math.round(hue * 60 + 360) % 360;
        if (sat < .08) return dark ? 'hsl(0 0% 88%)' : 'hsl(0 0% 22%)'; // grey tiers stay neutral
        // Grandmaster (#cf4848): a deeper, more vivid red; Master (#e36db6): a bit brighter pink (owner, 11-09)
        if (/^#?(cf4848|e8304a)$/i.test(hex.trim())) return dark ? 'hsl(354 92% 60%)' : 'hsl(354 88% 40%)';
        if (/^#?(e36db6|ee7fd0)$/i.test(hex.trim())) return dark ? 'hsl(323 96% 78%)' : 'hsl(323 90% 45%)';
        if (/^#?3fb4ff$/i.test(hex.trim())) return dark ? 'hsl(203 100% 68%)' : 'hsl(203 95% 38%)'; // Challenger
        return dark ? `hsl(${hue} ${Math.max(78, sat * 100).toFixed(0)}% 70%)` : `hsl(${hue} 95% 38%)`;
    }
    // ---------------------------------------------------------------- quick unranked
    // One click: an unranked match against this team's current bot on 5 random maps (same request the
    // "Play an unranked match" form sends with its defaults), without leaving the page.
    function toast(text, kind) {
        let box = document.getElementById('cbc-toasts');
        if (!box) { box = h('div', { id: 'cbc-toasts' }); document.body.append(box); }
        const t = h('div', { class: 'cbc-toast ' + (kind || '') }, text);
        box.append(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'err' ? 6000 : 3500);
        return t;
    }
    async function quickUnranked(teamId, name, btn, pickMaps) {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.classList.add('busy');
        try {
            const body = { teamId, sides: ['a', 'a', 'a', 'a', 'a'] };
            let mapNote = '5 random maps';
            if (pickMaps) { const m = await pickMaps(); body.mapIds = m.map(x => x.id); mapNote = m.map(x => x.name.replace(/^\d\d/, '')).join(', '); }
            const r = await origFetch('/api/v1/challenges', { method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error || d?.message || `HTTP ${r.status}`);
            let quota = '';
            try { const q = (await api('/challenges')).quota; quota = ` · ${q.used}/${q.limit} this hour`; } catch { }
            toast(h('span', {}, `Unranked vs ${name} queued (${mapNote})${quota} `,
                d?.groupId ? link(`/game/match-groups/${d.groupId}`, '', 'open ↗') : null), 'ok');
            btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1500);
        } catch (e) {
            toast(`Couldn't queue vs ${name}: ${e.message}`, 'err');
        } finally { delete btn.dataset.busy; btn.classList.remove('busy'); }
    }
    // The 5 active maps we have the fewest recent games on against this team (active bot, 7 days); ties shuffled.
    let mapListP = null;
    async function leastDataMaps(teamId) {
        mapListP ??= api('/challenges').then(d => d.maps || []);
        const maps = await mapListP;
        if (maps.length < 5) throw new Error('fewer than 5 active maps');
        const n = {}, last = {};
        for (const r of vsRecs(teamId)) { n[r.map] = (n[r.map] || 0) + 1; last[r.map] = Math.max(last[r.map] || 0, r.t); }
        // fewest games first, then the ones we last played longest ago
        return maps.map(m => ({ ...m, n: n[m.name] || 0, t: last[m.name] || 0, k: Math.random() }))
            .sort((a, b) => a.n - b.n || a.t - b.t || a.k - b.k).slice(0, 5);
    }
    // do we have recent active-bot results against this team on every active map?
    let activeMaps = null;
    function fullMapCoverage(teamId, recs) {
        if (!activeMaps) return false;
        const have = new Set(recs.map(r => r.map));
        return activeMaps.every(m => have.has(m.name));
    }
    const SWORDS = '<path opacity=".7" d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5 21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2"/>';
    const INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + SWORDS + '<circle cx="12" cy="12" r="6.6" fill="var(--cbc-blue)" stroke="var(--cbc-boltedge)" stroke-width="1.1"/>'
        + '<path d="M12 11.3v4" stroke="#fff" stroke-width="2"/><circle cx="12" cy="8.4" r="1.15" fill="#fff" stroke="none"/></svg>';
    // the swords, faded back, with a big filled gold bolt over them: tells apart from the plain button at a glance
    const QUICK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path opacity=".7" d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5 21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2"/>'
        + '<path d="M13.5 1.5 6 13h5l-1.5 9.5L18 10.5h-5.2z" fill="var(--cbc-bolt)" stroke="var(--cbc-boltedge)" stroke-width="1.1"/></svg>';

    // ---------------------------------------------------------------- qualified teams
    // The finals field: the top 8 of each qualifier (International, UK) once it's complete, read off its published
    // bracket (double elimination: placing = how late a team took its elimination loss, the final's winner first).
    // A finished qualifier never changes, so its top 8 is cached for good; the tournament list is re-read hourly so a
    // newly finished qualifier (UK) joins on its own.
    const QUAL_TOP = 8;
    let qualP = null;
    function qualifierTop(d) {
        const names = new Map((d.snapshots || []).map(s => [s.teamId, s.teamName]));
        const elim = new Map();
        let champ = null, champRound = -1;
        for (const m of d.bracket || []) {
            if (m.status !== 'finished' || !m.winner?.teamId || m.bracket === 'upper') continue;
            const w = m.winner.teamId, loser = [m.a?.teamId, m.b?.teamId].find(x => x && x !== w);
            if (loser) elim.set(loser, Math.max(elim.get(loser) ?? -1, m.round));
            if ((m.bracket === 'final' || m.bracket === 'reset') && m.round >= champRound) { champRound = m.round; champ = w; }
        }
        if (!champ) return [];
        elim.delete(champ);
        const rounds = [...elim.values()];
        const out = [{ id: champ, name: names.get(champ) || '?', place: 1 }];
        for (const [id, r] of elim) out.push({ id, name: names.get(id) || '?', place: 2 + rounds.filter(x => x > r).length });
        return out.filter(t => t.place <= QUAL_TOP).sort((a, b) => a.place - b.place);
    }
    function qualified() {
        qualP ??= (async () => {
            const cache = JSON.parse(localStorage.getItem(LS + 'qualified') || '{}');
            cache.done ??= {};
            let list = cache.list;
            if (!list || Date.now() - list.at > 3600e3) {
                const ts = (await api('/tournaments')).tournaments || [];
                list = { at: Date.now(), qs: ts.filter(t => t.kind === 'qualifier').map(t => ({ id: t.id, name: t.name, elig: t.eligibility,
                    done: t.status === 'complete' && t.resultsPublished !== false })) };
            }
            for (const q of list.qs) if (q.done && !cache.done[q.id]?.teams?.length)
                cache.done[q.id] = { teams: qualifierTop(await api(`/tournaments/${q.id}`)) };
            cache.list = list;
            localStorage.setItem(LS + 'qualified', JSON.stringify(cache));
            const map = new Map();
            for (const q of list.qs) for (const t of cache.done[q.id]?.teams || []) map.set(t.id, { ...t, from: q.name, elig: q.elig });
            const short = q => /intl|international/i.test(q.name + q.elig) ? 'Intl' : /uk/i.test(q.name + q.elig) ? 'UK' : q.name;
            for (const v of map.values()) v.tag = short(v);
            return { map, quals: list.qs.map(q => ({ ...q, tag: short(q), n: cache.done[q.id]?.teams?.length || 0 })) };
        })().catch(e => { qualP = null; throw e; });
        return qualP;
    }
    const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
    let qualData = null;
    // "Qualified" ladder filter. The platform's radios are React-controlled and its category filter is server-side, so
    // ours lives beside them under its own name: picking it switches the platform to All (every team, rating order) and
    // hides everything but the qualified rows; their rank cell shows the position among the qualified, overall small.
    const qOnly = () => document.body.classList.contains('cbc-qonly');
    function qualFilter() {
        const fs = [...document.querySelectorAll('fieldset')].find(f => f.querySelector('input[name="ladder-category"]'));
        if (!fs) return;
        const cats = () => [...fs.querySelectorAll('input[name="ladder-category"]')];
        let r = fs.querySelector('#cbc-qual-radio');
        if (!r) {
            r = h('input', { type: 'radio', id: 'cbc-qual-radio', name: 'cbc-ladder-qual' });
            r.addEventListener('change', () => {
                if (!r.checked) return;
                document.body.classList.add('cbc-qonly');
                const all = cats().find(x => x.parentElement?.textContent.trim() === 'All');
                if (all && !all.checked) all.click(); // the platform reloads every category
                setTimeout(() => polishLadder(true), 0);
            });
            fs.addEventListener('click', e => {
                const x = e.target.closest('label')?.querySelector('input[name="ladder-category"]');
                if (x && e.isTrusted) { r.checked = false; document.body.classList.remove('cbc-qonly'); polishLadder(true); }
            });
            fs.append(h('label', { class: 'cbc-qual-label', title: 'Teams qualified for the finals: top 8 of each finished qualifier' }, r, 'Qualified'));
        }
        r.checked = qOnly();
        if (qOnly()) cats().forEach(x => { if (x.checked) x.checked = false; });
    }
    // the switch for the gold highlights, top right of the ladder's header
    function qualToggle() {
        if (document.getElementById('cbc-qhl-toggle')) return;
        const title = [...document.querySelectorAll('h1')].find(e => e.textContent.trim() === 'Ladder');
        const head = title?.parentElement?.parentElement;
        if (!head) return;
        const b = h('button', { type: 'button', id: 'cbc-qhl-toggle', class: 'cbc-toggle', title: 'Gold highlight on the teams qualified for the finals' });
        const sync = () => { b.textContent = 'qualifier highlights ' + (settings.qualHl === false ? 'off' : 'on'); b.classList.toggle('on', settings.qualHl !== false);
            document.body.classList.toggle('cbc-noqhl', settings.qualHl === false); };
        b.addEventListener('click', () => { settings.qualHl = settings.qualHl === false; save(); sync(); });
        sync();
        head.style.position ||= 'relative';
        head.append(b);
    }

    // ---------------------------------------------------------------- rank icons
    // The platform draws every tier from Platinum up with the same hex. From Master up ours add to it, never changing its
    // strokes (owner, 11-09): Master small wings, Grandmaster bigger wings and a crown, and a custom Challenger tier at
    // 2800+ (blue, a second outer pair of wings, gold crown, gold core). The platform's svg stays in the DOM (React owns it), hidden; ours sits beside it.
    const RANK_BASE = '<path d="m12 2 8 5v10l-8 5-8-5V7Z" fill="currentColor" fill-opacity=".12"/><path d="m7 13 5-6 5 6-5 4Z"/><path d="m8 19 4-2 4 2"/>';
    // wings are closed shapes that start and end on the hex's side, so no stroke ever crosses into the figure
    const WING_L = 'M4 8.6 1.3 7.4l.7 2.5-1.1 1.4 1.6.9-.6 1.6 2.1-.3';
    const WING_R = 'M20 8.6l2.7-1.2-.7 2.5 1.1 1.4-1.6.9.6 1.6-2.1-.3';
    const BIG_L = 'M4 7.8.2 5.6l1.2 3.3-1.4 1.9 1.6 1.2-1 2.1 1.9.1-.4 1.9L4 15';
    const BIG_R = 'M20 7.8l3.8-2.2-1.2 3.3 1.4 1.9-1.6 1.2 1 2.1-1.9.1.4 1.9L20 15';
    const OUTER_L = 'M1.2 7.4-2.6 4.2l.4 3.6-1.9 1.6 1.9 1.3-1.5 2.4 2.3.1-.6 2.4 2.6-1.6';
    const OUTER_R = 'M22.8 7.4l3.8-3.2-.4 3.6 1.9 1.6-1.9 1.3 1.5 2.4-2.3.1.6 2.4-2.6-1.6';
    // crown above the hex's top vertex, closed, base touching the apex only
    const CROWN = 'M9.6 1.9 9.1 -1.3l1.7 1.1L12 -2.2l1.2 2 1.7-1.1-.5 3.2Z';
    const RANK_ICONS = {
      master: RANK_BASE + `<path d="${WING_L}M${WING_R.slice(1)}" stroke-width="1.25" fill="currentColor" fill-opacity=".3"/>`,
      gm: RANK_BASE + `<path d="${BIG_L}M${BIG_R.slice(1)}" stroke-width="1.25" fill="currentColor" fill-opacity=".32"/><path d="${CROWN}" stroke-width="1.1" fill="currentColor" fill-opacity=".45"/>`,
      challenger: RANK_BASE + `<path d="${OUTER_L}M${OUTER_R.slice(1)}" stroke-width="1.1" fill="currentColor" fill-opacity=".18"/><path d="${BIG_L}M${BIG_R.slice(1)}" stroke-width="1.25" fill="currentColor" fill-opacity=".34"/><path d="${CROWN}" stroke="#f3c95c" stroke-width="1.1" fill="#f3c95c" fill-opacity=".55"/><path d="m7 13 5-6 5 6-5 4Z" fill="#f3c95c" fill-opacity=".9" stroke="none"/>`,
    };
    const RANK_TIERS = [
        { k: 'challenger', min: 2800, name: 'Challenger', color: '#3fb4ff' },
        { k: 'gm', min: 2600, name: 'Grandmaster', color: '#e8304a' },
        { k: 'master', min: 2400, name: 'Master', color: '#ee7fd0' },
        { k: '', min: 0, name: '', color: null }, // below Master: the platform's own icon
    ];
    const TIER_BY_COLOR = { '#e36db6': 'master', '#cf4848': 'gm' };
    function rankIcons() {
        for (const sp of document.querySelectorAll('span[style*="--tier-color"]')) {
            const svg = [...sp.children].find(c => c.tagName === 'svg' && !c.classList.contains('cbc-rank-svg'));
            if (!svg || svg.querySelector('circle[stroke-dasharray]')) continue; // provisional: leave as is
            const base = (sp.dataset.cbcBase ||= sp.style.getPropertyValue('--tier-color').trim().toLowerCase());
            let rating = null;
            const row = sp.closest('tr');
            const txt = (row?.querySelector('td[data-rating]') || sp.parentElement)?.textContent || '';
            const m = txt.replace(/[, \s]/g, '').match(/(\d{3,4})/);
            if (m) rating = +m[1];
            let tier = rating != null ? RANK_TIERS.find(t => rating >= t.min) : null;
            if (rating == null && TIER_BY_COLOR[base]) tier = RANK_TIERS.find(t => t.k === TIER_BY_COLOR[base]);
            if (tier && tier.k === 'challenger' && base !== '#cf4848') tier = RANK_TIERS[1]; // only real GMs can be Challenger
            const k = tier?.k || '';
            if (sp.dataset.cbcRank === k && (!k || sp.querySelector('.cbc-rank-svg'))) continue;
            sp.dataset.cbcRank = k;
            sp.querySelector('.cbc-rank-svg')?.remove();
            sp.classList.remove('cbc-rank', 'cbc-rank-gm', 'cbc-rank-challenger', 'cbc-rank-master');
            if (!k) { svg.style.display = ''; continue; }
            const mine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            for (const [a, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linejoin', 'round'], ['stroke-linecap', 'round'], ['aria-hidden', 'true']]) mine.setAttribute(a, v);
            mine.classList.add('cbc-rank-svg');
            mine.innerHTML = RANK_ICONS[k];
            svg.style.display = 'none';
            svg.after(mine);
            sp.classList.add('cbc-rank', 'cbc-rank-' + k);
            if (tier.color) sp.style.setProperty('--tier-color', tier.color);
            const label = [...sp.children].find(c => c.tagName === 'SPAN');
            if (k === 'challenger') {
                if (label && label.textContent !== 'Challenger') label.textContent = 'Challenger';
                if (sp.title) sp.title = 'Challenger: 2,800+ Elo';
            }
        }
    }
    let ladderStatsHooked = false;
    function polishLadder(force) {
        const dark = document.documentElement.dataset.theme === 'dark';
        const table = document.querySelector('tr[data-ladder-team]')?.closest('table');
        if (table) {
            qualFilter(); qualToggle();
            if (!qualData && !polishLadder.qLoading) { polishLadder.qLoading = true; qualified().then(Q => { qualData = Q; polishLadder(true); }).catch(() => { polishLadder.qLoading = false; }); }
            const ths = [...table.querySelectorAll('thead th')];
            const si = ths.findIndex(th => th.textContent.trim() === 'Season');
            for (const th of ths) if (th.textContent.trim() === 'Language') th.textContent = 'Lang.';
            if (si >= 0 && !document.getElementById('cbc-ladder-cols')) {
                const st = document.createElement('style');
                st.id = 'cbc-ladder-cols';
                st.textContent = `table:has(tr[data-ladder-team]) tr > :nth-child(${si + 1}) { display: none; }`;
                document.head.append(st);
            }
            const rh = ths[0];
            if (rh && !rh.querySelector('.cbc-vsus')) rh.append(h('span', { class: 'cbc-vsus none', title: 'Our map-normalized win rate against this team: recent games, our latest version (and theirs when known)' }, 'vs'));
            if (!ladderStatsHooked) {
                ladderStatsHooked = true; stats.listeners.add(() => polishLadder(true)); loadStats();
                (mapListP ??= api('/challenges').then(d => d.maps || [])).then(m => { activeMaps = m; polishLadder(true); }).catch(() => { });
            }
        }
        const byOpp = (force || !polishLadder.map || polishLadder.n !== stats.recs.length) ? (polishLadder.n = stats.recs.length, polishLadder.map = groupBy(stats.recs, r => [r.opp])) : polishLadder.map;
        rankIcons();
        for (const tr of document.querySelectorAll('tr[data-ladder-team]')) {
            const urTd = tr.querySelector('td[data-challenge]');
            const urA = urTd?.querySelector('a[href*="challenge="]');
            if (urA && !urTd.querySelector('.cbc-quick')) {
                const id = new URL(urA.href).searchParams.get('challenge');
                const name = tr.querySelector('.team-name a')?.textContent.trim() || 'team';
                const b = h('button', { type: 'button', class: 'cbc-quick', title: `Quick unranked vs ${name}: 5 random maps, current bots, queued right away` });
                b.innerHTML = QUICK_ICON;
                b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); quickUnranked(id, name, b); });
                const b2 = h('button', { type: 'button', class: 'cbc-quick info', title: `Unranked vs ${name} on the 5 maps we have the least recent data on against them (active bot, last 7 days)` });
                b2.innerHTML = INFO_ICON;
                b2.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); quickUnranked(id, name, b2, () => leastDataMaps(id)); });
                urTd.append(b, b2);
            }
            const info = urTd?.querySelector('.cbc-quick.info');
            if (info && urA) {
                const id2 = new URL(urA.href).searchParams.get('challenge');
                const full = fullMapCoverage(id2, byOpp.has(id2) ? vsRecs(id2, byOpp.get(id2)) : []);
                info.classList.toggle('full', full);
                info.title = (full ? 'We already have recent results on every map vs this team. ' : '')
                    + 'Unranked on the 5 maps with the least recent data against them (active bot, last 7 days)';
            }
            const rankTd = tr.querySelector('td[data-rank]');
            const a = tr.querySelector('.team-name a');
            const oppId = a?.getAttribute('href')?.split('/').pop();
            if (rankTd && oppId) {
                let b = rankTd.querySelector('.cbc-vsus');
                if (!b) { b = h('span', { class: 'cbc-vsus' }); rankTd.append(b); }
                const key = (byOpp.get(oppId)?.length ?? 0) + (dark ? 'd' : 'l') + stats.main;
                if (b.dataset.k !== key) {
                    b.dataset.k = key;
                    const rs = byOpp.has(oppId) ? vsRecs(oppId, byOpp.get(oppId)) : [];
                    const s2 = rs.length ? mapNormWR(rs) : null;
                    if (s2) {
                        b.className = 'cbc-vsus'; b.textContent = pctFit(s2.wr); b.style.color = wrColor(s2.wr);
                        b.title = `us vs them, maps weighted equally: ${pct(s2.wr)} over ${s2.n} games\n` + s2.byMap.map(m => `${m.map}: ${pct(m.wr)} (${m.n})`).join('\n');
                    } else { b.className = 'cbc-vsus none'; b.textContent = 'N/A'; b.style.color = ''; b.title = `no games against them on v${stats.main} in the last 7 days`; }
                }
            }
            const q = qualData && oppId ? qualData.map.get(oppId) : null;
            tr.classList.toggle('cbc-qrow', !!q);
            const elig = tr.querySelector('.team-badges > span[title*=" team"], .team-badges > span[title*="non-student"]');
            if (elig) { elig.classList.toggle('cbc-qicon', !!q); if (q) elig.dataset.cbcQ = `Qualified for the finals: ${ordinal(q.place)} in ${q.from}`; }
            if (elig && q && !elig.dataset.cbcTitle) { elig.dataset.cbcTitle = elig.getAttribute('title') || ''; }
            if (elig && elig.dataset.cbcTitle != null) elig.setAttribute('title', q ? `${elig.dataset.cbcQ}\n${elig.dataset.cbcTitle}` : elig.dataset.cbcTitle);
            // rank cell: the parenthesised overall position (category views) becomes a small grey number
            const sm = rankTd?.querySelector('span > small');
            if (sm && /[()]/.test(sm.textContent)) sm.textContent = sm.textContent.replace(/[()]/g, '');
            const t = tr.querySelector('[style*="--tier-color"]')?.style.getPropertyValue('--tier-color');
            if (!t || !a) continue;
            const key = t + (dark ? 'd' : 'l');
            if (a.dataset.cbcTier === key) continue;
            a.dataset.cbcTier = key;
            const ink = tierInk(t, dark);
            if (ink) a.style.color = ink;
        }
        qualRanks();
    }
    // in the Qualified view: position among the qualified (rating order, as the table is) + overall rank, small and grey
    function qualRanks() {
        let i = 0;
        for (const tr of document.querySelectorAll('tr[data-ladder-team]')) {
            const td = tr.querySelector('td[data-rank]');
            if (!td) continue;
            let qr = td.querySelector('.cbc-qrank');
            if (!qOnly() || !tr.classList.contains('cbc-qrow')) { qr?.remove(); continue; }
            const overall = (td.querySelector('span[aria-label]')?.getAttribute('aria-label') || '').match(/(?:overall|Overall position) (\d+)/)?.[1]
                ?? td.querySelector('span')?.firstChild?.textContent.trim();
            i++;
            if (!qr) { qr = h('span', { class: 'cbc-qrank' }); td.prepend(qr); }
            const k = i + '/' + overall;
            if (qr.dataset.k !== k) { qr.dataset.k = k; qr.replaceChildren(String(i), ' ', h('small', {}, overall || '')); }
        }
    }

    // ---------------------------------------------------------------- routing
    let routing = false;
    // ---------------------------------------------------------------- cambc viewer links
    // A match group's page gets a bar linking each of its games to osteo's cambc viewer (the platform's 2D one is
    // broken), which loads the replay through his server's platform proxy.
    const VIEWER = 'https://apps.tail5c9691.ts.net:10000/cambc/visualiser/?replay=';
    const viewerHref = gameId => VIEWER + encodeURIComponent(`/api/platform/games/${gameId}/replay.zip`);
    let viewerFor = null;
    async function viewerLinks(groupId) {
        if (document.querySelector(`[data-cbc="viewer:${CSS.escape(groupId)}"]`) || viewerFor === groupId) return;
        viewerFor = groupId;
        try {
            const d = await api(`/match-groups/${groupId}`);
            const games = (d.matches || []).filter(m => m.id);
            const at = document.querySelector('main') || document.body.firstElementChild;
            if (!games.length || !at || location.pathname.indexOf(groupId) < 0) return;
            document.querySelectorAll('[data-cbc^="viewer:"]').forEach(e => e.remove());
            at.prepend(h('div', { 'data-cbc': `viewer:${groupId}`, class: 'cbc-viewer-bar' },
                h('span', { class: 'cbc-viewer-label' }, 'cambc viewer'),
                games.map((m, i) => h('a', { href: viewerHref(m.id), target: '_blank', rel: 'noopener',
                    class: 'cbc-toggle', title: `open game ${i + 1}${m.map ? ' (' + m.map + ')' : ''} in the cambc viewer` },
                    `${i + 1}${m.map ? ' · ' + m.map.replace(/^\d+/, '') : ''}`))));
        } catch (e) { viewerFor = null; }
    }

    async function route() {
        if (routing || !document.body) return;
        routing = true;
        try {
            injectStyle();
            retint();
            rankIcons();
            const p = location.pathname;
            if (/^\/game\/ladder/.test(p)) polishLadder();
            const group = p.match(/^\/game\/match-groups\/([0-9a-f-]{36})/i);
            if (group) viewerLinks(group[1]);
            predictorNav();
            if (/^\/game\/predictor\/?$/.test(p)) {
                if (mounted?.key === 'predictor' && document.querySelector('[data-cbc="predictor"]')) return;
                if (mounted) unmount();
                await mountPredictor('predictor');
                return;
            }
            const team = p.match(/^\/game\/team(?:\/([0-9a-f-]{36}))?\/?$/i);
            const matches = /^\/game\/matches\/?$/.test(p) && !new URLSearchParams(location.search).has('challenge');
            const key = team ? 'team:' + (team[1] || 'me') : matches ? 'matches' : null;
            if (!settings.enabled || !key) {
                if (mounted) unmount();
                if (key && !settings.enabled) mountSwitchOnly(key);
                return;
            }
            if (team) {
                // the "Team members" heading sits right before .team-members; ours replaces both
                const prev = document.querySelector('.team-members')?.previousElementSibling;
                if (prev?.classList.contains('team-section-heading')) prev.classList.add('cbc-hide-native');
            }
            const alive = mounted && mounted.key === key && document.querySelector(`[data-cbc="${CSS.escape(key)}"]`);
            if (alive) return;
            if (mounted) unmount();
            if (team) await mountTeam(key, team[1]);
            else await mountMatches(key);
        } finally { routing = false; }
    }
    function mountSwitchOnly(key) {
        if (document.querySelector('.cbc-switch-only')) return;
        const at = key === 'matches' ? document.querySelector('.match-toolbar') : document.querySelector('.team-hero');
        if (!at) return;
        const b = compactSwitch(); b.classList.add('cbc-switch-only');
        b.style.cssText = 'position:relative;z-index:2;margin-bottom:8px';
        at.parentElement.insertBefore(b, at);
    }

    // --- no flash of the original UI: styles, theme and pre-hiding go in now (document-start), before the first paint;
    // styled-components rules are retinted as they're inserted, and routing follows DOM changes instead of a timer.
    function prehideOff() { document.documentElement.classList.remove('cbc-pre-team', 'cbc-pre-matches'); }
    function prehide() {
        const p = location.pathname, on = settings.enabled;
        const team = on && /^\/game\/team(?:\/[0-9a-f-]{36})?\/?$/i.test(p);
        const matches = on && /^\/game\/matches\/?$/.test(p) && !new URLSearchParams(location.search).has('challenge');
        document.documentElement.classList.toggle('cbc-pre-team', !!team);
        document.documentElement.classList.toggle('cbc-pre-matches', !!matches);
        document.documentElement.classList.toggle('cbc-pre-pred', /^\/game\/predictor\/?$/.test(p));
        // never leave the page blank: if mounting hasn't happened in 4s, show cambc's own layout
        clearTimeout(prehide.t);
        if (team) prehide.t = setTimeout(() => { if (!document.body?.classList.contains('cbc-on')) document.documentElement.classList.remove('cbc-pre-team'); }, 4000);
    }
    const origInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
        const i = origInsertRule.call(this, rule, index);
        try { const r = this.cssRules[i]; if (r) retintRules([r]); } catch { }
        return i;
    };
    let routeQueued = false;
    const queueRoute = () => {
        if (routeQueued) return;
        routeQueued = true;
        requestAnimationFrame(() => { routeQueued = false; retint(); route(); });
    };
    // the <html> element may not exist yet this early
    const early = () => {
        me(); // start /me now so mounting doesn't wait on it
        injectStyle();
        prehide();
        new MutationObserver(queueRoute).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) early();
    else { const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); early(); } }); mo.observe(document, { childList: true }); }
    for (const fn of ['pushState', 'replaceState']) {
        const orig = history[fn];
        history[fn] = function () { const r = orig.apply(this, arguments); prehide(); queueRoute(); return r; };
    }
    window.addEventListener('popstate', () => { prehide(); queueRoute(); });
    // safety net for anything the observer misses
    setInterval(route, 1500);
    document.addEventListener('DOMContentLoaded', queueRoute);
})();
