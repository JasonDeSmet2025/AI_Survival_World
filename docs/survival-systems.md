# Survival systems: item flow and the bag capacity contract

Owner: Gameplay Agent. Code: `src/game/systems/`, data: `src/game/core/items.ts`.
Tests: `src/game/core/items.test.ts`, `src/game/systems/{harvest,capacity,crafting,cook,inventory,save}.test.ts`.

## The rule

`Inventory.add(id, count)` returns the number of units that did **not** fit.
That return value is part of the API: every path that hands items to the
player must account for it. Silently dropping the remainder destroys gameplay
state — the historical bug did exactly that in gathering, crafting and
cooking, while still paying XP and damaging the resource node.

Every gain path therefore uses one of these two shapes:

| Path | Where | Behaviour when the bag is full |
| --- | --- | --- |
| Gathering (solo) | `systems/harvest.ts` → `resolveHarvest()` | `status: 'blocked'` — the swing does not finish, no node hp, no XP |
| Gathering (partial fit) | same | grants what fits, reports `lost`, pays scaled XP |
| Gathering (MP) | `game.ts` + `server/server.mjs` | server keeps hp/roll authority; client reports the real intake |
| Crafting | `systems/crafting.ts` → `tick() === 'blocked'` | progress pins at 1, materials kept, auto-resumes |
| Cooking | `systems/cook.ts` → `tick() === 'blocked'` | progress pins at 1, raw food kept, auto-resumes; a dead fire still cancels |

## Projection, not guesswork

`Inventory.roomFor(id, removals?)` and `canAdd(id, count, removals?)` compute
how much of an item *would* fit — same-item stack space plus `stack ×` empty
slots — without touching the bag. The optional `removals` list models the
units that the same transaction consumes first. That matters: crafting in a
full bag is legal exactly when the recipe's own materials open the space, and
the projection is what distinguishes that case from a genuinely stuck craft.

Because tools have `stack: 1`, they need an *empty* slot: consuming two wood
out of a stack of 60 frees no space at all. `capacity.test.ts` pins this, and
`items.test.ts` pins the matching data invariants (every recipe output fits
in one stack, every yield fits in one stack including the +1 tool bonus).

## Harvest resolution

`resolveHarvest({ kind, inventory, toolId, rng })` is the single place that
turns a finished gathering swing into gameplay state:

- rolls `YIELDS[kind]` (injectable RNG → reproducible tests and replays),
- applies the +1 effective-tool bonus from `toolForNode()`,
- checks capacity, grants, and reports `rolled / granted / lost`,
- returns the XP the caller must grant (full, scaled, or zero),
- and returns `usedTool` so the caller can apply tool wear.

It never damages the node: the caller damages only on `status === 'gathered'`.
Unknown node kinds resolve to `status: 'unknown'` instead of indexing a
possibly undefined yield (the old code's second crash path).

## Related fixes from the same round (`game.ts`)

- **FPS readout**: the meter (`systems/fps.ts`) is fed the *raw* frame time.
  The simulation clamps `dt` to 50 ms, so averaging the clamped value made the
  HUD structurally unable to report anything below ~20 fps.
- **Camera pitch**: saved pitch is restored through `clampCameraPitch()`
  (shared constants in `player/controller.ts`) instead of
  `Math.min(pitch, -0.65)`, which flattened every saved upward glance.
- **Destructive actions**: `systems/confirm.ts` replaces `window.confirm()`
  inside the render loop with a timed two-press flow; a modal dialog blocks
  the browser thread and froze the entire game.
- **Cleanup**: `dispose()` removes the exact handlers it registered (it used to
  pass fresh arrow functions to `removeEventListener`, so nothing detached).
- **Save file**: `Save.read()` structurally validates the payload. Anything
  that is not a save (truncated storage, foreign object, malformed optional
  `progress`/`npcs`) returns `null`, so the game falls back to a fresh world
  instead of throwing during boot.
