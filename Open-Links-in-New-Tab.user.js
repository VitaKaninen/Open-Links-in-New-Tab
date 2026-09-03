// ==UserScript==
// @name        Open Links in New Tab
// @namespace   https://github.com/VitaKaninen
// @version     1.21.0
// @author      VitaKaninen
// @description Open links in a new tab (with exceptions & toggle)
// @match       *://*/*
// @grant       GM_openInTab
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       unsafeWindow
// @run-at      document-end
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/Open-Links-in-New-Tab/main/Open-Links-in-New-Tab.user.js
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/Open-Links-in-New-Tab/main/Open-Links-in-New-Tab.user.js
// ==/UserScript==

(function() {
    'use strict';
    const SCRIPT_VERSION = '1.21.0';
    const STORAGE_KEY = 'forceNewTabEnabled';
    const SITES_KEY = 'activeSites';
    const EXCEPTIONS_KEY = 'linkExceptions';
    const PAGE_EXCEPTIONS_KEY = 'pageExceptions';
    const INSERT_NEXT_KEY = 'insertNextSites';
    const EARLY_CAPTURE_KEY = 'earlyCaptureSites';
    const DIAG_LOGGING_KEY = 'diagnosticLogging'; // v1.15.0 boolean, still read for migration
    const DIAG_MODE_KEY = 'diagnosticMode';
    const DIAG_LOG_KEY = 'diagnosticLog';
    const DIAG_LOG_MAX = 40;

    // The script only *acts* in the top frame, but a click inside an iframe is
    // invisible to the top-frame handler — which in the panel looks exactly
    // like "nothing happened at all". So subframes still install the deep
    // probe, letting that cause say its own name instead of staying silent.
    // This check sits below the const declarations on purpose: returning above
    // them would leave every one in the temporal dead zone, and the probe
    // needs the storage keys.
    if (window !== window.top) {
        installFrameProbe();
        return;
    }

    // ---------------- Site List (persisted) ----------------
    function getActiveSites() {
        const stored = GM_getValue(SITES_KEY, null);
        if (stored === null) return [];
        try { return JSON.parse(stored); } catch (_) { return []; }
    }

	function saveActiveSites(list) {
        GM_setValue(SITES_KEY, JSON.stringify(list));
    }

    function getExceptions() {
        const stored = GM_getValue(EXCEPTIONS_KEY, null);
        if (stored === null) return [];
        try { return JSON.parse(stored); } catch (_) { return []; }
    }

    function saveExceptions(list) {
        GM_setValue(EXCEPTIONS_KEY, JSON.stringify(list));
    }

    function getPageExceptions() {
        const stored = GM_getValue(PAGE_EXCEPTIONS_KEY, null);
        if (stored === null) return [];
        try { return JSON.parse(stored); } catch (_) { return []; }
    }

    function savePageExceptions(list) {
        GM_setValue(PAGE_EXCEPTIONS_KEY, JSON.stringify(list));
    }

    function getInsertNextSites() {
        const stored = GM_getValue(INSERT_NEXT_KEY, null);
        if (stored === null) return ['reddit.com']; // default seed (was hardcoded)
        try { return JSON.parse(stored); } catch (_) { return ['reddit.com']; }
    }

    function saveInsertNextSites(list) {
        GM_setValue(INSERT_NEXT_KEY, JSON.stringify(list));
    }

    // ---------------- Early Capture (per-site) ----------------
    // Some sites shield their own click handling with a stopPropagation() call
    // on a window capture listener. The event then dies before it reaches this
    // script's handler on document, and links open in the same tab with no
    // sign of why. Acting from window/capture instead fixes it — but only for
    // the sites that need it: running that early everywhere would put this
    // script ahead of other userscripts' click modes (Forum Stumbler's
    // teach-by-clicking registers its window listener later than our boot-time
    // one, so we would start stealing its picks). Hence a per-site list.
    function getEarlyCaptureSites() {
        const stored = GM_getValue(EARLY_CAPTURE_KEY, null);
        if (stored === null) return [];
        try { return JSON.parse(stored); } catch (_) { return []; }
    }

    function saveEarlyCaptureSites(list) {
        GM_setValue(EARLY_CAPTURE_KEY, JSON.stringify(list));
    }

    function matchedEarlyCaptureSite() {
        const hostname = location.hostname.toLowerCase();
        return getEarlyCaptureSites().find(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        ) || null;
    }

    // ---------------- Diagnostic Log (persisted) ----------------
    // The log lives in GM storage rather than the page console on purpose:
    //   - it holds only this script's own decisions, so extension noise
    //     (NoScript/uBlock CSP and blocked-request errors) can't bury it;
    //   - GM storage is shared across pages and origins, so a click that
    //     navigates away still leaves a readable entry behind;
    //   - the panel can show the Active Sites / Exceptions lists too, which
    //     page-console code can never reach — GM storage is outside the page.
    // 'off' | 'on' (link clicks the script sees) | 'deep' (every click, plus
    // the clicks it never sees — see the probe section).
    function getDiagMode() {
        const mode = GM_getValue(DIAG_MODE_KEY, null);
        if (mode === 'off' || mode === 'on' || mode === 'deep') return mode;
        return GM_getValue(DIAG_LOGGING_KEY, false) === true ? 'on' : 'off';
    }

    function setDiagMode(mode) {
        GM_setValue(DIAG_MODE_KEY, mode);
        safeUpdateIndicator();
    }

    function isDiagLogging() {
        return getDiagMode() !== 'off';
    }

    function getDiagLog() {
        const stored = GM_getValue(DIAG_LOG_KEY, null);
        if (stored === null) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
    }

    function clearDiagLog() {
        GM_setValue(DIAG_LOG_KEY, JSON.stringify([]));
    }

    function truncate(value, max) {
        const s = String(value == null ? '' : value);
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function appendDiagEntry(entry) {
        try {
            const log = getDiagLog();
            log.unshift(entry);
            GM_setValue(DIAG_LOG_KEY, JSON.stringify(log.slice(0, DIAG_LOG_MAX)));
        } catch (_) {
            // Diagnostics must never break a click.
        }
    }

    function recordDiagEntry(link, verdict) {
        appendDiagEntry({
            t: Date.now(),
            page: truncate(location.href, 300),
            href: truncate(link.href, 300),
            text: truncate((link.textContent || '').replace(/\s+/g, ' ').trim(), 80),
            action: verdict.action,
            reason: verdict.reason,
            rule: verdict.rule || ''
        });
    }

    // ---------------- Deep Probe ----------------
    // "Nothing was logged" is the hardest symptom to act on, because every
    // cause produces the same silence. This probe sits at window/capture —
    // ahead of every document-level listener, so it still sees clicks that
    // something else stops before they reach the handler — and names which
    // cause applies. It never calls preventDefault or stopPropagation, so it
    // cannot change what the page does.
    // Keyed by the event object itself, not by a counter: several clicks can
    // land before the deferred checks below drain, and a shared counter would
    // let a later click overwrite an earlier one's state — making the probe
    // report a verdict about the wrong click.
    const loggedEvents = new WeakSet();
    const docSeenEvents = new WeakSet();
    let mousedownToken = 0;
    let clickSeenToken = 0;

    const PANEL_IDS = ['gm-newtab-settings', 'gm-newtab-diagnostics'];
    let diagnosticsRefresh = null;

    // Clicks on this script's own panels are not evidence about the page, and
    // logging them buries the entry you actually went looking for.
    function isOwnUI(e) {
        const target = e.target;
        if (!target) return false;
        // Clicks inside the panels' shadow roots retarget to the host element,
        // so its id is enough here — no composedPath() walk on every click.
        if (target.id && PANEL_IDS.indexOf(target.id) !== -1) return true;
        return !!(target.closest && target.closest('#gm-newtab-settings, #gm-newtab-diagnostics'));
    }

    // Set on the real window (not the userscript sandbox) so the top frame can
    // ask each iframe whether the script is alive inside it.
    function markProbeAlive() {
        try {
            const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            realWin.__olintProbeAlive = true;
        } catch (_) {
            // Sandbox refused the write; frameReport() degrades to "cannot inspect".
        }
    }

    // An <a> inside an iframe is completely invisible to the top-frame probe,
    // and that is indistinguishable from "no click happened" — so enumerate the
    // frames and say which ones the script is actually watching.
    function frameReport() {
        const frames = document.querySelectorAll('iframe');
        if (!frames.length) return 'none — every link on this page is in this document';

        let alive = 0, blind = 0, opaque = 0;
        frames.forEach(frame => {
            let win = null;
            try {
                win = frame.contentWindow;
                void win.location.href; // throws for cross-origin
            } catch (_) {
                opaque++;
                return;
            }
            if (!win) { opaque++; return; }
            if (win.__olintProbeAlive === true) alive++; else blind++;
        });

        const parts = [];
        if (alive) parts.push(alive + ' with the script running');
        if (blind) parts.push(blind + ' where the script is NOT running');
        if (opaque) parts.push(opaque + ' cross-origin (cannot inspect)');
        return frames.length + ' iframe' + (frames.length === 1 ? '' : 's') + ' — ' + parts.join(', ');
    }

    function describeNode(node) {
        if (!node || !node.tagName) return String((node && node.nodeName) || 'unknown');
        let out = node.tagName.toLowerCase();
        if (node.id) out += '#' + node.id;
        const cls = (typeof node.className === 'string' ? node.className : '')
            .trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) out += '.' + cls.join('.');
        return out;
    }

    function pathAnchorOf(e) {
        // composedPath() pierces shadow roots; e.target.closest() cannot. An
        // anchor visible here but not there means the link lives in a shadow
        // tree, which is a real and otherwise invisible failure mode.
        const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
        for (const node of path) {
            if (node && node.tagName === 'A' && node.getAttribute && node.getAttribute('href')) return node;
        }
        return null;
    }

    // A rival listener registered on window before this one can kill a click
    // with stopImmediatePropagation, and then even the probe above never runs —
    // silence again. mousedown fires first and is far less often intercepted,
    // so "mousedown seen, click never seen" isolates that case, and "neither
    // seen" means the click is not happening in this document at all.
    function probeMousedown(e) {
        if (getDiagMode() !== 'deep') return;
        if (e.button !== 0 || isOwnUI(e)) return;

        const seq = ++mousedownToken;
        const anchor = pathAnchorOf(e) || ((e.target && e.target.closest) ? e.target.closest('a[href]') : null);
        const targetDesc = describeNode(e.target);

        setTimeout(() => {
            if (clickSeenToken >= seq) return; // a click followed; the click probe has it

            appendDiagEntry({
                t: Date.now(),
                page: truncate(location.href, 300),
                href: anchor ? truncate(anchor.href, 300) : '(no link)',
                text: truncate(((anchor || e.target).textContent || '').replace(/\s+/g, ' ').trim(), 80),
                action: 'probe',
                reason: 'A mousedown was seen here but no click event ever followed — something is suppressing the click itself, or the site navigates on mousedown',
                rule: 'pressed on: ' + targetDesc
            });
        }, 600);
    }

    // Notices that a site needs Early Capture and says so, but does not switch
    // it on by itself. Enabling automatically would misfire on another
    // userscript's modal click mode: Forum Stumbler's teach-by-clicking also
    // stops the event at window level, which is indistinguishable from a site
    // shield here. Auto-enabling on that would make this script win the race
    // against it from then on — the exact collision the shared CLAUDE.md
    // documents. So: report, and let the user decide.
    let earlyCaptureSuggested = false;

    function maybeSuggestEarlyCapture(link) {
        if (earlyCaptureSuggested) return;
        const hostname = location.hostname.toLowerCase();
        if (!hostname || matchedEarlyCaptureSite()) return;

        let wouldHaveActed = false;
        try {
            wouldHaveActed = classifyClick({ defaultPrevented: false, shiftKey: false, altKey: false,
                                             ctrlKey: false, metaKey: false }, link).action !== 'not-handled';
        } catch (_) {
            return;
        }
        if (!wouldHaveActed) return;

        earlyCaptureSuggested = true;
        appendDiagEntry({
            t: Date.now(),
            page: truncate(location.href, 300),
            href: truncate(link.href || '', 300),
            text: hostname,
            action: 'probe',
            reason: 'This site shields its clicks, so links here will not open in a new tab until Early Capture is switched on for it',
            rule: 'fix: Settings › Early Capture › + This Site'
        });
    }

    function probeClick(e) {
        clickSeenToken = mousedownToken; // before the mode check: mousedown probe needs this either way
        const deep = getDiagMode() === 'deep';
        const button = e.button;

        // Hot path. With logging off, the only thing left to learn from a click
        // is that this site needs Early Capture — so bail out as soon as that
        // is settled, before touching the DOM or the stored lists. Ordinary
        // browsing pays almost nothing for the probe being installed.
        if (!deep) {
            if (button !== 0 || earlyCaptureSuggested) return;
            if (matchedEarlyCaptureSite()) return;   // already handled here
            if (isPageExcepted() || !isEnabled()) return; // nothing would act anyway
        }
        if (isOwnUI(e)) return;

        const plainAnchor = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
        if (!deep && !plainAnchor) return;

        // Only the diagnostics display needs these, so they stay off the hot path.
        const shadowAnchor = deep ? pathAnchorOf(e) : null;
        const targetDesc = deep ? describeNode(e.target) : '';
        // Read at window/capture — the earliest point in the dispatch. If it is
        // already true here, something ran before this script even saw the
        // event, which is the fingerprint of a site's own router.
        const alreadyPrevented = e.defaultPrevented;

        // Runs after the whole dispatch, so it knows whether the real handler
        // logged this click. If it did, stay quiet — no duplicate entries.
        setTimeout(() => {
            if (loggedEvents.has(e)) return;

            // Detection runs whether or not logging is on, so a shielded site
            // gets reported without having to leave DEEP mode enabled. The
            // classification it needs is deferred to here: this branch is rare,
            // and doing it eagerly would cost every click on every page.
            const diedBeforeHandler = button === 0 && plainAnchor && !docSeenEvents.has(e);
            if (diedBeforeHandler) maybeSuggestEarlyCapture(plainAnchor);

            if (!deep) return;

            let reason, rule;
            if (button !== 0) {
                reason = 'Not a plain left-click, so the script ignores it';
                rule = 'mouse button ' + button;
            } else if (!shadowAnchor && !plainAnchor) {
                reason = 'Nothing in the click path is an <a href> — the site navigates with JavaScript, so there is no link for this script to take over';
                rule = 'clicked: ' + targetDesc;
            } else if (shadowAnchor && !plainAnchor) {
                reason = 'The link sits inside a shadow root, where this script cannot reach it';
                rule = 'clicked: ' + targetDesc;
            } else if (!docSeenEvents.has(e)) {
                // The bare document-capture probe never fired either, so the
                // event really was killed on the way. Only a window-level
                // capture listener sits between the two.
                reason = 'The click reached window but never reached document — a listener on window called stopPropagation()';
                rule = 'the site\'s own router, or an extension' +
                       (alreadyPrevented ? '; it had already called preventDefault() before this script saw the click' : '');
            } else {
                // document saw the event, so nothing stopped propagation: the
                // handler itself is the thing that did not act.
                reason = 'The click DID reach this script, but the handler produced no verdict — it bailed out or threw';
                rule = 'handler reached, verdict missing' +
                       (alreadyPrevented ? '; defaultPrevented was already true at window capture' : '');
            }

            const anchor = shadowAnchor || plainAnchor;
            appendDiagEntry({
                t: Date.now(),
                page: truncate(location.href, 300),
                href: anchor ? truncate(anchor.href, 300) : '(no link)',
                text: truncate(((anchor || e.target).textContent || '').replace(/\s+/g, ' ').trim(), 80),
                action: 'probe',
                reason: reason,
                rule: rule
            });
        }, 0);
    }

    function installFrameProbe() {
        markProbeAlive();
        window.addEventListener('click', e => {
            if (getDiagMode() !== 'deep') return;
            const anchor = pathAnchorOf(e) || ((e.target && e.target.closest) ? e.target.closest('a[href]') : null);
            appendDiagEntry({
                t: Date.now(),
                page: truncate(location.href, 300),
                href: anchor ? truncate(anchor.href, 300) : '(no link)',
                text: truncate(((anchor || e.target).textContent || '').replace(/\s+/g, ' ').trim(), 80),
                action: 'probe',
                reason: 'Click happened inside an iframe, where the script deliberately does not run',
                rule: 'frame: ' + truncate(location.href, 120)
            });
        }, true);
    }

    // ---------------- List Ordering ----------------
    // Every settings list is shown and stored alphabetically, so scanning for
    // "is this site already in here?" is a straight read down the column.
    // The scheme and a leading "www." are ignored for the comparison — without
    // that, Page Exceptions (full URLs) would all clump under "https://" and
    // sort by nothing useful.
    function sortKey(value) {
        return String(value).toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
            .replace(/^www\./, '');
    }

    function sortList(list) {
        return list.slice().sort((a, b) =>
            sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true, sensitivity: 'base' })
        );
    }

    // ---------------- Panel Shell ----------------
    // Host element + Shadow DOM so the host page's CSS can't cascade into the
    // panel. Page selectors (div/button/input/* rules, inherited props) don't
    // cross the shadow boundary, so the UI renders consistently regardless of
    // which site it's opened on. Shared by the settings and diagnostics panels.
    function createPanelShell(id, titleText, width) {
        const host = document.createElement('div');
        host.id = id;
        host.style.cssText = 'all: initial;';
        const root = host.attachShadow({ mode: 'open' });

        // Reset inherited properties (font, color, line-height, etc.) at the
        // shadow boundary; explicit styles below build the look from scratch.
        const resetStyle = document.createElement('style');
        resetStyle.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(resetStyle);

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483646;
            background: rgba(0,0,0,0.6); display: flex;
            align-items: center; justify-content: center; font-family: system-ui, sans-serif;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #1e1e2e; color: #cdd6f4; border-radius: 10px;
            padding: 20px 24px; width: ${width}px; max-height: 80vh;
            display: flex; flex-direction: column; gap: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 700; color: #89b4fa;';
        title.textContent = titleText;

        panel.appendChild(title);
        overlay.appendChild(panel);
        root.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) host.remove(); });

        return { host, panel };
    }

    function makeButton(label, background, color) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `
            padding: 6px 14px; border-radius: 6px; border: none;
            background: ${background}; color: ${color || '#1e1e2e'};
            font-weight: 700; font-size: 13px; cursor: pointer; white-space: nowrap;
        `;
        return btn;
    }

    // ---------------- Settings Panel ----------------
    function openSettingsPanel() {
        if (document.getElementById('gm-newtab-settings')) return;

        const shell = createPanelShell('gm-newtab-settings', 'Open Links in New Tab — Settings', 420);
        const host = shell.host;
        const panel = shell.panel;

        // Tabs
        const tabBar = document.createElement('div');
        tabBar.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #45475a; padding-bottom: 8px;';

        const tabContents = document.createElement('div');
        tabContents.style.cssText = 'flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 10px;';

        let activeTab = 0;

        function makeTab(label, index) {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.cssText = `
                padding: 5px 14px; border-radius: 6px; border: none; font-size: 13px;
                font-weight: 600; cursor: pointer; transition: background 0.15s;
            `;
            btn.dataset.tabIndex = index;
            return btn;
        }

        function setActiveTab(index, tabs, contents) {
            activeTab = index;
            tabs.forEach((t, i) => {
                t.style.background = i === index ? '#89b4fa' : '#313244';
                t.style.color = i === index ? '#1e1e2e' : '#cdd6f4';
            });
            contents.forEach((c, i) => {
                c.style.display = i === index ? 'flex' : 'none';
            });
        }

        function buildSection(cfg) {
            const section = document.createElement('div');
            section.style.cssText = 'display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0;';

            // Build description with DOM nodes + textContent (never innerHTML —
            // sites with a Trusted Types CSP, e.g. YouTube, throw on innerHTML).
            const desc = document.createElement('div');
            desc.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
            if (cfg.description) {
                const descMain = document.createElement('div');
                descMain.textContent = cfg.description;
                desc.appendChild(descMain);
            }
            if (cfg.examples) {
                const descEx = document.createElement('div');
                descEx.style.cssText = 'margin-top: 4px; color: #6c7086; font-style: italic;';
                descEx.textContent = cfg.examples;
                desc.appendChild(descEx);
            }

            const addRow = document.createElement('div');
            addRow.style.cssText = 'display: flex; gap: 6px;';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = cfg.placeholder;
            input.style.cssText = `
                flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #45475a;
                background: #313244; color: #cdd6f4; font-size: 13px; outline: none;
            `;

            const addBtn = document.createElement('button');
            addBtn.textContent = 'Add';
            addBtn.style.cssText = `
                padding: 6px 12px; border-radius: 6px; border: none;
                background: #89b4fa; color: #1e1e2e; font-weight: 700;
                font-size: 13px; cursor: pointer;
            `;

            const addCurrentBtn = document.createElement('button');
            addCurrentBtn.textContent = cfg.addCurrentLabel;
            addCurrentBtn.title = cfg.addCurrentTitle;
            addCurrentBtn.style.cssText = `
                padding: 6px 10px; border-radius: 6px; border: none;
                background: #a6e3a1; color: #1e1e2e; font-weight: 700;
                font-size: 13px; cursor: pointer; white-space: nowrap;
            `;

            addRow.appendChild(input);
            addRow.appendChild(addBtn);
            addRow.appendChild(addCurrentBtn);

            const list = document.createElement('div');
            list.style.cssText = `
                overflow-y: auto; display: flex; flex-direction: column; gap: 5px;
                flex: 1; min-height: 0; padding-right: 4px;
            `;

            // Persist sorted as well as display sorted, so exported .txt files
            // come out in the same order the panel shows.
            function saveSorted(items) {
                cfg.saveItems(sortList(items));
                // Adding the current host under Active Sites used to do nothing
                // until a reload, because the only force-enable ran at init —
                // so the panel looked like it had ignored the entry. Re-running
                // it here is safe: it only ever turns the script ON, and only
                // when a rule actually matches this page.
                checkDefaultEnabled();
            }

            function renderList() {
                while (list.firstChild) list.removeChild(list.firstChild);
                const items = sortList(cfg.getItems());
                if (items.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'color: #6c7086; font-size: 13px; text-align: center; padding: 12px 0;';
                    empty.textContent = 'No entries yet.';
                    list.appendChild(empty);
                    return;
                }
                items.forEach(item => {
                    const row = document.createElement('div');
                    row.style.cssText = `
                        display: flex; align-items: center; justify-content: space-between;
                        background: #313244; border-radius: 6px; padding: 6px 10px;
                    `;
                    const label = document.createElement('span');
                    label.style.cssText = 'font-size: 13px; word-break: break-all;';
                    label.textContent = item;

                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = '✕';
                    removeBtn.style.cssText = `
                        background: none; border: none; color: #f38ba8;
                        cursor: pointer; font-size: 14px; padding: 0 4px; flex-shrink: 0;
                    `;
                    removeBtn.title = 'Remove ' + item;
                    removeBtn.addEventListener('click', () => {
                        // Remove by value, not by index: the rendered order is
                        // sorted while stored order may not be (lists saved by
                        // an earlier version), so an index would delete the
                        // wrong entry. Entries are unique — addItem dedupes.
                        const updated = cfg.getItems().filter(existing => existing !== item);
                        saveSorted(updated);
                        renderList();
                    });

                    row.appendChild(label);
                    row.appendChild(removeBtn);
                    list.appendChild(row);
                });
            }

            function addItem(raw) {
                const value = cfg.normalize(raw);
                if (!value) return;
                const items = cfg.getItems();
                if (items.includes(value)) return;
                items.push(value);
                saveSorted(items);
                renderList();
                input.value = '';
            }

            addBtn.addEventListener('click', () => addItem(input.value));
            input.addEventListener('keydown', e => { if (e.key === 'Enter') addItem(input.value); });
            addCurrentBtn.addEventListener('click', () => addItem(cfg.currentValue()));

            // ---------- Import / Export row ----------
            const ioRow = document.createElement('div');
            ioRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';

            const exportBtn = document.createElement('button');
            exportBtn.textContent = 'Export';
            exportBtn.style.cssText = `
                padding: 5px 12px; border-radius: 6px; border: none;
                background: #fab387; color: #1e1e2e; font-weight: 700;
                font-size: 12px; cursor: pointer;
            `;
            exportBtn.title = 'Download list as a .txt file';

            const importBtn = document.createElement('button');
            importBtn.textContent = 'Import';
            importBtn.style.cssText = `
                padding: 5px 12px; border-radius: 6px; border: none;
                background: #f9e2af; color: #1e1e2e; font-weight: 700;
                font-size: 12px; cursor: pointer;
            `;
            importBtn.title = 'Load a .txt file and merge with existing list';

            const ioStatus = document.createElement('span');
            ioStatus.style.cssText = 'font-size: 12px; color: #a6e3a1; margin-left: 4px;';

            function flashStatus(msg, color) {
                ioStatus.style.color = color || '#a6e3a1';
                ioStatus.textContent = msg;
                clearTimeout(ioStatus._t);
                ioStatus._t = setTimeout(() => { ioStatus.textContent = ''; }, 3000);
            }

            exportBtn.addEventListener('click', async () => {
                const items = sortList(cfg.getItems());
                if (items.length === 0) {
                    flashStatus('Nothing to export.', '#f38ba8');
                    return;
                }
                const contents = items.join('\n') + '\n';

                // Modern: ask user where to save (Chrome/Edge/Brave/Opera)
                // Use unsafeWindow so the call runs on the real window (userscript
                // sandbox proxies break showSaveFilePicker with "Illegal invocation").
                const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
                if (typeof realWin.showSaveFilePicker === 'function') {
                    try {
                        const handle = await realWin.showSaveFilePicker.call(realWin, {
                            suggestedName: cfg.exportFilename,
                            types: [{
                                description: 'Text file',
                                accept: { 'text/plain': ['.txt'] }
                            }]
                        });
                        const writable = await handle.createWritable();
                        await writable.write(contents);
                        await writable.close();
                        flashStatus('Exported ' + items.length + ' entries.');
                    } catch (err) {
                        if (err && err.name === 'AbortError') {
                            flashStatus('Export cancelled.', '#f9e2af');
                        } else {
                            flashStatus('Export failed: ' + (err && err.message || err), '#f38ba8');
                        }
                    }
                    return;
                }

                // Fallback for browsers without File System Access API (e.g. Firefox)
                const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = cfg.exportFilename;
                document.documentElement.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                flashStatus('Exported ' + items.length + ' entries.');
            });

            importBtn.addEventListener('click', () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.txt,text/plain';
                fileInput.style.display = 'none';
                fileInput.addEventListener('change', e => {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => {
                        const text = String(ev.target.result || '');
                        const lines = text.split(/\r?\n/)
                            .map(l => cfg.normalize(l))
                            .filter(l => l && !l.startsWith('#'));
                        const existing = cfg.getItems();
                        const merged = existing.slice();
                        let added = 0;
                        lines.forEach(line => {
                            if (!merged.includes(line)) {
                                merged.push(line);
                                added++;
                            }
                        });
                        saveSorted(merged);
                        renderList();
                        flashStatus('Imported ' + added + ' new (' + (lines.length - added) + ' duplicate).');
                    };
                    reader.onerror = () => flashStatus('Failed to read file.', '#f38ba8');
                    reader.readAsText(file);
                });
                document.documentElement.appendChild(fileInput);
                fileInput.click();
                setTimeout(() => fileInput.remove(), 1000);
            });

            ioRow.appendChild(exportBtn);
            ioRow.appendChild(importBtn);
            ioRow.appendChild(ioStatus);

            renderList();
            section.appendChild(desc);
            section.appendChild(addRow);
            section.appendChild(list);
            section.appendChild(ioRow);
            return section;
        }

        const sitesSection = buildSection({
            description: 'Sites where the script is always ON, so links open in a new tab automatically. Enter a domain.',
            examples: 'Examples: example.com, news.ycombinator.com',
            placeholder: 'e.g. example.com',
            addCurrentLabel: '+ This Site',
            addCurrentTitle: 'Add the current site (' + location.hostname + ')',
            exportFilename: 'open-links-new-tab_active-sites.txt',
            getItems: getActiveSites,
            saveItems: saveActiveSites,
            normalize: raw => raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0],
            currentValue: () => location.hostname.toLowerCase()
        });
        sitesSection.style.display = 'flex';

        const exceptionsSection = buildSection({
            description: 'Links matching these are NOT opened in a new tab — they open normally. Matches the link you click, by domain and optional path.',
            examples: 'Examples: mail.google.com, example.com/logout',
            placeholder: 'e.g. example.com/path',
            addCurrentLabel: '+ This Page',
            addCurrentTitle: 'Add the current page (' + location.hostname + location.pathname + ')',
            exportFilename: 'open-links-new-tab_link-exceptions.txt',
            getItems: getExceptions,
            saveItems: saveExceptions,
            normalize: raw => raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
            currentValue: () => (location.hostname + location.pathname).toLowerCase().replace(/\/$/, '')
        });
        exceptionsSection.style.display = 'none';

        const pageExceptionsSection = buildSection({
            description: 'Pages whose URL starts with one of these are left alone — the script goes dormant, so every link on that page reuses the current tab. Enter a URL prefix.',
            examples: 'Examples: https://www.youtube.com/watch?v=  ·  https://www.google.com/search',
            placeholder: 'e.g. https://www.youtube.com/watch?v=',
            addCurrentLabel: '+ This Page',
            addCurrentTitle: 'Add the current page URL (' + location.href + ')',
            exportFilename: 'open-links-new-tab_page-exceptions.txt',
            getItems: getPageExceptions,
            saveItems: savePageExceptions,
            normalize: raw => raw.trim(),
            currentValue: () => location.href
        });
        pageExceptionsSection.style.display = 'none';

        const tabPlacementSection = buildSection({
            description: 'New tabs opened from these sites appear next to the current tab instead of at the end of the tab bar. Enter a domain.',
            examples: 'Examples: reddit.com, youtube.com',
            placeholder: 'e.g. reddit.com',
            addCurrentLabel: '+ This Site',
            addCurrentTitle: 'Add the current site (' + location.hostname + ')',
            exportFilename: 'open-links-new-tab_tab-placement.txt',
            getItems: getInsertNextSites,
            saveItems: saveInsertNextSites,
            normalize: raw => raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0],
            currentValue: () => location.hostname.toLowerCase()
        });
        tabPlacementSection.style.display = 'none';

        const earlyCaptureSection = buildSection({
            description: 'Sites where this script grabs clicks one step earlier (at window level). Needed when a site shields its own click handling with stopPropagation, which otherwise kills the click before this script sees it. Added automatically when that is detected — remove an entry if it causes trouble.',
            examples: 'Examples: example.com, app.example.org',
            placeholder: 'e.g. example.com',
            addCurrentLabel: '+ This Site',
            addCurrentTitle: 'Add the current site (' + location.hostname + ')',
            exportFilename: 'open-links-new-tab_early-capture.txt',
            getItems: getEarlyCaptureSites,
            saveItems: saveEarlyCaptureSites,
            normalize: raw => raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0],
            currentValue: () => location.hostname.toLowerCase()
        });
        earlyCaptureSection.style.display = 'none';

        const tab0 = makeTab('Active Sites', 0);
        const tab1 = makeTab('Link Exceptions', 1);
        const tab2 = makeTab('Page Exceptions', 2);
        const tab3 = makeTab('Tab Placement', 3);
        const tab4 = makeTab('Early Capture', 4);
        tabBar.appendChild(tab0);
        tabBar.appendChild(tab1);
        tabBar.appendChild(tab2);
        tabBar.appendChild(tab3);
        tabBar.appendChild(tab4);

        const allTabs = [tab0, tab1, tab2, tab3, tab4];
        const allContents = [sitesSection, exceptionsSection, pageExceptionsSection, tabPlacementSection, earlyCaptureSection];

        allTabs.forEach((t, i) => t.addEventListener('click', () => setActiveTab(i, allTabs, allContents)));
        setActiveTab(0, allTabs, allContents);

        tabContents.appendChild(sitesSection);
        tabContents.appendChild(exceptionsSection);
        tabContents.appendChild(pageExceptionsSection);
        tabContents.appendChild(tabPlacementSection);
        tabContents.appendChild(earlyCaptureSection);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = `
            align-self: flex-end; padding: 6px 16px; border-radius: 6px; border: none;
            background: #45475a; color: #cdd6f4; font-weight: 600;
            font-size: 13px; cursor: pointer; margin-top: 4px;
        `;
        closeBtn.addEventListener('click', () => host.remove());

        panel.appendChild(tabBar);
        panel.appendChild(tabContents);
        panel.appendChild(closeBtn);
        document.documentElement.appendChild(host);
    }

    // ---------------- Diagnostics Panel ----------------
    // Answers "why did this link not open in a new tab?" without going near the
    // page console. Two halves: the live state of the script on this page, and
    // a replay of the decisions it actually made on recent link clicks.
    function openDiagnosticsPanel() {
        if (document.getElementById('gm-newtab-diagnostics')) return;

        const shell = createPanelShell('gm-newtab-diagnostics', 'Open Links in New Tab — Diagnostics', 560);
        const host = shell.host;
        const panel = shell.panel;

        const body = document.createElement('div');
        body.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding-right: 4px;';

        function heading(text) {
            const h = document.createElement('div');
            h.style.cssText = 'font-size: 13px; font-weight: 700; color: #cdd6f4; border-bottom: 1px solid #45475a; padding-bottom: 4px;';
            h.textContent = text;
            return h;
        }

        function statusRow(label, value, color) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; gap: 10px; font-size: 12px; line-height: 1.5;';
            const l = document.createElement('span');
            l.style.cssText = 'color: #9399b2; flex: 0 0 130px;';
            l.textContent = label;
            const v = document.createElement('span');
            v.style.cssText = `color: ${color || '#cdd6f4'}; word-break: break-all; flex: 1;`;
            v.textContent = value;
            row.appendChild(l);
            row.appendChild(v);
            return row;
        }

        // ---------- Status ----------
        const statusBox = document.createElement('div');
        statusBox.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';

        const logBox = document.createElement('div');
        logBox.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

        function reportLines() {
            const pageRule = matchedPageException();
            const siteRule = matchedActiveSite();
            const lines = [];
            lines.push('Open Links in New Tab v' + SCRIPT_VERSION + ' — diagnostics');
            lines.push('Page: ' + location.href);
            if (pageRule) {
                lines.push('State: DORMANT — Page Exceptions rule "' + pageRule + '" matches this URL');
            } else if (isEnabled()) {
                lines.push('State: ACTIVE — links open in a new tab');
            } else {
                lines.push('State: OFF in this tab — press Alt+N, or add this site under Active Sites');
            }
            lines.push('Active Sites match: ' + (siteRule || 'none — ' + location.hostname + ' is not listed'));
            lines.push('Page Exceptions match: ' + (pageRule || 'none'));
            lines.push('Tab placement: ' + (shouldInsertNext(location.href) ? 'next to this tab' : 'end of the tab bar'));
            lines.push('List sizes: ' + getActiveSites().length + ' active sites, ' + getExceptions().length +
                       ' link exceptions, ' + getPageExceptions().length + ' page exceptions, ' +
                       getInsertNextSites().length + ' tab-placement sites');
            lines.push('Click logging: ' + getDiagMode().toUpperCase());
            lines.push('Frame: ' + (window === window.top ? 'top-level document' : 'inside an iframe'));
            lines.push('Frames on this page: ' + frameReport());
            lines.push('Early capture: ' + (matchedEarlyCaptureSite() ? 'ON (rule "' + matchedEarlyCaptureSite() + '")' : 'off'));
            return { lines, pageRule, siteRule };
        }

        function renderStatus() {
            while (statusBox.firstChild) statusBox.removeChild(statusBox.firstChild);
            const info = reportLines();
            const pageRule = info.pageRule;
            const siteRule = info.siteRule;

            let stateText, stateColor;
            if (pageRule) {
                stateText = 'DORMANT — a Page Exceptions rule matches this URL';
                stateColor = '#f38ba8';
            } else if (isEnabled()) {
                stateText = 'ACTIVE — links should open in a new tab';
                stateColor = '#a6e3a1';
            } else {
                stateText = 'OFF in this tab — press Alt+N, or add this site under Active Sites';
                stateColor = '#f38ba8';
            }

            statusBox.appendChild(statusRow('Script state', stateText, stateColor));
            statusBox.appendChild(statusRow('Version', SCRIPT_VERSION));
            statusBox.appendChild(statusRow('This page', location.href));
            statusBox.appendChild(statusRow('Hostname', location.hostname));
            statusBox.appendChild(statusRow('Active Sites rule',
                siteRule || 'none matched — this hostname is not in the list',
                siteRule ? '#a6e3a1' : '#f9e2af'));
            statusBox.appendChild(statusRow('Page Exceptions rule',
                pageRule || 'none matched',
                pageRule ? '#f38ba8' : '#cdd6f4'));
            statusBox.appendChild(statusRow('Tab placement',
                shouldInsertNext(location.href) ? 'next to this tab' : 'end of the tab bar'));
            const frames = frameReport();
            statusBox.appendChild(statusRow('Frames on page', frames,
                /NOT running|cannot inspect/.test(frames) ? '#f9e2af' : '#cdd6f4'));
            const earlyRule = matchedEarlyCaptureSite();
            statusBox.appendChild(statusRow('Early capture',
                earlyRule ? 'ON — intercepting at window level (rule "' + earlyRule + '")' : 'off — intercepting at document level',
                earlyRule ? '#a6e3a1' : '#cdd6f4'));
            statusBox.appendChild(statusRow('List sizes',
                getActiveSites().length + ' active · ' + getExceptions().length + ' link exc · ' +
                getPageExceptions().length + ' page exc · ' + getInsertNextSites().length + ' placement'));
        }

        // ---------- Click log ----------
        function renderLog() {
            while (logBox.firstChild) logBox.removeChild(logBox.firstChild);
            const entries = getDiagLog();

            const mode = getDiagMode();
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
            if (mode === 'deep') {
                hint.textContent = 'Logging is DEEP: every left-click is recorded, including clicks this script never sees. Click the link that misbehaves, then reopen this panel. Press the "Logging: DEEP" button below once more to switch it back off.';
            } else if (mode === 'on') {
                hint.textContent = 'Logging is ON: link clicks this script handles are recorded, and the entry survives navigating away. If a click records nothing at all, press the "Logging: ON" button below once to reach DEEP, which also records the clicks it never sees.';
            } else {
                hint.textContent = 'Logging is OFF. The button below cycles OFF → ON → DEEP → OFF: press it once for ON (clicks this script handles), twice for DEEP (also the clicks it never sees). Then click the link that misbehaves and reopen this panel.';
            }
            logBox.appendChild(hint);

            const caveat = document.createElement('div');
            caveat.style.cssText = 'font-size: 12px; color: #6c7086; font-style: italic; line-height: 1.45;';
            caveat.textContent = mode === 'deep'
                ? 'Still nothing after clicking a link in DEEP mode? Then the click is not happening in this document. Check "Frames on page" above — a link inside an iframe is invisible here. If there are no frames, the script is not running on this page at all: confirm the N indicator appears.'
                : 'No entry at all for a click means it never reached this script. DEEP mode identifies which of the causes it is.';
            logBox.appendChild(caveat);

            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: #6c7086; font-size: 13px; text-align: center; padding: 12px 0;';
                empty.textContent = 'No clicks logged yet.';
                logBox.appendChild(empty);
                return;
            }

            entries.forEach(entry => {
                const row = document.createElement('div');
                row.style.cssText = 'background: #313244; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px;';

                const top = document.createElement('div');
                top.style.cssText = 'display: flex; gap: 8px; align-items: center;';

                const badges = {
                    'new-tab':     { label: 'NEW TAB',     color: '#a6e3a1' },
                    'same-tab':    { label: 'SAME TAB',    color: '#f9e2af' },
                    'not-handled': { label: 'NOT HANDLED', color: '#f38ba8' },
                    'probe':       { label: 'NEVER SEEN',  color: '#cba6f7' }
                };
                const badgeInfo = badges[entry.action] || badges['not-handled'];
                const badge = document.createElement('span');
                badge.textContent = badgeInfo.label;
                badge.style.cssText = `
                    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
                    background: ${badgeInfo.color}; color: #1e1e2e; flex-shrink: 0;
                `;

                const when = document.createElement('span');
                when.style.cssText = 'font-size: 11px; color: #6c7086; flex-shrink: 0;';
                when.textContent = new Date(entry.t).toLocaleTimeString();

                const text = document.createElement('span');
                text.style.cssText = 'font-size: 12px; color: #cdd6f4; font-weight: 600; word-break: break-all;';
                text.textContent = entry.text ? '“' + entry.text + '”' : '(no link text)';

                top.appendChild(badge);
                top.appendChild(when);
                top.appendChild(text);
                row.appendChild(top);

                const reason = document.createElement('div');
                reason.style.cssText = 'font-size: 12px; color: #f9e2af; line-height: 1.4;';
                reason.textContent = entry.reason + (entry.rule ? ' — ' + entry.rule : '');
                row.appendChild(reason);

                const href = document.createElement('div');
                href.style.cssText = 'font-size: 11px; color: #9399b2; word-break: break-all;';
                href.textContent = entry.href;
                row.appendChild(href);

                if (entry.page && entry.page !== entry.href) {
                    const from = document.createElement('div');
                    from.style.cssText = 'font-size: 11px; color: #6c7086; word-break: break-all;';
                    from.textContent = 'clicked on: ' + entry.page;
                    row.appendChild(from);
                }

                logBox.appendChild(row);
            });
        }

        // ---------- Controls ----------
        const controls = document.createElement('div');
        controls.style.cssText = 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap; border-top: 1px solid #45475a; padding-top: 10px;';

        // The panel's own way to turn the script on. Alt+N reaches the page
        // through the keyboard, so a site that captures keydown at window level
        // can eat it — leaving the panel telling you to press a key that does
        // nothing. This button goes through no page code at all.
        const stateToggle = makeButton('', '#89b4fa');
        function paintStateToggle() {
            const on = isEnabled();
            stateToggle.textContent = on ? 'Script: ON' : 'Script: OFF — turn on';
            stateToggle.style.background = on ? '#a6e3a1' : '#f38ba8';
            stateToggle.style.color = '#1e1e2e';
        }
        stateToggle.title = 'Toggle the script for this tab (same as Alt+N)';
        stateToggle.addEventListener('click', () => {
            toggleEnabled();
            paintStateToggle();
            renderStatus();
        });

        const logToggle = makeButton('', '#89b4fa');
        function paintToggle() {
            const mode = getDiagMode();
            logToggle.textContent = mode === 'deep' ? 'Logging: DEEP' : (mode === 'on' ? 'Logging: ON' : 'Logging: OFF');
            logToggle.style.background = mode === 'deep' ? '#cba6f7' : (mode === 'on' ? '#a6e3a1' : '#585b70');
            logToggle.style.color = mode === 'off' ? '#cdd6f4' : '#1e1e2e';
        }
        paintToggle();
        logToggle.title = 'OFF → ON (link clicks the script handles) → DEEP (also the clicks it never sees)';
        logToggle.addEventListener('click', () => {
            const next = { off: 'on', on: 'deep', deep: 'off' };
            setDiagMode(next[getDiagMode()]);
            paintToggle();
            renderLog();
        });

        const refreshBtn = makeButton('Refresh', '#89b4fa');
        refreshBtn.addEventListener('click', () => { paintStateToggle(); renderStatus(); renderLog(); });

        const clearBtn = makeButton('Clear log', '#f38ba8');
        clearBtn.addEventListener('click', () => { clearDiagLog(); renderLog(); });

        const copyBtn = makeButton('Copy report', '#fab387');
        const copyStatus = document.createElement('span');
        copyStatus.style.cssText = 'font-size: 12px; color: #a6e3a1;';

        // The report is plain text so it can be pasted straight into a bug
        // report. clipboard.writeText is blocked on some pages (permissions
        // policy, insecure origin), so fall back to a selectable textarea
        // rather than failing silently.
        const fallbackArea = document.createElement('textarea');
        fallbackArea.style.cssText = `
            display: none; width: 100%; height: 140px; margin-top: 8px;
            background: #11111b; color: #cdd6f4; border: 1px solid #45475a;
            border-radius: 6px; padding: 8px; font-size: 11px;
            font-family: ui-monospace, monospace; resize: vertical;
        `;
        fallbackArea.readOnly = true;

        function buildReport() {
            const out = reportLines().lines.slice();
            out.push('');
            out.push('Recent link clicks (newest first):');
            const entries = getDiagLog();
            if (entries.length === 0) {
                out.push('  (none logged)');
            } else {
                entries.forEach(entry => {
                    out.push('  [' + new Date(entry.t).toLocaleTimeString() + '] ' + entry.action.toUpperCase() +
                             ' — ' + entry.reason + (entry.rule ? ' — ' + entry.rule : ''));
                    out.push('      text: ' + (entry.text || '(none)'));
                    out.push('      href: ' + entry.href);
                    out.push('      page: ' + entry.page);
                });
            }
            return out.join('\n');
        }

        copyBtn.addEventListener('click', async () => {
            const report = buildReport();
            try {
                await navigator.clipboard.writeText(report);
                copyStatus.style.color = '#a6e3a1';
                copyStatus.textContent = 'Copied.';
                setTimeout(() => { copyStatus.textContent = ''; }, 3000);
            } catch (_) {
                fallbackArea.value = report;
                fallbackArea.style.display = 'block';
                fallbackArea.focus();
                fallbackArea.select();
                copyStatus.style.color = '#f9e2af';
                copyStatus.textContent = 'Clipboard blocked — select and copy below.';
            }
        });

        const settingsBtn = makeButton('Settings…', '#585b70', '#cdd6f4');
        settingsBtn.addEventListener('click', () => { host.remove(); openSettingsPanel(); });

        const closeBtn = makeButton('Close', '#45475a', '#cdd6f4');
        closeBtn.addEventListener('click', () => { diagnosticsRefresh = null; host.remove(); });

        controls.appendChild(stateToggle);
        controls.appendChild(logToggle);
        controls.appendChild(refreshBtn);
        controls.appendChild(clearBtn);
        controls.appendChild(copyBtn);
        controls.appendChild(settingsBtn);
        controls.appendChild(closeBtn);
        controls.appendChild(copyStatus);

        paintStateToggle();
        renderStatus();
        renderLog();
        // Lets the pageshow handler below repaint this panel after a
        // back/forward restore, when the stored log it is showing may be stale.
        diagnosticsRefresh = () => {
            if (!document.getElementById('gm-newtab-diagnostics')) return;
            paintStateToggle();
            renderStatus();
            renderLog();
        };

        body.appendChild(heading('This page'));
        body.appendChild(statusBox);
        body.appendChild(heading('Recent link clicks'));
        body.appendChild(logBox);

        panel.appendChild(body);
        panel.appendChild(controls);
        panel.appendChild(fallbackArea);
        document.documentElement.appendChild(host);
    }

    GM_registerMenuCommand('Settings', openSettingsPanel);
    GM_registerMenuCommand('Diagnose this page', openDiagnosticsPanel);
    // Last resort when Alt+N cannot reach the page at all: the Tampermonkey
    // menu runs outside the document, so no site listener can intercept it.
    GM_registerMenuCommand('Toggle ON/OFF for this tab', () => { toggleEnabled(); });

  // ---------------- Insert Next-To-Parent ----------------
  // Domains whose new tabs open next to the parent are now managed in the
  // "Tab Placement" settings tab (see getInsertNextSites / shouldInsertNext).

    const DOWNLOAD_EXTENSIONS = [
        '.zip', '.rar', '.7z', '.exe', '.msi',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.ppt', '.pptx', '.csv', '.txt',
        '.jpg', '.jpeg', '.png', '.gif', '.webp',
        '.mp3', '.mp4', '.mkv', '.avi'
    ];

    let indicator = null;
    let indicatorCircle = null;
    let debounceTimer = null;

    function isEnabled() {
        return sessionStorage.getItem(STORAGE_KEY) === 'true';
    }

    function setEnabled(value) {
        sessionStorage.setItem(STORAGE_KEY, value);
        safeUpdateIndicator();
    }

    function toggleEnabled() {
        setEnabled(!isEnabled());
    }

    // Returns the Active Sites entry that covers this page, or null. The
    // diagnostics panel shows the matching rule rather than a bare yes/no,
    // because the usual failure is a near-miss: "www.example.com" listed
    // while you're on "example.com".
    function matchedActiveSite() {
        const hostname = location.hostname.toLowerCase();
        return getActiveSites().find(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        ) || null;
    }

    function checkDefaultEnabled() {
        const isDefaultSite = matchedActiveSite() !== null;
        if (isDefaultSite) {
            setEnabled(true); // Force ON for active sites — every time
        }
        // Non-active sites start OFF unless manually toggled in this tab
    }

    function isSamePageAnchor(link) {
        const raw = link.getAttribute('href') || '';
        if (raw === '#' || raw.endsWith('/#') || link.href.endsWith('#')) return true;
        return link.hash &&
            link.origin === location.origin &&
            link.pathname === location.pathname;
    }

    // Each of these returns the rule that matched (a string, for diagnostics)
    // or null. The click handler only cares whether the result is truthy, so
    // behaviour is unchanged; the panel gets to name the culprit.
    function downloadReason(link) {
        if (link.hasAttribute('download')) return 'the <a> carries a download attribute';
        const ext = DOWNLOAD_EXTENSIONS.find(x => link.pathname.toLowerCase().endsWith(x));
        return ext ? 'path ends in ' + ext : null;
    }

    function looksLikeDownload(link) {
        return downloadReason(link) !== null;
    }

    function nextPageReason(link) {
        if (link.textContent) {
            // Collapse whitespace: nested markup (a <span> inside the <a>)
            // puts newlines and indentation in textContent, so a bare trim()
            // leaves "\n  Next\n" unmatched.
            const text = link.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
            const validTexts = new Set([
                'next', 'more', 'older', 'previous', 'prev',
                'next page', 'previous page', 'older posts', 'newer posts',
                'read more', 'load more posts', 'go to next page',
                'view older posts', 'continue reading', 'next article',
                'next ›', 'previous ›', 'next →', 'previous →',
                'next >>', 'previous >>', '›', '→', '>>', '»',
                'prev ‹', 'previous ‹', '‹', '←', '<<', '«',
                'new', 'best', 'hot', 'top', 'rising', 'comments',
                // Sort-order controls in a pagination bar, same family as the
                // line above: they re-render the current listing, not content.
                'newest', 'oldest', 'latest', 'recent', 'popular', 'trending',
                'active', 'unanswered', 'first', 'last',
                // Page-range ellipsis between number groups (…  2 3 4 … 11948)
                '…', '...',
                'reply',
                'show more related videos',
                'refresh'
            ]);
            if (validTexts.has(text)) return 'link text "' + text + '" is in the pagination/sort-control word list';
            if (text.includes('more repl') || text.includes('more comment')) return 'link text contains "more replies"/"more comments"';
        }

        if (link.href) {
            const url = link.href.toLowerCase();
            // Path rules must be tested against the PATH, not the full href —
            // their `$` anchor can never match when a query string or hash
            // follows the page number (…/page/3/?s=searchterm, …/new/2#top).
            const path = (link.pathname || '').toLowerCase();

            if (/[?&](page|paged|p|pg|start|offset)=\d+(?:[&#]|$)/.test(url)) return 'query string carries a page number (?page=N / ?p=N / ?offset=N …)';
            if (/[?&][^=]*-page=\d+(?:[&#]|$)/.test(url)) return 'query string carries a prefixed page number (?something-page=N)';
            if (/\/(page|p)\/\d+\/?$/.test(path)) return 'path ends in /page/N';
            // page2 / page-2 / page_2 / page2.html — the separator between the
            // word and the number is optional, and sites use all three forms.
            if (/\bpage[-_]?\d+(\.\w+)?\/?$/.test(path)) return 'path ends in pageN / page-N / page_N';
            if (/\/portal\/\d+\/?$/.test(path)) return 'path ends in /portal/N';
            // Sort/feed segment followed by a number is always pagination —
            // …/new/2, …/top/3, …/hot/2. These words are sort orders, never
            // content slugs, so the trailing number can't be a content id.
            if (/\/(new|newest|latest|recent|top|hot|best|rising|popular|trending|all|active|unanswered)\/\d+\/?$/.test(path)) return 'path ends in a sort word followed by a number (…/new/2, …/top/3)';
            // A URL ending in a bare number is ambiguous — it can be a page
            // (…/blog/2) or a content id (…/mods/232). Disambiguate with the
            // link's own text instead of any site-specific list: a real
            // pagination control is *labelled with the page number*, so treat
            // it as pagination only when the visible text equals that trailing
            // number. A content link is labelled with a title, so it won't
            // match and will open in a new tab. (Word controls like "Next"/"›"
            // are already handled by the text list above.)
            // Whitespace is collapsed first — nested markup puts newlines and
            // indentation inside the anchor, so a raw trim() misses "\n  2\n".
            // "Page 2" counts too; it's still a number-labelled control.
            const numericEndMatch = path.match(/\/(\d+)\/?$/);
            if (numericEndMatch) {
                const label = (link.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (label === numericEndMatch[1] || label === 'page ' + numericEndMatch[1]) {
                    return 'path ends in /' + numericEndMatch[1] + ' and the link is labelled with that same number';
                }
            }
        }
        return null;
    }

    function matchedExceptionRule(link) {
        if (!link.href) return null;
        const url = link.href.toLowerCase();
        const hostname = link.hostname.toLowerCase();
        const path = link.pathname.toLowerCase();

        // Always-on suffix exceptions: links ending in these open normally.
        // e.g. Steam discussion pagination: …/?ctp=3 or …/?fp=2 (any page number).
        if (/\/\?(ctp|fp)=\d+$/.test(url)) return 'built-in rule: URL ends in ?ctp=N or ?fp=N';

        const rule = getExceptions().find(entry => {
            const r = entry.toLowerCase();
            const [ruleDomain, ...rulePathParts] = r.split('/');
            const rulePath = '/' + rulePathParts.join('/');
            if (hostname !== ruleDomain && !hostname.endsWith('.' + ruleDomain)) return false;
            if (rulePath !== '/' && !path.includes(rulePath)) return false;
            return true;
        });
        return rule ? 'Link Exceptions entry "' + rule + '"' : null;
    }

    function isExceptionLink(link) {
        return matchedExceptionRule(link) !== null;
    }

 /*   // NEW: Reddit "More replies / more comments" expanders
    if (hostname.includes('reddit.com')) {
        const text = link.textContent.trim().toLowerCase();
        if (
            text.includes('more repl') ||
            text.includes('more comment') ||
            link.classList.contains('morecomments') ||
            link.closest('.morecomments')
        ) return true;
    }*/

  function shouldInsertNext(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return getInsertNextSites().some(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        );
    } catch (_) {
        return false;
    }
}

    function matchedPageException() {
        const href = location.href.toLowerCase();
        return getPageExceptions().find(prefix => {
            const p = prefix.trim().toLowerCase();
            return p && href.startsWith(p);
        }) || null;
    }

    function isPageExcepted() {
        return matchedPageException() !== null;
    }

    function createIndicator() {
        const svgNS = 'http://www.w3.org/2000/svg';
        indicator = document.createElement('div');
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 14 14');

        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('cx', '7');
        circle.setAttribute('cy', '7');
        circle.setAttribute('r', '6');
        circle.setAttribute('fill', 'rgba(0,0,0,0.85)');
        indicatorCircle = circle;

        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', '7');
        text.setAttribute('y', '9.5');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '9');
        text.setAttribute('font-weight', '600');
        text.setAttribute('fill', 'blue');
        text.setAttribute('font-family', 'system-ui, sans-serif');
        text.textContent = 'N';

        svg.appendChild(circle);
        svg.appendChild(text);
        indicator.appendChild(svg);

        indicator.style.cssText = `
            all: initial;
            position: fixed;
            top: 0;
            left: 0;
            width: 14px;
            height: 14px;
            z-index: 2147483647;
            pointer-events: none;
        `;
        document.documentElement.appendChild(indicator);
    }

    function updateIndicator() {
        // Recreate if the node was never made OR was torn out of the DOM.
        // Sites that render the whole <html> with a framework (e.g. Nexus Mods
        // hydrates the full document with React) discard the indicator we
        // injected at document-end; re-add it once the framework has settled.
        if (!indicator || !indicator.isConnected) createIndicator();
        indicator.style.display = isEnabled() ? 'block' : 'none';
        // Amber ring = click logging is on. Logging writes to GM storage on
        // every link click, so it needs to be visible rather than something
        // you leave running for weeks by accident.
        if (indicatorCircle) {
            const mode = getDiagMode();
            const ring = mode === 'deep' ? '#cba6f7' : (mode === 'on' ? '#fab387' : null);
            indicatorCircle.setAttribute('stroke', ring || 'none');
            indicatorCircle.setAttribute('stroke-width', ring ? '2' : '0');
        }
    }

    function safeUpdateIndicator() {
        try {
            updateIndicator();
        } catch (_) {
            indicator = null;
        }
    }

    function removeBlankTargets() {
        // Only take over target="_blank" links when the script is actually
        // active on this page. When it's off (or the page is excepted), leave
        // the page's native new-window links alone — otherwise stripping the
        // target makes them open in the same tab even though the click handler
        // below never fires to reopen them in a new one.
        if (!isEnabled() || isPageExcepted()) return;
        document.querySelectorAll('a[target="_blank"]').forEach(link => {
            if (!isExceptionLink(link)) {
                link.removeAttribute('target');
            }
        });
    }

    function debouncedRemove() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(removeBlankTargets, 300);
    }

    // ---------------- Init ----------------
    safeUpdateIndicator();
    checkDefaultEnabled(); // This will force-enable on default sites

    // On full-document frameworks the indicator we just injected gets discarded
    // during hydration; re-check a few times after load so it comes back once
    // the framework has finished rendering.
    [400, 1200, 3000].forEach(t => setTimeout(safeUpdateIndicator, t));

    // Bound on `window`, in capture, for the same reason clicks are (v1.19.0):
    // the capture path reaches window before document, so a site with a
    // window-level keydown listener that calls stopPropagation() would keep a
    // document-level shortcut from ever firing. That failure is silent and
    // total — Alt+N simply does nothing, on every page of that site.
    //
    // The Alt state comes from e.altKey on the KeyN event itself, not from a
    // latch set by a previous Alt keydown. The latch broke whenever the script
    // never saw that keydown: the page swallowed it, the browser consumed it
    // for the menu bar, or the tab was focused with Alt already held.
    window.addEventListener('keydown', e => {
        if (!e.altKey || e.code !== 'KeyN') return;
        if (e.ctrlKey || e.metaKey) return;
        if (isOwnUI(e)) return;   // typing in this script's own panels
        toggleEnabled();
        e.preventDefault();
    }, true);

    const blankObserver = new MutationObserver(() => {
        debouncedRemove();
        // Re-add the indicator if a framework re-render tore it out.
        if (!indicator || !indicator.isConnected) safeUpdateIndicator();
    });
    if (document.body) {
        blankObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            blankObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        });
    }
    removeBlankTargets();
 
function openInNewTab(url) {
    const insertNext = shouldInsertNext(url);

    try {
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(url, {
                active: false,        // background
                insert: insertNext,   // true = next to parent, false = end of tab bar
                setParent: insertNext // Firefox: with no opener set, the tab goes to the end
            });
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    } catch (_) {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

    // Every gate lives in one function so the diagnostics log and the live
    // behaviour can never drift apart: the panel reports the exact branch the
    // handler took, not a second implementation of the same rules.
    // Order matches the original handler, so the first match is the real reason.
    function classifyClick(e, link) {
        const pageRule = matchedPageException();
        if (pageRule) {
            return { action: 'not-handled', reason: 'Script is dormant on this page (Page Exceptions)', rule: pageRule };
        }
        if (!isEnabled()) {
            return {
                action: 'not-handled',
                reason: 'Script is OFF in this tab',
                rule: matchedActiveSite()
                    ? 'this site IS in Active Sites — press Alt+N, or reload the page'
                    : location.hostname + ' is not in Active Sites; press Alt+N or add it'
            };
        }
        if (e.defaultPrevented) {
            return { action: 'not-handled', reason: 'Another listener called preventDefault() before this script saw the click', rule: 'a site script or another userscript handled it first' };
        }
        if (e.shiftKey || e.altKey) {
            return { action: 'not-handled', reason: 'Shift or Alt was held, so the script stays out of the way' };
        }

        const exceptionRule = matchedExceptionRule(link);
        if (exceptionRule) {
            return { action: 'not-handled', reason: 'Link Exceptions rule matched', rule: exceptionRule };
        }
        if (!link.href || link.href.startsWith('javascript:')) {
            return { action: 'not-handled', reason: 'No usable href (empty or javascript:)' };
        }
        if (isSamePageAnchor(link)) {
            return { action: 'not-handled', reason: 'Anchor pointing at this same page' };
        }
        const download = downloadReason(link);
        if (download) {
            return { action: 'not-handled', reason: 'Looks like a download', rule: download };
        }
        const pagination = nextPageReason(link);
        if (pagination) {
            return { action: 'not-handled', reason: 'Treated as a pagination / sort control, which should reuse the tab', rule: pagination };
        }
        if (e.ctrlKey || e.metaKey) {
            return { action: 'same-tab', reason: 'Ctrl/Cmd was held, which inverts the behaviour' };
        }
        return { action: 'new-tab', reason: 'Opened in a background tab' };
    }

    // Registered on window, in capture: it runs ahead of every document-level
    // listener, including this script's own, so it observes clicks that never
    // make it as far as the handler below.
    // Back/forward restores this page from the bfcache with its JavaScript heap
    // intact, and the userscript manager's in-page copy of GM storage comes back
    // with it — holding whatever the log looked like before we navigated away.
    // So a log cleared on another page reappears here, and Refresh re-reads the
    // same stale copy. Nothing can force a resync, but it does settle shortly;
    // repaint a few times so the panel converges on the real stored log.
    window.addEventListener('pageshow', e => {
        if (!e.persisted || !diagnosticsRefresh) return;
        [0, 300, 1000, 2500].forEach(delay => setTimeout(() => {
            if (diagnosticsRefresh) diagnosticsRefresh();
        }, delay));
    });

    window.addEventListener('click', probeClick, true);
    window.addEventListener('mousedown', probeMousedown, true);
    markProbeAlive();

    // Shared by both entry points so the two can never drift apart.
    function actOnClick(e, link) {
        let verdict;
        try {
            verdict = classifyClick(e, link);
        } catch (err) {
            // A throw here would otherwise be indistinguishable from silence,
            // and on a page full of extension noise the console is no help.
            if (isDiagLogging()) {
                appendDiagEntry({
                    t: Date.now(),
                    page: truncate(location.href, 300),
                    href: truncate(link.href || '', 300),
                    text: truncate((link.textContent || '').replace(/\s+/g, ' ').trim(), 80),
                    action: 'probe',
                    reason: 'The handler threw while classifying this link, so the click fell through to the page',
                    rule: String((err && err.message) || err)
                });
                loggedEvents.add(e);
            }
            return;
        }

        if (isDiagLogging()) {
            recordDiagEntry(link, verdict);
            loggedEvents.add(e); // tells the probe this click is accounted for
        }

        if (verdict.action === 'not-handled') return;

        e.preventDefault();
        e.stopPropagation();
        if (verdict.action === 'same-tab') {
            window.location.href = link.href;
        } else {
            openInNewTab(link.href);
        }
    }

    // Early capture: same decision, made one node earlier. Only for sites on
    // the Early Capture list, because running this early everywhere would put
    // this script ahead of other scripts' click modes. Registered after the
    // probe above so the probe still records the click first.
    window.addEventListener('click', e => {
        if (e.button !== 0) return;
        if (!matchedEarlyCaptureSite()) return;
        if (isOwnUI(e)) return;

        const link = e.target.closest('a[href]');
        if (!link) return;

        actOnClick(e, link);
    }, true);

    // A bare witness on document/capture, registered before the real handler
    // and doing nothing but recording that the event got this far. Without it,
    // "the handler produced no entry" is ambiguous: stopped propagation and a
    // handler that threw look identical. This tells them apart.
    document.addEventListener('click', e => { docSeenEvents.add(e); }, true);

    // The normal path. On early-capture sites the window listener above has
    // already handled and stopped the event, so this never sees it.
    document.addEventListener('click', e => {
        if (e.button !== 0) return;

        const link = e.target.closest('a[href]');
        if (!link) return;

        actOnClick(e, link);
    }, true);

})();