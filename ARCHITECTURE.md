# AI Survival World - Architecture

## Overview

AI Survival World is divided into three major systems.

### 1. Browser game client
Responsibilities:
- Babylon.js rendering.
- Player input and camera.
- World rendering.
- Gameplay interface.
- Local visual effects.
- Communication with game servers.

Technology:
- TypeScript.
- Babylon.js.
- Vite.

### 2. Game backend
Planned responsibilities:
- Game state.
- Survival systems.
- NPC state.
- Persistent world data.
- Multiplayer synchronization.
- Authentication and sessions.

The backend has not yet been implemented.

### 3. AI backend
Planned responsibilities:
- NPC conversation orchestration.
- Calls to Qwen through LiteLLM.
- NPC personality and context.
- Memory retrieval and storage.
- Game-event interpretation.

The AI backend is separate from the Pi development agents.

## Planned AI memory
Use persistent storage, likely PostgreSQL, for:
- NPC identity and personality.
- Player/NPC relationship.
- Conversation history.
- Important remembered facts.
- Relevant world events.

Final schema and retention strategy are not yet decided.

## Development agents
Pi agents are development assistants, not in-game NPCs.

Planned workflow:
- Game Director coordinates work.
- Specialized agents work on isolated tasks.
- Git worktrees isolate parallel changes.
- QA validates builds and tests.
- Project owner approves important changes and merges.

## Current implementation
The current project is a frontend-only prototype.
Do not assume backend, AI or multiplayer functionality exists.
