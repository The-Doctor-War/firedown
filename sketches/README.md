# Sketches

UX exploration artifacts produced during design conversations. Each HTML
is a self-contained static mockup — open it in a browser to see the
phone-frame, card, and popup variants we walked through before
landing on the shipped implementation.

Newer iterations supersede older ones (the file list below is in
chronological order). Older sketches are kept for context — the deltas
between them show *why* we ended up where we did.

## Files

- `bookmarks-card-sketches.html` — Four bookmark-card variants for
  the home stack (counter subtitle, last-added subtitle, favicon
  stack, count pill).
- `home-ux-alternatives.html` — Four whole-home directions
  considering the cards and bottom bar together.
- `home-ux-v2.html` — Three directions with explicit per-context
  "more" popup contents.
- `popup-redo.html` — First sectioned-popup pass using a top
  quick-row plus a flat list.
- `popup-fennec-inspired.html` — Sectioned popup with a 2×2 library
  tile grid borrowed from Fennec. Rejected as derivative — Firedown
  doesn't have the same library cardinality (Downloads is primary
  chrome, not a peer of History/Bookmarks).
- `popup-firedown-native.html` — Final direction. MaterialCard
  groups (which match the home-card vocabulary), neutral chips
  throughout except the destructive-tinted Quit, ★ Bookmark
  initially in the quick-row (later moved to a page-state row
  during implementation).
- `clipboard-card.html` — Empty-autocomplete clipboard card. CURRENT
  (4dp corners, content hidden behind an eye toggle, generic label)
  vs three directions: A content-forward (shows the clip + adaptive
  globe/search icon + one forward arrow, 16dp corners), B two explicit
  actions, C compact + dismiss. Shipped A — also matches the radius of
  the single-container suggestion card.
- `security-sheet-layouts.html` — Per-site security sheet. CURRENT shows
  ads + trackers twice each (a PROTECTION toggle and a separate
  BLOCKED-ON-THIS-PAGE count row, 4 rows + duplicated icons for 2
  concepts) vs A merged rows (one row per concept: toggle + count pill
  that drills in), B hero "total blocked" summary, C minimal/dense.
  Proposed A. Not yet implemented.
- `active-download-card.html` — Home active-download strip. CURRENT
  (flame + label + filename + bar + bare %, no inline control) vs
  A inline cancel ✕ + size/percent context, B pause + cancel,
  C speed/ETA + cancel, D minimal (just add total size). Proposed A —
  the card surfaces live state but offers no way to cancel/pause without
  opening Downloads, though the backend supports both.
- `incognito-downloads-banner.html` — Downloads list "incognito
  downloads in progress" header. CURRENT reads as a static content row
  (surface card, mask icon, no progress, no chevron) vs A live+branded
  (primaryContainer tint + progress bar + lock chip + chevron), B
  neutral+actionable, C compact pill, D minimal delta. Shipped: lock
  icon + chevron + brand wash, no progress bar (count-only data).
- `tabs-archive-banner.html` — Tabs list "N tabs archived" banner.
  Already well-built (correct archive icon, dismiss ✕) — the gap is tint
  consistency with the incognito banner. CURRENT (plain surface) vs A
  brand wash + icon chip (keep dismiss), B wash + "View archive ›" body
  cue, C split view/dismiss zones. Shipped A (brand wash only; the bare
  icon already matched the shipped incognito banner, so no icon chip).
  Note: the ✕ stays — this banner is genuinely dismissible.
- `security-sheet-minimal.html` — Security sheet "less is more" pass.
  The shipped hero layout reads off because a centered dashboard (big
  total + pills) sits on a left-aligned settings list — two visual
  languages — plus a redundant total and a dead "0 trackers ›" pill.
  Options: A count as a quiet subtitle on each toggle row (no stats
  block, no pills), B a single summary line + plain toggles, C calm
  per-category stat rows instead of pills. Proposed A. Supersedes the
  hero (B) from security-sheet-layouts.html.
