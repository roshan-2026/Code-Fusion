# HostelCode

> **Offline-first collaborative code editor built for teams working over unreliable hostel Wi-Fi.**

HostelCode allows 4 or more developers to edit the same codebase simultaneously in real time, continue making edits completely offline during network dropouts, and automatically converge their changes without conflict or data loss when connectivity is restored.

---

## 🚀 Key Architectural Principles

1. **CRDT Synchronization (Yjs)**: Conflict-free Replicated Data Type ensuring deterministic convergence across all clients without whole-file overwrites.
2. **Local Persistence (y-indexeddb)**: All document updates are committed to the browser's IndexedDB first, guaranteeing offline editing survival through browser refreshes or machine crashes.
3. **Collaboration Protocol (@hocuspocus/server & @hocuspocus/provider)**: Real-time incremental synchronization and ephemeral user awareness (presence, cursor, selection).
4. **Per-User Undo/Redo (Y.UndoManager)**: Transaction-origin tracking isolates undo operations so a user never accidentally reverts a teammate's edits.
5. **Multi-File Document Identity**: Documents are addressed by stable IDs (`project:{projectId}:file:{fileId}`) rather than raw filenames to prevent collision on renames.

---

## 📁 Repository Structure

```text
hostelcode/
├── apps/
│   ├── web/                     # React + Vite + Monaco frontend
│   │   ├── src/
│   │   │   ├── components/      # UI components (Header, HealthStatus, Workspace)
│   │   │   ├── pages/           # Project dashboard & editor views
│   │   │   ├── collaboration/   # Yjs, y-monaco, y-indexeddb, and Hocuspocus provider
│   │   │   ├── hooks/           # useCollaboration, useOfflineStatus
│   │   │   ├── lib/             # Utilities and configs
│   │   │   └── types/           # Frontend-specific types
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   └── server/                  # Hocuspocus CRDT & WebSocket server
│       ├── src/
│       │   ├── auth/            # Auth and membership validation
│       │   ├── collaboration/   # Hocuspocus server configuration
│       │   ├── persistence/     # PostgreSQL / binary update storage
│       │   ├── config/          # Environment configuration
│       │   └── index.ts         # HTTP health-check + WebSocket upgrade server
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   └── shared/                  # Common TypeScript types, constants & helpers
│       ├── src/
│       │   ├── constants.ts     # Document format, color palette, language map
│       │   ├── types.ts         # HealthCheckResponse, UserPresence, ProjectFile
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
└── package.json                 # Monorepo workspaces configuration
```

---

## 🛠️ Quickstart Commands

### 1. Prerequisites
- **Node.js**: v18.0.0+ (Tested on v24.19.0)
- **npm**: v9.0.0+ (Tested on v11.17.0)

### 2. Installation
```powershell
# In project root
npm install
```

### 3. Environment Setup
```powershell
# Copy the example environment configuration
cp .env.example .env
```

Default environment variables:
- **Server Port**: `1234`
- **Frontend Port**: `5173`
- **WebSocket Endpoint**: `ws://localhost:1234`
- **HTTP Health Check**: `http://localhost:1234/health`

### 4. Running the Development Environment

#### Option 0: One-Click Startup (Windows)
Double-click `start.bat` or run:
```cmd
.\start.bat
```
*(Automatically checks prerequisites, builds shared modules, launches backend & frontend, and opens the app in your browser at `http://localhost:5173`.)*

#### Option A: Run Both Services Concurrently via npm
```powershell
npm run dev
```

#### Option B: Run Services in Separate Terminals
```powershell
# Terminal 1: Collaboration Server (WebSocket + Health check)
npm run dev:server

# Terminal 2: Vite Web Client
npm run dev:web
```

### 5. Verification & Health Check
Test the collaboration server health endpoint:
```powershell
curl http://localhost:1234/health
```
Expected output:
```json
{
  "status": "ok",
  "service": "HostelCode Collaboration Server",
  "version": "0.1.0",
  "timestamp": "...",
  "uptimeSeconds": 12,
  "environment": "development",
  "metrics": {
    "activeConnections": 0,
    "activeDocuments": 0
  }
}
```

---

## 🚦 Milestones Roadmap

- [x] **Milestone 1**: Monorepo Setup, TypeScript configuration, and Server Health-Check endpoint.
- [ ] **Milestone 2**: Monaco Editor Integration, VS Code workspace layout, multi-file selection, syntax highlighting.
- [ ] **Milestone 3**: Yjs Document Sync via Hocuspocus provider, `y-monaco` binding, real-time multi-tab testing.
- [ ] **Milestone 4**: Offline Resilience via `y-indexeddb`, connection status states, simulated network disconnect & automatic reconnect merge.
- [ ] **Milestone 5**: User Awareness (live cursors, colored labels, selections), per-user UndoManager transaction origins.
- [ ] **Milestone 6**: Supabase Authentication, project authorization enforcement, server-side document persistence & recovery.
- [ ] **Milestone 7**: Automated end-to-end multi-client test suite, stress testing, and production deployment.
