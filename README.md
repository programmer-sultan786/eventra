# Eventra

Eventra is a planned web platform for discovering events and booking tickets. It will support customer and administrator workflows, including event discovery, schedules, seat or quantity-based booking, payments, digital tickets, reviews, notifications, and administration.

## Technology stack

- Frontend: React with JavaScript and React Router
- Backend: Node.js with Express.js
- Database: PostgreSQL (planned; not connected yet)
- Version control: Git (to be initialized by the project owner)

## Repository structure

```text
client/   React frontend and placeholder pages
server/   Express API structure and planned backend modules
```

## Prerequisites

- Node.js 18 or newer
- npm
- PostgreSQL for future database development (not required for the current health check)

## Installation and startup

Install dependencies in each package:

```bash
cd client
npm install

cd ../server
npm install
```

Copy each `.env.example` to `.env` when configuration is needed. The current scaffold does not require a database, payment provider, email provider, or secret credentials.

Start the frontend:

```bash
cd client
npm run dev
```

Start the backend in another terminal:

```bash
cd server
npm run dev
```

The API health check is available at `http://localhost:5000/api/health`.

## Current implementation status

The home page, basic client navigation, Express server, health check, and route/page placeholders are available. Planned authentication, database access, event management, booking, payments, ticket generation, email, reporting, and review functionality are intentionally not implemented.

## Planned development phases

1. Project Planning and Requirements
2. System Design
3. Sprint 1 — Foundation
4. Sprint 2 — Core Booking
5. Sprint 3 — Platform Completion
6. Final Testing and Bug Fixing
7. Documentation
8. Deployment

The structure is prepared for these phases, but the scaffold is not a production-ready booking application.

