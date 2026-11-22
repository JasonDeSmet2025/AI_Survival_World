# AI Survival World — Development Plan (Game v1)

Owner mission: turn the prototype into a genuinely playable 3D survival game.
Visual reference: The Forest / Valheim. Target hardware: RTX 3050 Ti (4 GB VRAM).

## Key decisions (Game Director)

1. **Core build is done by the lead developer directly, in one coherent branch.**
   The world, visuals and gameplay systems are deeply interlocked (terrain height
   drives player collision, flora placement, camera, building snapping). Running
   world/visual/gameplay agents in parallel worktrees would produce conflicting
   rewrites of `game.ts`, `terrain.ts` and `flora.ts`. The mission's own rules
   forbid two agents editing the same files. Specialist roles are still executed
   (each phase is scoped per agent charter) but sequentially by the lead
   developer, with the QA agent run independently afterwards.
2. **No new runtime dependencies.** Only `vitest` (dev) for the required test
   suite. Water, sky and terrain materials are custom `ShaderMaterial`s built on
   `@babylonjs/core` only. Multiplayer server is dependency-free Node
   (hand-rolled RFC6455 WebSocket + built-in `crypto`/`fetch`).
3. **Browser verification**: a headless Chromium via Playwright (dev dependency)
   is installed so the game is checked in a real browser (console errors,
   rendering, input, acceptance scenarios), not just `tsc`.
4. **Worktree/branching**: all work happens on branch `core/game-v1` in
   `/root/AI_Survival_World-worktrees/core-game-v1`. `main` stays untouched.
   Local commits on the dev branch record phase state (no push, no merge,
   reported in the final status). Owner approves merge to main.
5. **In-game AI** stays separate from the Pi development agents: NPCs talk
   through the game server's `/api/chat` proxy (which forwards to the LiteLLM
   gateway server-side). No API keys ever reach the browser. Canned fallback
   dialogue when the server/LLM is unavailable.
6. **Determinism**: one world seed (default `0x5eed2024`) drives all procedural
   generation; the seed is shared with the MP server so all clients see the
   same world.

## Module map (file ownership per specialist role)

| Area | Files | Role |
|---|---|---|
| World | `src/game/world/{terrain,water,flora,nodes}.ts`, `src/game/core/noise.ts` | World Agent |
| Visuals | `src/game/world/{sky}.ts`, `src/game/visual/lighting.ts`, `src/game/visual/materials.ts` | Visual Agent |
| Player | `src/game/player/{player,controller,animation}.ts` | Gameplay Agent |
| Gameplay | `src/game/systems/{stats,inventory,crafting,building,interact,save}.ts`, `src/game/core/items.ts` | Gameplay Agent |
| AI NPCs | `src/game/ai/{npc,chat}.ts` | AI Agent |
| Multiplayer | `src/game/net/mp.ts`, `server/server.mjs` | Multiplayer Agent |
| Shell/HUD | `src/game/game.ts`, `src/game/hud/hud.ts`, `src/game/game.css` | Director |
| QA | `tests/*.test.ts`, `scripts/browser-check.ts` | QA Agent |

## Acceptance mapping (mission §7)

1. Game starts without errors → browser smoke test.
2. Natural terrain → terrain biome shader + browser screenshot.
3. Walk/sprint/jump → controller unit tests + browser input test.
4. Collision → controller collision unit tests.
5. Gather tree/resource → interact system tests + browser test.
6. Inventory shows material → inventory tests + browser test.
7. Use item → inventory tests + browser test.
8. Craft tool → crafting tests + browser test.
9. Build campfire → building tests + browser test.
10. Hunger/thirst/stamina change → stats tests + browser HUD check.
11. Campfire/interactions work → server + interact tests.
12. Save/load → save round-trip tests + browser test.
13. Multiplayer ≥2 clients → server integration test (2 WebSocket clients) + browser test of client sync.
14. No critical console errors → Playwright console capture.
15. Playable on midrange → draw-call/vertex budget check + 60 FPS target in headless (software GL — treat FPS numbers there as indicative only, documented).

## Phases

- Phase A: foundation — noise, terrain v2, water, sky, lighting, flora v2, nodes.
- Phase B: player — humanoid, animation, physics controller.
- Phase C: gameplay — items, stats, inventory, crafting, building, interact, save, HUD.
- Phase D: AI NPCs + chat proxy.
- Phase E: multiplayer server + client.
- Phase F: QA — unit/integration/browser tests, performance budget, docs.
