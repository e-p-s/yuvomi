# Feature request: Rotation for recurring task series

## Problem

A recurring task (`recurrence_rule`) is assigned to one person forever. For shared
chores (trash, bathroom, dishes) households want the *series* to rotate between
members: each new occurrence goes to the next person instead of the same one.

Today the assignee is copied verbatim in `spawnRecurrenceFollowup()`
(server/routes/tasks.js) — there is no way to say "this series rotates".

## Proposal

Keep the RRULE engine untouched; rotation is purely an assignment policy applied
at follow-up creation time:

- `tasks.rotation_mode` — NULL (off) | `round_robin` | `least_assigned` | `least_recent`
- `tasks.rotation_pool` (join table, ordered) — members who share the series (2–10)
- `tasks.rotation_last_user` — who received the last occurrence

At `spawnRecurrenceFollowup()`, if the series origin has a rotation mode and a pool
of ≥2, pick the next member deterministically and assign the follow-up to them.
Mode and pool travel **as values** onto the follow-up (same principle as
`recurrence_series_id` in #1603), so deleting the origin doesn't break the running series.

Strategies:
- **round_robin** — next in pool order after `rotation_last_user`
- **least_assigned** — pool member with the fewest open tasks
- **least_recent** — pool member whose last completion of this series is oldest

All deterministic (no RNG), so the UI can show "next: Leon" without side effects.

## Why it fits the codebase

- Single insertion point: `spawnRecurrenceFollowup()` already copies assignments,
  tags (#586) and subtasks (#742) — rotation replaces one of those copies.
- No dependency on the recurrence math; a series without rotation behaves exactly
  as today (NULL mode = current behaviour, byte-for-byte).
- Migration-guarded as usual (column/table only if missing).

## Scope of a PR

Migration + small service (`server/services/task-rotation.js`), assignment in the
follow-up path, `rotation_mode`/`rotation_pool` in task create/update API with
household-membership validation, one section in the task dialog, and
`test/test-task-rotation.js` following `test-tasks-recurrence.js`.

Happy to open the PR — prototype exists (branch `feat/task-rotation`) and tests pass
locally; I'd align naming/validation with your review before submitting.
