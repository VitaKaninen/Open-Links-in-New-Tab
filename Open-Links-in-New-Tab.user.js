// ==UserScript==
// @name        Open Links in New Tab
// @namespace   https://github.com/VitaKaninen
// @version     1.8.0
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
    if (window !== window.top) return;
    const STORAGE_KEY = 'forceNewTabEnabled';
    const SITES_KEY = 'activeSites';
    const EXCEPTIONS_KEY = 'linkExceptions';
    const PAGE_EXCEPTIONS_KEY = 'pageExceptions';
    const INSERT_NEXT_KEY = 'insertNextSites';

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

    // ---------------- Settings Panel ----------------
    function openSettingsPanel() {
        if (document.getElementById('gm-newtab-settings')) return;

        // Host element + Shadow DOM so the host page's CSS can't cascade into
        // the panel. Page selectors (div/button/input/* rules, inherited props)
        // don't cross the shadow boundary, so the UI renders consistently
        // regardless of which site it's opened on.
        const host = document.createElement('div');
        host.id = 'gm-newtab-settings';
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
            padding: 20px 24px; width: 420px; max-height: 80vh;
            display: flex; flex-direction: column; gap: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 700; color: #89b4fa;';
        title.textContent = 'Open Links in New Tab — Settings';

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

            function renderList() {
                while (list.firstChild) list.removeChild(list.firstChild);
                const items = cfg.getItems();
                if (items.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'color: #6c7086; font-size: 13px; text-align: center; padding: 12px 0;';
                    empty.textContent = 'No entries yet.';
                    list.appendChild(empty);
                    return;
                }
                items.forEach((item, i) => {
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
                        const updated = cfg.getItems().filter((_, j) => j !== i);
                        cfg.saveItems(updated);
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
                cfg.saveItems(items);
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
                const items = cfg.getItems();
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
                        cfg.saveItems(merged);
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

        const tab0 = makeTab('Active Sites', 0);
        const tab1 = makeTab('Link Exceptions', 1);
        const tab2 = makeTab('Page Exceptions', 2);
        const tab3 = makeTab('Tab Placement', 3);
        tabBar.appendChild(tab0);
        tabBar.appendChild(tab1);
        tabBar.appendChild(tab2);
        tabBar.appendChild(tab3);

        const allTabs = [tab0, tab1, tab2, tab3];
        const allContents = [sitesSection, exceptionsSection, pageExceptionsSection, tabPlacementSection];

        allTabs.forEach((t, i) => t.addEventListener('click', () => setActiveTab(i, allTabs, allContents)));
        setActiveTab(0, allTabs, allContents);

        tabContents.appendChild(sitesSection);
        tabContents.appendChild(exceptionsSection);
        tabContents.appendChild(pageExceptionsSection);
        tabContents.appendChild(tabPlacementSection);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = `
            align-self: flex-end; padding: 6px 16px; border-radius: 6px; border: none;
            background: #45475a; color: #cdd6f4; font-weight: 600;
            font-size: 13px; cursor: pointer; margin-top: 4px;
        `;
        closeBtn.addEventListener('click', () => host.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) host.remove(); });

        panel.appendChild(title);
        panel.appendChild(tabBar);
        panel.appendChild(tabContents);
        panel.appendChild(closeBtn);
        overlay.appendChild(panel);
        root.appendChild(overlay);
        document.documentElement.appendChild(host);
    }

    GM_registerMenuCommand('Settings', openSettingsPanel);
	// GM_registerMenuCommand('Toggle for this tab', () => { toggleEnabled(); });

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

    function checkDefaultEnabled() {
        const hostname = location.hostname.toLowerCase();
        const isDefaultSite = getActiveSites().some(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        );
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

    function looksLikeDownload(link) {
        if (link.hasAttribute('download')) return true;
        return DOWNLOAD_EXTENSIONS.some(ext =>
            link.pathname.toLowerCase().endsWith(ext)
        );
    }

    function isNextPageLink(link) {
        if (link.textContent) {
            const text = link.textContent.trim().toLowerCase();
            const validTexts = new Set([
                'next', 'more', 'older', 'previous',
                'next page', 'previous page', 'older posts', 'newer posts',
                'read more', 'load more posts', 'go to next page',
                'view older posts', 'continue reading', 'next article',
                'next ›', 'previous ›', 'next →', 'previous →',
                'next >>', 'previous >>', '›', '→', '>>', '»',
                'new', 'best', 'hot', 'top', 'rising', 'comments',
                'reply',
                'show more related videos',
                'refresh'
            ]);
            if (validTexts.has(text)) return true;
            if (text.includes('more repl') || text.includes('more comment')) return true;
        }

        if (link.href) {
            const url = link.href.toLowerCase();
            if (/[?&](page|paged|p|pg|start|offset)=\d+(?:[&#]|$)/.test(url)) return true;
            if (/\/(page|p)\/\d+\/?$/.test(url)) return true;
            if (/[?&][^=]*-page=\d+(?:[&#]|$)/.test(url)) return true;
            if (/\bpage\d+(\.\w+)?\/?$/.test(url)) return true;
            if (/\/portal\/\d+\/?$/.test(url)) return true;
            const numericEndMatch = url.match(/\/(\d+)\/?$/);
            if (numericEndMatch) {
                const pageNum = parseInt(numericEndMatch[1], 10);
                if (!isNaN(pageNum) && pageNum <= 999) return true;
            }
        }
        return false;
    }

    function isExceptionLink(link) {
        if (!link.href) return false;
        const url = link.href.toLowerCase();
        const hostname = link.hostname.toLowerCase();
        const path = link.pathname.toLowerCase();

        // Always-on suffix exceptions: links ending in these open normally.
        // e.g. Steam discussion pagination: …/?ctp=3 or …/?fp=2 (any page number).
        if (/\/\?(ctp|fp)=\d+$/.test(url)) return true;

        return getExceptions().some(rule => {
            const r = rule.toLowerCase();
            const [ruleDomain, ...rulePathParts] = r.split('/');
            const rulePath = '/' + rulePathParts.join('/');
            if (hostname !== ruleDomain && !hostname.endsWith('.' + ruleDomain)) return false;
            if (rulePath !== '/' && !path.includes(rulePath)) return false;
            return true;
        });
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

    function isPageExcepted() {
        const href = location.href.toLowerCase();
        return getPageExceptions().some(prefix => {
            const p = prefix.trim().toLowerCase();
            return p && href.startsWith(p);
        });
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
        circle.setAttribute('r', '7');
        circle.setAttribute('fill', 'rgba(0,0,0,0.85)');

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
        if (!indicator) createIndicator();
        indicator.style.display = isEnabled() ? 'block' : 'none';
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

	let altDown = false;
    document.addEventListener('keydown', e => {
        if (e.key === 'Alt') altDown = true;
        if (altDown && e.code === 'KeyN') {
            toggleEnabled();
            e.preventDefault();
        }
    }, true);
    document.addEventListener('keyup', e => {
        if (e.key === 'Alt') altDown = false;
    }, true);
    window.addEventListener('blur', () => { altDown = false; }, true);

    const blankObserver = new MutationObserver(debouncedRemove);
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

    document.addEventListener('click', e => {
        if (isPageExcepted()) return;   // page in the "Page Exceptions" list — script stays dormant here
        if (!isEnabled()) return;
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.shiftKey || e.altKey) return;

        const link = e.target.closest('a[href]');
        if (!link) return;

        if (isExceptionLink(link)) return;
        if (!link.href || link.href.startsWith('javascript:')) return;
        if (isSamePageAnchor(link)) return;
        if (looksLikeDownload(link)) return;
        if (isNextPageLink(link)) return;

        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = link.href;
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        openInNewTab(link.href);
    }, true);

})();