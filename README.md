# InterviewFlow AI — Enterprise Technical Recruitment & AI Code Review Platform

InterviewFlow AI is a full-stack technical interview automation platform built for managing batches of 10 to 1,000+ candidates attending Google Meet technical recruitment sessions. It handles CSV/XLSX candidate onboarding, verified attendance tracking, individualized AI task assignment with 12-part mentor explanations, GitHub repository submission and code review against configurable 100-point rubrics, automated Gmail communication, Google Calendar/Meet review scheduling, and two-stage Excel workbook synchronization.

## Architecture Overview

```
HR Admin Dashboard / Interviewer Console / Candidate Portal (Next.js 14 App Router + React + Tailwind CSS)
        │
        ▼
Backend Workflow Engine & RBAC Middleware (Next.js Server Route Handlers + Zod Validation)
        │
        ├──► PostgreSQL + Supabase Auth & Row-Level Security (20 Tables, Source of Truth)
        │
        └──► Durable Background Job Runner (Inngest / Idempotent Job Queue)
                ├──► Anthropic Claude 3.5 Sonnet SDK (Task Variation, 12-Part Explanation, Code Review)
                ├──► GitHub REST API + Webhooks (Least-Privilege Repo Fetch, File Filter, SHA Tracking)
                ├──► Google Workspace APIs (OAuth 2.0, Calendar Scheduling, Meet Records, Gmail Delivery)
                └──► Excel Synchronization Layer (Stage 1 Local XLSX/CSV & Stage 2 Microsoft Graph API)
```

## Project Structure

```
interviewflow-ai/
├── .env.example                                  # Categorized environment variable template
├── .gitignore                                    # Git ignore rules
├── package.json                                  # Dependencies and scripts
├── tsconfig.json                                 # TypeScript configuration
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql                # 20 PostgreSQL tables, indexes, enums, and RLS policies
├── data/
│   ├── sample_10_candidates.csv                  # 10 demonstration candidates for MVP evaluation
│   └── sample_100_candidates.csv                 # 100-candidate batch dataset for scale testing
├── src/
│   ├── app/
│   │   └── api/
│   │       ├── candidates/route.ts               # Candidate listing, search, pagination, CSV/XLSX import
│   │       ├── tasks/assign/route.ts             # Idempotent task assignment & variant selection
│   │       ├── submissions/route.ts              # GitHub URL validation & background review trigger
│   │       └── webhooks/github/route.ts          # HMAC-SHA256 verified GitHub webhook receiver
│   └── lib/
│       ├── server-context.ts                     # Server-side RBAC & platform singleton context
│       └── workflow/
│           └── engine.mjs                        # Complete persisted state machine & domain services
└── tests/
    └── run_all_tests.mjs                         # Automated test suite (11 test suites across 6 domains)
```

## Quick Start & Setup Instructions

1. **Clone & Install Dependencies**:
   ```bash
   npm install
   ```
2. **Configure Environment Variables**:
   ```bash
   cp .env.example .env.local
   ```
   Keep `SAFE_EMAIL_TEST_MODE=true` and `REQUIRE_ADMIN_EMAIL_APPROVAL=true` during initial setup so no external emails or calendar invites are dispatched until your credentials are verified.
3. **Apply Supabase Database Migrations**:
   ```bash
   npx supabase db push
   ```
4. **Run Automated Tests**:
   ```bash
   npm test
   ```
5. **Start Development Server**:
   ```bash
   npm run dev
   ```

## External API Configuration & Limitations

### 1. Google Workspace (OAuth 2.0, Calendar, Meet, Gmail)
- **Required Scopes**:
  - `https://www.googleapis.com/auth/calendar.events` (Create/update review appointments and attach Google Meet conferences)
  - `https://www.googleapis.com/auth/meetings.space.readonly` (Retrieve supported Google Meet conference metadata and participant records)
  - `https://www.googleapis.com/auth/gmail.send` (Send authorized assessment and feedback emails)
- **Known Limitations & Safeguards**:
  - Automatic Google Meet attendance reports require a qualifying Google Workspace edition and host organization permissions. Moreover, a participant's display name in Google Meet does not reliably identify a registered candidate. InterviewFlow AI enforces exact email matching or requires manual administrator confirmation (with CSV import and audited admin override fallbacks).

### 2. GitHub App Integration
- **Permissions (Least Privilege)**:
  - `Contents: Read-only` (Fetch `README.md`, source tree, and test files)
  - `Metadata: Read-only` (Verify repository accessibility, default branch, and commit SHA)
- **Security Controls**:
  - Untrusted candidate code is **never** executed on the main application server. Source inspection and static checks run first; runtime tests execute only when an isolated, network-disabled disposable sandbox (`SANDBOX_RUNNER_ENDPOINT`) is configured.
  - All repository content (`README.md`, comments, strings) is scanned for prompt-injection patterns and isolated as untrusted data.

### 3. Microsoft Graph Excel API (Stage 2 Live Sync)
- **Stage 1 (Default MVP)**: Full CSV/XLSX import and 6-sheet `.xlsx` workbook export work immediately without Microsoft Graph credentials.
- **Stage 2 (Live OneDrive / SharePoint Sync)**: Configure `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, and `EXCEL_WORKBOOK_ID` with `Files.ReadWrite.All` permissions. Records are upserted using stable UUID/code keys (`Candidate ID`, `Task ID`, `Review ID`), never row numbers.

## Deployment Guide

1. **Database**: Provision a Supabase PostgreSQL project and run `supabase/migrations/001_initial_schema.sql`. Enable Row-Level Security (RLS) on all candidate-facing tables.
2. **Background Worker**: Connect Inngest (`INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`) to `/api/inngest` for durable retries and exponential backoff.
3. **Hosting**: Deploy the Next.js application to Vercel or a container platform with environment variables configured in the provider secret store.

## Troubleshooting Guide

- **`ATTENDANCE_NOT_CONFIRMED` when assigning tasks**: Candidates must have `CONFIRMED` attendance before receiving a task. Confirm attendance in the Attendance tab or use the Admin Override toggle with a documented reason.
- **`UNCERTAIN_IDENTITY_MATCH` during Google Meet sync**: A participant joined Google Meet without an authenticated matching email address. Verify their identity manually in the Attendance table.
- **`OAUTH_TOKEN_EXPIRED` or `GMAIL_401` in Email/Calendar logs**: Re-authenticate the Google Workspace integration in **Integration Settings** and click **Retry Failed Operation** in the Failed Jobs / Email Logs screen (idempotency keys prevent duplicate sends).
