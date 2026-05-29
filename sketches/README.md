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
