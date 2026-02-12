# Roundtable Architecture Document

## Overview

Roundtable is a web application that simulates a panel of cybersecurity personas evaluating marketing content. Each persona (CISO, CTO, CIO, etc.) provides specific, actionable feedback from their professional perspective.

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Infrastructure                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐          ┌──────────────────┐           │
│  │ Cloudflare      │          │ Cloudflare        │           │
│  │ Pages           │◄────────►│ Workers          │           │
│  │ (Frontend)      │          │ (API + DO)       │           │
│  │ roundtable.     │          │ roundtable-api.   │           │
│  │ browsium.com    │          │ workers.dev      │           │
│  └─────────────────┘          └────────┬─────────┘           │
│                                         │                    │
│                              ┌──────────┴──────────┐         │
│                              │                     │         │
│                        ┌─────▼─────┐   ┌─────────▼────┐   │
│                        │ D1         │   │ R2           │   │
│                        │ Database   │   │ Storage      │   │
│                        │            │   │              │   │
│                        └────────────┘   └──────────────┘   │
│                                                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ CF Access (Automatic)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ CLIBridge (OracleVM)                                        │
│                                                             │
│  ┌─────────────────────────────────────────────┐           │
│  │ CLIBridge Service                           │           │
│  │ clibridge.badrobots.net                     │           │
│  │                                             │           │
│  │  ┌─────────────────────────────────┐       │           │
│  │  │ Skills (Roundtable Personas)    │       │           │
│  │  │                                 │       │           │
│  │  │  • roundtable-ciso-v1.0.0       │       │           │
│  │  │  • roundtable-cto-v1.0.0        │       │           │
│  │  │  • roundtable-cio-v1.0.0        │       │           │
│  │  │  • [other personas...]          │       │           │
│  │  │                                 │       │           │
│  │  └─────────────────────────────────┘       │           │
│  │                                             │           │
│  └─────────────────────────────────────────────┘           │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────┐           │
│  │ Claude CLI                                  │           │
│  │ Subprocess execution                        │           │
│  └─────────────────────────────────────────────┘           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

#### 1. Cloudflare Pages (Frontend)
- **URL**: `https://roundtable.browsium.com`
- **Framework**: Next.js 14 with TypeScript
- **Authentication**: Cloudflare Access with email magic link
- **Responsibilities**:
  - Document upload interface
  - Persona selection and management
  - Real-time analysis display via WebSocket
  - Session history and results viewing

#### 2. Cloudflare Workers (API Layer)
- **URL**: `https://roundtable-api.browsium.workers.dev`
- **Components**:
  - HTTP API routes
  - Durable Objects for WebSocket connections
  - Document processing (extract text from PDF/DOCX/PPTX)
- **Responsibilities**:
  - Session CRUD operations
  - Persona CRUD operations
  - R2 presigned URL generation
  - Skill file generation and deployment
  - WebSocket handling for streaming analysis

#### 3. D1 Database (Metadata Storage)
- **Tables**:
  - `personas`: Persona definitions and skill mappings
  - `sessions`: Analysis sessions
  - `analyses`: Individual persona analyses
- **Responsibilities**:
  - Source of truth for persona data
  - Session state management
  - Analysis results storage

#### 4. R2 Storage (Document Storage)
- **Bucket**: `roundtable-documents` (private)
- **Responsibilities**:
  - Store uploaded documents
  - Serve documents via presigned URLs
  - Automatic cleanup after session completion

#### 5. CLIBridge (AI Service)
- **URL**: `https://clibridge.badrobots.net`
- **Location**: OracleVM
- **Responsibilities**:
  - Execute AI analysis via Claude CLI
  - Manage persona skills
  - Stream responses via SSE

#### 6. Persona Skills
- **Location**: `skills/roundtable/` in CLIBridge
- **Structure**: One skill per persona, versioned
- **Naming**: `roundtable-{persona_id}-v{version}`
- **Auto-cleanup**: Skills deleted after 60 days

## Data Flow

### Document Upload Flow

```
User uploads document
        │
        ▼
┌─────────────────────┐
│ 1. Frontend requests │
│    presigned R2 URL  │
│    from Workers      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. Frontend uploads  │
│    document to R2    │
│    directly          │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 3. Frontend creates │
│    session via      │
│    Workers API      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 4. Workers extracts  │
│    text from doc    │
│    and stores in D1 │
└─────────────────────┘
```

### Analysis Flow (Streaming)

```
User starts analysis
        │
        ▼
┌─────────────────────┐
│ 1. Frontend opens   │
│    WebSocket to     │
│    Durable Object   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. Durable Object     │
│    fetches document   │
│    and personas     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 3. For each persona:  │
│    Call CLIBridge     │
│    /v1/stream         │
│    (concurrent)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 4. Stream chunks    │
│    from CLIBridge   │
│    to WebSocket     │
│    (real-time)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 5. Final results    │
│    stored in D1     │
└─────────────────────┘
```

### Persona Creation Flow

```
User creates/edits persona
        │
        ▼
┌─────────────────────┐
│ 1. Frontend submits │
│    persona data     │
│    to Workers API   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. Workers inserts  │
│    into D1          │
│    (source of truth)│
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 3. Workers generates│
│    skill files:     │
│    - manifest.yaml  │
│    - analyze.tmpl   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 4. Workers uploads  │
│    skill to         │
│    CLIBridge via    │
│    /admin/skills/   │
│    upload           │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 5. CLIBridge        │
│    auto-reloads     │
│    skills           │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 6. Workers updates  │
│    D1 with          │
│    deployed status  │
└─────────────────────┘
```

## Key Design Decisions

### 1. Authentication
- **Method**: Cloudflare Access with email magic link
- **User Identity**: Extracted from `CF-Access-Authenticated-User-Email` header
- **Benefits**:
  - No password management
  - Automatic integration across all Cloudflare services
  - Secure by default

### 2. WebSocket vs SSE
- **Choice**: WebSocket (via Durable Objects)
- **Rationale**:
  - Better control over reconnection logic
  - Multiple concurrent analyses in one connection
  - Standardized across all modern browsers
  - Reconnection: 3 attempts with exponential backoff (2s, 4s, 8s)

### 3. D1 as Authoritative Source
- **Rationale**: D1 is the source of truth for persona data
- **Skills** are compiled/deployed versions for execution
- **Benefits**:
  - Easy querying and updates
  - Version history
  - Backup/recovery
  - Audit trail

### 4. Concurrent Analysis
- **Approach**: All personas analyzed simultaneously
- **Rationale**: CLIBridge spawns separate Claude processes, no shared state
- **Benefits**: Faster overall analysis time
- **Resource consideration**: 9 concurrent Claude processes on OracleVM

### 5. Skill Versioning
- **Pattern**: `roundtable-{persona_id}-v{major}.{minor}.{patch}`
- **Auto-increment**: Patch version on edit, minor on significant changes
- **Retention**: Skills auto-deleted after 60 days
- **Rollback**: Change `active_version` in D1 to point to previous skill

### 6. Document Processing
- **Location**: Workers (JavaScript libraries)
- **Libraries**:
  - PDF: `pdf-parse`
  - DOCX: `mammoth`
  - PPTX: `pptx-parser`
- **Rationale**: Single runtime, no Python service needed

### 7. Partial Results
- **Storage**: Memory only during streaming
- **Persistence**: Final results only saved to D1
- **Rationale**: Reduce database writes, acceptable for UX

## Security Considerations

### 1. Document Access
- R2 objects are private by default
- Presigned URLs with 1-hour expiry for downloads
- No public access to documents

### 2. Skill Upload Security
- Strict validation:
  - Skill name regex: `^roundtable-[a-z0-9-]+-v\d+\.\d+\.\d+$`
  - No path traversal (`..` rejected)
  - Template compilation check
  - File size limits (10KB manifest, 100KB template)
- Only Workers (via CF Access) can upload skills

### 3. Rate Limiting
- Upload: 10/minute per user
- Analysis: 100/hour per user
- Document size: 10MB max

### 4. Cleanup
- Documents: Auto-delete from R2 after 30 days
- Skills: Auto-delete after 60 days of inactivity
- Sessions: Soft delete, purge after 90 days

## Technology Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| API | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| WebSocket | Durable Objects (native WebSocket) |
| AI Backend | CLIBridge + Claude CLI |
| Document Processing | JavaScript libraries (pdf-parse, mammoth, pptx-parser) |
| Authentication | Cloudflare Access |

## Deployment

### Environment Variables

**Cloudflare Workers:**
- `CLIBRIDGE_URL`: `https://clibridge.badrobots.net`
- `R2_BUCKET_NAME`: `roundtable-documents`
- `D1_DATABASE_NAME`: `roundtable-db`

**CLIBridge (OracleVM):**
- `ROUNDTABLE_API_KEY`: Generated secure key
- `SKILLS_DIR`: `/opt/clibridge/skills`
- `MAX_SKILL_SIZE`: `104857600` (100MB)

### Domains
- Production: `https://roundtable.browsium.com`
- API: `https://roundtable-api.browsium.workers.dev`
- CLIBridge: `https://clibridge.badrobots.net`

## Monitoring

### Metrics to Track
1. Analysis completion rate
2. Average analysis duration per persona
3. WebSocket connection success/failure rate
4. Document upload success rate
5. Skill deployment success rate
6. Error rates by endpoint

### Logging
- Workers: Structured logging with request IDs
- CLIBridge: Existing logging with correlation IDs
- Frontend: Error tracking (Sentry recommended)

## Future Considerations

### Scalability
- Can add more personas (skills auto-scale)
- Can add parallel Workers for load balancing
- R2 and D1 scale automatically

### Features
- Export to PDF/DOCX
- Team collaboration
- A/B testing personas
- Trend analysis across revisions

### Integrations
- CRM connections (Salesforce, HubSpot)
- CMS integrations (Contentful, Sanity)
- Slack notifications

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2025-02-11 | 1.0 | Initial architecture document |
