# DaemonPulse

> A TypeScript-first, browser-based control plane for the headless LM Studio daemon (`llmster`).
> Monitor a living system — not just a static database.

---

## What This Is

LM Studio 0.4.x decoupled its inference engine into a headless daemon (`llmster`) designed to run on servers, containers, and cloud GPU instances. That is powerful — but it leaves you managing a production AI stack entirely through a CLI.

**DaemonPulse** fills that gap. It is a lightweight web dashboard that gives you full visual control over a remote `llmster` process: load/eject models, monitor VRAM, watch agent reasoning streams, manage MCP tool permissions, and tail live logs — without touching SSH.

---

## Why Self-Host?

Commercial API reasoning models (Anthropic, OpenAI) cost **$15–$60+ per million tokens**. Heavy agent workloads can compound to **$20,000+/year**.

A flat-rate GPU Droplet runs **$2–$4/hr**. Once it is on, token volume does not change your bill.

This dashboard is the management layer that makes self-hosting practical.

---

## Project Status

**Early development — TypeScript, building from scratch.**

> _"DaemonPulse" — because you are monitoring a living system, not querying a static database._

All prior concept code and research notes are preserved in [`/docs`](./docs).

---

## Planned Architecture

| Layer | Technology |
|---|---|
| Language | TypeScript |
| UI Styling | Tailwind CSS |
| Icons | Lucide |
| Sync / Dispatch | Synergistic Scout/Active heartbeat pattern |
| Remote Bridge | Lightweight Node.js or Go middleware on the Droplet |
| Auth | Bearer token injection |
| Design System | Slate/Indigo dark theme, WCAG-AA contrast, dyslexia-optimised |

---

## Planned Modules

| Module | Purpose |
|---|---|
| **The Fleet** | GPU discovery, VRAM usage, multi-GPU allocation strategy |
| **The Forge** | Model lifecycle — load, eject, TTL auto-evict, pre-flight VRAM checker |
| **The Pulse** | Live inference stream, batching monitor, `<think>` tag visualiser |
| **The Toolchain** | MCP server registry, security gates, tool-call audit log |
| **The Console** | Raw `lms log stream`, tok/sec and TTFT performance graphs |

---

## Documentation

All research, prior prototypes, and architectural concepts live in [`/docs`](./docs).

| File | Contents |
|---|---|
| [LMStudioDaemon.md](./docs/LMStudioDaemon.md) | **Master technical specification** — API, lifecycle, GPU, batching, MCP, model.yaml |
| [LMS Admin-PRD.txt](./docs/LMS%20Admin-PRD.txt) | Product Requirements Document — modules, UI layout, philosophy |
| [LMStudioWebUI.md](./docs/LMStudioWebUI.md) | Feature list, API spec, systemd service template |
| [Orchestrator Strategy & Handover.md](./docs/Orchestrator%20Strategy%20%26%20Handover.md) | Sync/dispatch architecture, UI design notes |
| [Architecture & Design System.md](./docs/Architecture%20%26%20Design%20System.md) | Economic rationale, heartbeat logic, Tailwind design tokens |
| [The LMS Remote Control Plane.MD](./docs/The%20LMS%20Remote%20Control%20Plane.MD) | Node interface, remote security, orchestration patterns |
| [The Remote Orchestrator1.md](./docs/The%20Remote%20Orchestrator1.md) | Envelope/packet spec, two-tier logging, SHAun signature |
| [Cloud Command Dispatcher.txt](./docs/Cloud%20Command%20Dispatcher.txt) | TypeScript prototype — dispatcher class |
| [Sync&Dispatch.txt](./docs/Sync%26Dispatch.txt) | Prototype — synergistic sync loop |
| [ModelManager.txt](./docs/ModelManager.txt) | Prototype — model inventory UI |
| [LM Studio search interface.md](./docs/LM%20Studio%20search%20interface.md) | Prototype — Forge Hub / HuggingFace search |
| [LMS Admin.html](./docs/LMS%20Admin.html) | Fork origin — vanilla HTML chat UI (reference only) |

---

## Licence

See [LICENSE](./LICENSE).

---

> This is an unofficial project. Not affiliated with or endorsed by LM Studio.
