# AI Survival World - Agent Instructions

## Project
AI Survival World is a browser-based 3D survival game.

## Language
- Communicate with the project owner in Dutch.
- Write source code, identifiers and technical documentation in English.

## Mandatory context
Before starting any task:
1. Read this file.
2. Read MEMORY.md.
3. Read ROADMAP.md.
4. Read ARCHITECTURE.md.
5. Read relevant documentation under docs/.

## Technical stack
- TypeScript
- Babylon.js
- Vite
- Browser-based 3D rendering
- WebGL 2 initially, WebGPU compatibility where practical.
- Qwen 3.8 27B through the existing LiteLLM gateway for development agents.

## Rules
- Work only inside /root/AI_Survival_World.
- NEVER modify /root/AI_operations_Game.
- Do not expose API keys, tokens or credentials.
- Do not install unnecessary dependencies.
- Do not download large AI models.
- Do not introduce paid services without approval.
- Preserve existing working functionality.
- Do not overwrite unrelated files.
- Do not commit or push Git changes without explicit approval.
- Run npm run build after code changes.
- Explain modified and created files.
- Never claim a test passed unless it was actually executed.

## Multi-agent rules
- Every task must have a clearly defined scope.
- Agents must declare which files they intend to modify.
- Different agents must not edit the same files simultaneously.
- Use separate Git worktrees or branches for parallel development.
- Never merge changes without reviewing them.
- The coordinating agent must check compatibility and run the build.
- Ask the project owner before major architectural changes.

## Memory rules
- Read MEMORY.md before work.
- Update MEMORY.md when an important decision, architectural change or milestone occurs.
- Do not store API keys, passwords or personal secrets in project memory.
- Record unresolved issues and known limitations.
- Keep project memory concise and factual.

## Development philosophy
Build incrementally:
1. Stable foundation.
2. Beautiful and performant world.
3. Gameplay systems.
4. AI NPCs and memory.
5. Multiplayer.
6. Advanced features.

Do not implement future systems prematurely.
