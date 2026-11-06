# kelola-api

> Backend API for Kelola — an AI-powered collaborative workspace that brings real-time messaging, meeting notes, and AI chat into one place.

**Live:** [getkelola.vercel.app](https://getkelola.vercel.app) · **Frontend repo:** [Kelola-App](https://github.com/BenDjarinn/Kelola-App)

---

## The Problem

Most team tools are built around one thing. Slack for chat. Notion for docs. ChatGPT for AI. You end up context-switching constantly, losing threads between apps, and paying for three subscriptions to do one job.

Kelola puts real-time discussion, structured meeting notes, and an AI assistant inside the same workspace — organized by channel, scoped by project. One place, one context.

This repo is the backend that powers all of it.

---

## What This API Does

Kelola's backend handles three distinct channel types, each with its own data flow:

| Channel | Mechanism | Description |
|---|---|---|
| Discussion | Socket.io (real-time) | Live messaging scoped to a project room |
| Meeting Notes | REST CRUD | Structured documents with assignee, status, and due date |
| AI Chat | Request/response | Gemini-powered assistant with per-project conversation history |

On top of that: multi-tenant workspace isolation, Better Auth session management, `.docx` upload and text extraction for AI context, and two-layer AI rate limiting.

---

## Tech Stack — and Why

| Technology | Why this, not the alternative |
|---|---|
| **Express 5** | Mature ecosystem, predictable behavior, async error handling improved significantly in v5 — no need for a framework with more opinions for this scope |
| **Drizzle ORM** | SQL-first approach means the schema is exactly what ends up in the database — no magic, no hidden query behavior. Prisma's abstraction felt like too much black box for a multi-tenant setup where query control matters |
| **PostgreSQL on Neon** | Real foreign keys with `ON DELETE CASCADE` and partial unique indexes do the heavy lifting — "one live membership per user per workspace" is a database constraint here, not application code. MongoDB's flexible schema would have been a liability, not an asset |
| **Better Auth** | Session management out of the box without locking the architecture into a third-party identity provider. Its `databaseHooks` are also where soft-delete enforcement and default-workspace auto-join hang off the auth flow |
| **Socket.io** | Rooms API maps cleanly to Kelola's project-scoped messaging — one room per project. WebSockets from scratch would have added weeks with no real upside |
| **Google Gemini (`@google/genai`)** | Multimodal support and competitive performance for a conversational use case. The newer `@google/genai` SDK has a cleaner API surface than the legacy `@google/generative-ai` package |
| **Zod** | Schema-first validation at the route layer means bad requests never reach the service layer. Environment config is validated the same way, so a misconfigured deploy fails at boot instead of at the first request |

---

## Architecture

```
kelola-app (Next.js on Vercel)
       │
       ▼
kelola-api (Express on Railway)
       │
   ┌───┴────────────────┐
   │                    │
Drizzle ORM         Socket.io
   │                    │
PostgreSQL (Neon)   Realtime rooms
                    (per project_id)
```

The API and frontend are separate repos deployed independently. Socket.io shares the same HTTP server as Express — `app.listen()` returns it and Socket.io attaches to it, so there is one process and one port.

---

## Database Design

11 tables. Four belong to Better Auth (`users`, `sessions`, `accounts`, `verifications`); the rest are Kelola's own: `workspaces`, `workspace_members`, `channels`, `projects`, `messages`, `note_documents`, `ai_messages`.

**Tenant isolation is enforced in the application layer, not by Postgres RLS.** Every route that touches project data calls `assertProjectAccess(userId, projectId)` first. It resolves the project, checks for a live workspace membership, and answers 404 for a missing or soft-deleted project — 403 only once it knows the project exists and the user simply is not a member.

**`workspace_id` is denormalized into the leaf tables** (`messages`, `note_documents`, `ai_messages`). The reason is trust, not query cost: `assertProjectAccess` returns the `workspace_id` it read from the project row, so callers never take it from the request body. A caller-supplied workspace id would let someone write into another tenant's workspace.

**Soft delete everywhere** via `deleted_at timestamptz NULL`. Hard deletes on a multi-tenant system create too many edge cases around cascading and audit trails. The constraints respect it: `workspace_members_active_unique` is a *partial* unique index on `(workspace_id, user_id) WHERE deleted_at IS NULL`, so re-joining after removal is allowed while a second live membership is not.

**`channels` uses a `type` enum + `config jsonb`** — adding a new channel type later doesn't require an `ALTER TABLE`. The behavior lives in the application layer, the config lives in the row.

---

## Project Structure

```
src/
├── config/
│   └── ai-attachments.ts       # Upload limits and accepted MIME types
├── db/
│   ├── schema.ts               # Single source of truth for all 11 tables
│   ├── index.ts                # Drizzle client over a pg.Pool
│   ├── migrate.ts              # Runtime migrator — needs no devDependencies
│   ├── seed.ts                 # Seeds demo workspace, channels, and projects
│   └── backfill-workspace-members.ts
├── lib/
│   └── auth.ts                 # Better Auth config, cookie attributes, hooks
├── middleware/
│   ├── auth.ts                 # requireAuth
│   ├── ai-rate-limit.ts        # Per-user and global daily caps
│   └── ai-chat-attachments.ts  # Multipart parsing for AI uploads
├── realtime/
│   ├── index.ts                # Socket.io server, handshake auth
│   └── discussion.handlers.ts  # Room join and message events
├── routes/                     # ai · messages · notes · projects
├── services/                   # Business logic — one file per domain
├── app.ts                      # Express app factory, CORS, 404 and error handlers
├── env.ts                      # Zod-validated environment config
└── index.ts                    # Server entry point, graceful shutdown
```

---

## Challenges

**Tenant isolation without RLS.** Row Level Security was the obvious answer, but it needs the request's user identity inside the database session, which a shared pooled connection does not carry. The working approach was to make one function the only door: `assertProjectAccess` resolves the project and the membership together and hands back the `workspace_id` it read, so no route ever gets the opportunity to trust a workspace id from the client. The 403-vs-404 split matters too — answering 403 for a project that does not exist tells an attacker that it does.

**Socket.io scoping** needed care around room naming and re-authorization. Each project gets its own room keyed by `project_id`, and membership is re-checked on every event rather than only at connection — someone removed from a workspace mid-session has to stop receiving messages immediately.

**AI rate limiting across a shared free tier.** Gemini's free quota is per project, not per user, so one heavy user can exhaust the daily limit for everyone. The answer was a two-layer cap — a per-user daily limit and a global daily ceiling, both configurable — backed by the `ai_messages_user_created_idx` index so the count stays cheap.

**A cross-site session cookie.** Vercel and Railway are different registrable domains, so the browser treats the pair as cross-site and never attaches a `SameSite=Lax` cookie to a `fetch()`. `sameSite` is therefore derived from whether `COOKIE_DOMAIN` is set, which means moving to `app.kelola.app` + `api.kelola.app` later needs no code change: it tightens to `Lax` on its own.

---

## Getting Started

### Prerequisites

- Node.js >= 20
- A [Neon](https://neon.tech) PostgreSQL database
- A [Google AI Studio](https://aistudio.google.com) API key

### Installation

```bash
git clone https://github.com/BenDjarinn/kelola-api.git
cd kelola-api
npm install
```

### Environment Variables

```bash
cp .env.example .env.local
```

`.env.local` is loaded first and wins over `.env`, matching where the Neon CLI writes `DATABASE_URL`. A real process environment — Railway's, for example — beats both.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test`, or `production` |
| `PORT` | no | `4000` | Server port |
| `DATABASE_URL` | **yes** | — | Neon pooled connection string (host contains `-pooler`) |
| `BETTER_AUTH_SECRET` | **yes** | — | Session signing secret, at least 32 characters — `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | **yes** | — | Public origin of this API. Must be `https://` in production |
| `CORS_ORIGIN` | no | `http://localhost:3000` | Allowed browser origin(s), comma-separated. Must not be localhost in production |
| `COOKIE_DOMAIN` | no | unset | Shared parent domain for the session cookie, e.g. `.kelola.app`. Leave unset on Vercel + Railway, and never set it to `.vercel.app` — that domain is on the Public Suffix List and browsers reject it as a cookie domain |
| `DEFAULT_WORKSPACE_SLUG` | no | unset | Workspace that every new registration auto-joins. **Public demos only:** anyone who signs up can then read that workspace's discussions, notes and AI history. Not retroactive — it runs in `user.create.after`, so accounts created before it was set need `npm run db:backfill-members` |
| `GEMINI_API_KEY` | **in practice** | — | Google AI Studio key. Optional in the Zod schema so `db:migrate` and `db:seed` can run without one, but `ai.service.ts` throws on import — the server will not boot without it |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | Primary model. Kept in env because `gemini-2.0-flash` was retired mid-project |
| `GEMINI_FALLBACK_MODEL` | no | `gemini-3.5-flash-lite` | Tried when the primary returns 503. Set equal to `GEMINI_MODEL` to disable |
| `AI_CONTEXT_MESSAGE_COUNT` | no | `20` | Prior turns sent to Gemini as context |
| `AI_DAILY_LIMIT_PER_USER` | no | `50` | Max AI messages per user per day |
| `AI_DAILY_LIMIT_GLOBAL` | no | `500` | App-wide daily ceiling — the circuit breaker on the free tier |

In production `env.ts` additionally rejects a localhost `BETTER_AUTH_URL` or `CORS_ORIGIN` and a non-`https` `BETTER_AUTH_URL`, and exits rather than booting half-configured.

### Database Setup

```bash
npm run db:migrate
npm run db:seed
```

`db:seed` needs an existing user to own the workspace — sign up through the frontend first, or name one: `npm run db:seed you@example.com`.

### Run

```bash
npm run dev
```

Server starts at `http://localhost:4000`.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile to `dist/` |
| `npm run start` | Run the production build |
| `npm run typecheck` | Type-check without emitting |
| `npm run test` | Run tests once — 43 tests across 5 files |
| `npm run test:watch` | Tests in watch mode |
| `npm run db:generate` | Generate migration files from the schema |
| `npm run db:migrate` | Apply migrations with drizzle-kit |
| `npm run db:migrate:prod` | Apply migrations from `dist/` — run `npm run build` first |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:seed` | Seed the demo workspace |
| `npm run db:backfill-members` | Add every existing user to a workspace they are not yet in |

---

## API Endpoints

Every `/api/*` route below requires a session cookie and answers `401` without one.

### Health and session

```
GET    /health                     -> { status: "ok" }
GET    /api/me                     -> the signed-in user
ALL    /api/auth/*                 -> handled by Better Auth
```

Better Auth owns its own paths. The ones this project uses are `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out` and `GET /api/auth/get-session`.

### Projects

```
GET    /api/projects?type=ai|discussion|notes   projects for a channel type
GET    /api/projects/:projectId/members         workspace members, for assignee pickers
```

### Discussion

```
GET    /api/messages/:projectId    message history
```

Sending, editing and deleting discussion messages happen over Socket.io, not REST — there is no `POST /api/messages`.

### Meeting Notes

```
GET    /api/notes?projectId=           list, without the body so the list stays light
GET    /api/notes/archived?projectId=  soft-deleted notes
POST   /api/notes                      create
GET    /api/notes/:noteId              one note, including the BlockNote body
PATCH  /api/notes/:noteId              partial update — this is what autosave calls
DELETE /api/notes/:noteId              soft delete
POST   /api/notes/:noteId/restore      clear deleted_at
```

### AI Chat

```
GET    /api/ai/chat/:projectId     conversation history
POST   /api/ai/chat                send a message (rate limited, accepts attachments)
PATCH  /api/ai/chat/:messageId     edit a message and regenerate from it (rate limited)
```

### Socket.io events

The default `/` namespace. The session cookie is validated during the handshake, and workspace membership is re-checked on every event.

| Direction | Event | Purpose |
|---|---|---|
| client → server | `message:send` | post a message to the project room |
| client → server | `message:edit` | edit your own message |
| client → server | `message:delete` | soft delete your own message |
| server → client | `message:new` | a message was posted |
| server → client | `message:updated` | a message was edited |
| server → client | `message:deleted` | a message was removed |

---

## Deployment

Deployed on [Railway](https://railway.app), which builds this repo with **Nixpacks auto-detection** — there is no `railway.json`, `nixpacks.toml`, `Procfile` or `Dockerfile`. Railway infers `npm ci` → `npm run build` → `npm start` from `package.json`, and `engines.node >= 20` selects the runtime.

Three consequences of that are worth knowing before deploying:

- **`typescript` is a runtime dependency, not a devDependency.** Railway sets `NODE_ENV=production`, so `npm ci` prunes devDependencies — and `npm run build` is `tsc`, which would then be missing.
- **`db:migrate:prod` exists for the same reason.** It uses `drizzle-orm/node-postgres/migrator` from `dist/`, so migrations do not need `drizzle-kit`. In practice it is often easier to migrate from a developer machine against the production connection string, since a shell-exported `DATABASE_URL` beats `.env.local`.
- **The healthcheck path is `/health`.** Without it Railway can only infer readiness from a listening port.

Set `PORT` and the public domain's target port to the same value. `PORT` defaults to `4000` in the schema, so a mismatch between that default and the port Railway routes to surfaces as a 502 rather than a crash.

For the frontend, set `CORS_ORIGIN` to its deployed origin — exactly, with no trailing slash — and leave `COOKIE_DOMAIN` unset. The app then switches the session cookie to `SameSite=None; Secure` on its own, because across Vercel and Railway the browser considers the two different sites.

---

## Known Gaps

An honest list of what is not done:

- **No ESLint or Prettier.** `package.json` declares `lint` and `format` scripts, but neither tool is installed and there is no config file, so both fail. Type safety is covered by `npm run typecheck`.
- **No workspace or channel CRUD.** Workspaces, channels and projects are created by `db:seed`, which is why `DEFAULT_WORKSPACE_SLUG` exists. Self-serve workspace creation and invitations are the next thing to build.
- **Notes are last-write-wins.** Two people editing the same note overwrite each other. Real concurrent editing needs a CRDT and was deliberately out of scope.
- **AI history is shared per project, not per user.** It is filtered by `project_id` only, so every workspace member sees every AI conversation in that project.
- **Malformed JSON answers 500, not 400.** `express.json()` throws a `SyntaxError` that the error handler treats like any other failure.

---

## License

MIT
