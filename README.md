# DaemonPulse

> A web-based control plane for the LM Studio 0.4.x headless daemon (`llmster`).
> Think of it as the admin panel for your self-hosted AI stack — built for operators, usable by anyone.

---

## What This Is

LM Studio 0.4.x decoupled its inference engine into a headless daemon (`llmster`) designed to run on servers, containers, and cloud GPU instances. That is powerful — but it leaves you managing a production AI stack entirely through a CLI.

**DaemonPulse** fills that gap. It is a lightweight web dashboard that gives you full visual control over a remote `llmster` process: load and eject models, monitor VRAM, watch live inference streams, manage MCP tool permissions, and tail live logs — no SSH required.

**Control Plane** is the technical framing: DaemonPulse is the management layer that sits above the inference plane, the same way a Kubernetes control plane sits above its worker nodes. Non-developers can think of it as the admin panel for your AI server — same thing, different vocabulary.

---

## Why Self-Host?

Commercial API reasoning models (Anthropic, OpenAI) cost **$15–$60+ per million tokens**. Heavy agent workloads can compound to **$20,000+/year**.

A flat-rate GPU Droplet runs **$2–$4/hr**. Once it is on, token volume does not change your bill.

DaemonPulse is the management layer that makes self-hosting practical at scale.

---

## Project Status

**Active development — core modules implemented, wiring ongoing.**

| Module | Status |
|---|---|
| **The Fleet** | ✅ GPU discovery, VRAM monitoring, multi-GPU allocation |
| **The Forge** | ✅ Model load/eject, VRAM pre-flight, JIT loading, Dev/Live mode |
| **The Pulse** | ✅ Live streaming inference, `<think>` tag visualiser, TTFT measurement |
| **The Toolchain** | 🔧 MCP server registry — stub, wiring in progress |
| **The Console** | ✅ Live log stream, level filter, Live-mode high-level preset |
| **Settings** | ✅ Daemon target manager, Dev/Live toggle, permission key |

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | TypeScript · Vite · Tailwind CSS |
| Bridge server | Node.js · Express (proxy + auth + CLI bridge) |
| Auth | JWT (8 h sessions, bcrypt credentials, SQLite user store) |
| Daemon API | LM Studio `/api/v0/` and `/api/v1/` REST + SSE |
| CLI integration | `lms` binary — `--host` injection for remote targets |
| Design system | Slate/Indigo dark theme · WCAG-AA contrast |

---

## Multi-Host Support

DaemonPulse supports multiple daemon targets. Add any number of local or remote LM Studio instances in Settings → Daemon Targets, switch between them at runtime, and all CLI commands — including `lms server start/stop` — automatically route to the active target via `--host`.

---

## Dev / Live Mode

A toggle in Settings controls two operational modes:

- **Dev mode** — all controls visible, full log stream, no restrictions
- **Live mode** — advanced sliders locked to production presets, console filtered to high-level events only (model load, server start, errors)

Useful for testing what a non-technical operator will see before deploying to a remote machine.

---

## Quick Start

```bash
npm install
npm run seed          # create the SQLite user DB with default admin account
npm run server        # start the Express bridge on :3000
npm run dev           # start the Vite dev server on :5173
```

Copy `.env.example` to `.env` and set `DAEMON_API_URL` to your LM Studio instance.

---

> _"DaemonPulse" — because you are monitoring a living system, not querying a static database._

---

## Licence

See [LICENSE](./LICENSE).

---

> This is an unofficial project. Not affiliated with or endorsed by LM Studio.
