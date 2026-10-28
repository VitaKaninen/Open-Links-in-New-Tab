# Open Links in New Tab — project notes

Inherits the shared rules in `../CLAUDE.md` (version bumps, commit + push, click-collision
and Trusted Types rules). Only what is specific to this script lives here.

## Early capture cuts both ways — honour the click claim (v1.24.0)

`classifyClick` has a gate, right after the `defaultPrevented` one: if `<html>` carries a fresh
`data-userscript-click-claim`, another userscript declared during the **press** that the click is
theirs, and this script stands aside. `foreignClickClaim()` is the reader; the contract, and why a
timestamp rather than a flag, is in `../docs/CLICK_COLLISIONS.md`.

**This exists because v1.19.0's window-level early capture put this script ahead of a sibling's
modal click mode.** Hover Zoom's preview window is pointer-transparent, so it floats over a link
and the press that pins it is indistinguishable, at click time, from an ordinary link click — this
script opened the tab, called `preventDefault()`, and Hover Zoom never got its pin. Reported
2026-09-03 on imgur as "the click passes through", and it went away when this script was disabled.

It is a gate in `classifyClick`, not a short-circuit in the handlers, for the usual reason: the
diagnostics panel then *names* the reason instead of the click vanishing with no entry.

## `GM_openInTab`: send `insert` explicitly on every call — the docs lie about its default

Tampermonkey documents `insert` as: "An integer indicating the position at which the new tab
should be inserted in the tab strip. **The default is false**, which means the new tab will be
added to the end of the tab strip."

**That default is wrong.** Omitting `insert` opens the tab *next to its parent*, not at the end.

v1.22.0 dropped the key for non-placement sites on the strength of that sentence, and every site
started inserting next to the parent — noticed on YouTube, which is not in Tab Placement and has
no hardcoded handling anywhere in the script. v1.23.0 restored the explicit `insert: false` and
it stopped. So `insert: false` and no `insert` are **not** the same thing; always pass the
boolean both ways.

**In-order Tab Placement is unsolved; placement sites use `insert: true` (C B A order).** Goal
was A B C. A userscript cannot see the tab bar, so "after the last same-domain tab" is not
implementable. Failed in the user's browser — do not retry:
- omit `insert` + `setParent: true` (v1.33.0) → next to the parent (Tampermonkey's real default
  is `insert: true`).
- `insert: false` + `setParent: true` (v1.35.0) → end of the bar; the opener alone places nothing.
- synthetic ctrl-click on a hidden `target="_blank"` anchor (v1.37.0) → background, but end of
  the bar; the browser does not treat a script's click as a related tab.
- just-in-time `target="_blank"` on the real click: rejected by the user (foreground tab).
- The user's browser puts even a real middle-click at the end of the bar (2026-10-28), so no
  native path gives in-order placement there either. Closed.
The built-in browser pane cannot judge tab placement: it folds every new-tab link, even a trusted
`target="_blank"` click, into the current tab. Harness: `.claude/harness.html` + `launch.json`
(untracked).

`SCRIPT_VERSION` reads `GM_info.script.version`; never hardcode it again.

Type drift to watch: `insert` is documented as an integer today but historically took a boolean
meaning "right after the current tab". Booleans still behave as the boolean. Do not "modernise"
it to an index without testing in a real browser — an integer is an *absolute* tab-strip
position, not a relative one.

## Tab Placement matches the page you are ON, not the link's destination

The Tab Placement list means "new tabs opened **from** these sites". `matchedTabPlacementSite()`
therefore tests `location.hostname`, mirroring `matchedActiveSite()`.

Until v1.22.0 the opener tested the *destination* URL instead, so listing `reddit.com` placed a
reddit→reddit tab correctly but sent every outbound link to the end of the bar. The diagnostics
panel hid it for four versions because it asked `shouldInsertNext(location.href)` while the
opener asked `shouldInsertNext(url)` — two different questions behind one name. `shouldInsertNext()`
now takes no argument so the two cannot diverge again.

**General shape, worth remembering:** when the settings UI and the runtime disagree about *which*
URL a rule matches, the panel will happily report the feature working while it is not. If a
predicate can be asked about more than one URL, don't give it a URL parameter.

## The indicator's N is a path — never go back to `<text>`

A `<text>` N belongs to the page: any `svg text { font-size }` or `svg { width }` rule resizes it
(measured: box 14→32 px, N 9→20 px Impact), and even untouched its baseline sat 0.45–0.9 px high
depending on which font `system-ui` resolved to. The path is point-symmetric about the circle
centre (7,7), so it is centred by construction. Geometry is locked with inline `!important`; the
fills stay **presentation attributes** so Dark Reader can still recolour them (inline-style
`!important` fills would block that). `all: initial` on the `<svg>` also resets the inherited
`pointer-events`, so it is set again there — without it the badge eats clicks in the corner.

`safeUpdateIndicator`'s catch must **keep** the badge node. Nulling it, now that the observer
watches `<html>` (where the badge lives), makes each re-created badge trigger the observer again —
an endless loop that froze the tab in v1.27.0 whenever `updateIndicator` threw. The usual thrower
was `sessionStorage`, which raises `SecurityError` on sites with storage blocked; `isEnabled`/
`setEnabled` now fall back to an in-memory flag.

## Stripped `target="_blank"` is marked so it can be put back

`removeBlankTargets` tags each link it strips with `data-olint-stripped-target`, and
`setEnabled(false)` restores them; without that, turning the script off left those links opening
in the same tab. The observer watches `<html>`, not `<body>`: a framework that swaps `<body>` out
leaves a body observer attached to a dead node.

## Same-tab rules that look like they could be simpler

- **`?p=N`** is pagination only when the link is labelled N (or N+1). WordPress (`/?p=123`) and
  phpBB (`viewtopic.php?p=123`) use it for post ids.
- **View switch** (`sameViewReason`): same path as this page and the *link* carries `tab`/`sort`/
  `order`/`view` → same tab (Nexus `?tab=files`, `&file_id=` download buttons). Link side only: on
  one-file forums (`index.php?topic=N`) testing the current page's query too would keep every topic
  link in the same tab once the listing is sorted.
- **"Read more" / "continue reading"** are not in the pagination word list on purpose: they lead
  to an article (acidcow's "Read more »"), and the arrow-strip in `nextPageReason` makes any such
  word match its decorated form too. Removed in v1.32.0.
- **Download extensions** are only types the browser saves; images, PDF, txt, mp3/mp4 display in a
  tab and so open in a new one.
- **Link Exceptions**: the path part matches as a substring (users rely on it — keep it), `*` is a
  wildcard, and the link's query is compared only when the rule contains `?` — otherwise
  `site.com/login` would catch `?next=/login`.

Nexus download flow (checked logged in, 2026-09-24): after `?tab=files&file_id=N` the page's
"Slow download" is a `<button>` inside the `<mod-file-download>` shadow root, and the modal's
Manual/Vortex links sit inside `<mod-download-modal>`'s shadow root. The script reaches neither
(it only acts on `a[href]` found by `closest()` from the retargeted host), so any tab the CDN
download opens is Nexus's own doing.

## Testing in the built-in browser

Harness: an HTML page that defines `GM_getValue`/`GM_setValue`/`GM_registerMenuCommand`/
`GM_openInTab`/`unsafeWindow` stubs, then loads the `.user.js` with a `<script src>`. Serve it over
localhost (`python -m http.server` via a `.claude/launch.json` + `preview_start`) — a local file
outside the project opens in the pane as a static snapshot the JS tools refuse to touch. Measure
with `getBBox()`/`getBoundingClientRect()`; screenshots are off-limits.

## Verify browser-extension behaviour in a real browser, not from docs

Both bugs above were shipped in one commit: one proven by reading the code, one guessed from the
Tampermonkey documentation. The guess regressed the feature for every site. Per the standing
rule on speculative fixes — if a change cannot be verified here, it does not ship next to one
that can.
