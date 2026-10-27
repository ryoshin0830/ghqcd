# Refresh status and optional vector search

The status bar should answer when the index was last updated, what an update
is doing, and how much work remains. The old `/ ~53 s` was the previous text
fetch duration. Remove it from both the window and foreground refresh hints.

## Agreed interaction

- A new installation starts with vector search off. Shift+Tab toggles it in
  the current window and reruns the current query without closing fzf.
- The footer always names the current vector mode and its shortcut. A separate
  line shows index age or refresh progress, so the switch remains discoverable.
- An idle footer says `updated 2 h ago` and offers ctrl-r. During refresh it
  shows the current phase. Known totals get an ASCII progress bar, percentage
  and completed/total count. Unknown totals show activity without inventing a
  percentage. Vector processing shows the remaining time based on this run.
- Closing vector search releases the search worker and stops vector indexing
  started by this window. Completed vectors and downloaded model files remain
  on disk. Turning it back on reuses them. Another window or a separately
  launched index command is not stopped by this window's toggle.
- A background text refresh already running when vector search is enabled is
  allowed to finish; missing vectors are then built automatically.
- Window mode is not persisted. `GHQCD_SEMANTIC=1` explicitly opts in at launch
  and for foreground `--index`; otherwise both start without vector work.

The user approved default-off toggling and clarified that disabling must not
uninstall the model or delete built vectors. Keep all cached artifacts.

## Implementation boundaries

Keep existing keyword ranking, query socket, fzf reload/listen mechanism,
index locking and incremental vector files. No runtime dependencies are added.
A small status module owns user-facing index age and progress formatting.
Progress callbacks keep their text argument and may supply structured phase,
completed, total and remaining-time values for the window. Cache files remain
owner-only. Existing noninteractive JSON output contracts are unchanged.

The vector worker is created only when enabled and disposed when disabled.
Child indexers explicitly inherit the current mode, rather than the original
environment. Only an indexer this window launched with vectors enabled is
cancelled by the toggle. Cancellation preserves its last saved progress and
must not leave an `indexing failed` warning or suppress later updates.

Use the existing legacy-fzf reopen path for Shift+Tab on versions without live
footer/listen support. Preserve the query when reopening. Keep the shortcut
and status readable at 60, 80 and 150 columns and without color.

## Verification

Use focused regression tests for index age, phase progress, unknown totals,
mode defaults, child mode propagation and cancellation. Exercise real fzf in
a pseudoterminal for Shift+Tab on/off, query retention, ctrl-r, active update
progress, cancellation and clean exit. Use temporary caches and local fixtures,
never the user's private index or live GitHub account. Run the whole suite and
`npm pack --dry-run`, then review the connected code and diff before making a PR.
