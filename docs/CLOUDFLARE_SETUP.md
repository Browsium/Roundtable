# Cloudflare Setup Guide

## Prerequisites

- Cloudflare account with access to Workers, D1, and R2
- Node.js and npm installed
- Git configured with access to Roundtable repository

## Step 1: Login to Cloudflare

```bash
# Install wrangler if not already installed
npm install -g wrangler

# Login to Cloudflare (opens browser)
npx wrangler login

# Verify login
npx wrangler whoami
```

**Expected Output:**
```
👋 You are logged in with an OAuth token.
🔓 Token Permissions: All access
👤 Account ID: YOUR_ACCOUNT_ID
```

**Save the Account ID** - you'll need it for GitHub secrets.

## Step 2: Create D1 Database

```bash
# Navigate to project root
cd /Users/matteller/Projects/Roundtable

# Create D1 database
npx wrangler d1 create roundtable-db
```

**Expected Output:**
```
✅ Successfully created DB 'roundtable-db' with ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Save the Database ID** - you'll need it for wrangler.toml.

## Step 3: Create R2 Bucket

```bash
# Create private R2 bucket
npx wrangler r2 bucket create roundtable-documents
```

**Expected Output:**
```
✅ Successfully created bucket 'roundtable-documents'
```

**Note:** Bucket is private by default. No additional configuration needed.

## Step 4: Create Workers Project

```bash
# Create new Workers directory
mkdir -p api
cd api

# Initialize Workers project
npx wrangler init
```

**When prompted:**
- Would you like to use git? (Y/n): **n** (we're already in a git repo)
- What would you like to start with? **Hello World example**
- Which language do you want to use? **TypeScript**
- Would you like to install dependencies? (Y/n): **Y**

## Step 5: Configure GitHub Secrets

Go to: `https://github.com/USER/Roundtable/settings/secrets/actions`

Create these repository secrets:

### Secret 1: CF_ACCOUNT_ID
- **Name**: `CF_ACCOUNT_ID`
- **Value**: [Your Cloudflare account ID from Step 1]

### Secret 2: CF_API_TOKEN
- **Name**: `CF_API_TOKEN`
- **Value**: Create at https://dash.cloudflare.com/profile/api-tokens
  - Token name: `Roundtable Workers Deployment`
  - Permissions:
    - Zone:Read (if using custom domain)
    - Account:Read
    - Workers Scripts:Edit
    - Workers KV Storage:Edit
    - D1:Edit
    - R2:Edit
  - Account Resources: Include all accounts
  - Zone Resources: Include all zones (or specific zone for roundtable.browsium.com)

### Secret 3: CLIBRIDGE_CLIENT_ID
- **Name**: `CLIBRIDGE_CLIENT_ID`
- **Value**: [Set in your password manager / internal notes. Do not commit.]

### Secret 4: CLIBRIDGE_CLIENT_SECRET
- **Name**: `CLIBRIDGE_CLIENT_SECRET`
- **Value**: [Set in your password manager / internal notes. Do not commit.]

### Secret 5: CLIBRIDGE_API_KEY
- **Name**: `CLIBRIDGE_API_KEY`
- **Value**: [Set in your password manager / internal notes. Do not commit.]

## Step 6: Configure wrangler.toml

Create `/Users/matteller/Projects/Roundtable/api/wrangler.toml`:

```toml
name = "roundtable-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "roundtable-db"
database_id = "YOUR_DATABASE_ID_HERE"  # From Step 2

# R2 Bucket
[[r2_buckets]]
binding = "R2"
bucket_name = "roundtable-documents"

# Environment Variables
[vars]
CLIBRIDGE_URL = "https://bypass.badrobots.net/clibridge"

# Secrets (add via wrangler secret or GitHub Actions)
# CLIBRIDGE_CLIENT_ID
# CLIBRIDGE_CLIENT_SECRET
# CLIBRIDGE_API_KEY

# Durable Objects
[[durable_objects.bindings]]
name = "SESSION_ANALYZER"
class_name = "SessionAnalyzer"

[[migrations]]
tag = "v1"
new_classes = ["SessionAnalyzer"]
```

**Replace `YOUR_DATABASE_ID_HERE` with the ID from Step 2.**

## Step 7: Verify Setup

```bash
# Test D1 connection
cd /Users/matteller/Projects/Roundtable/api
npx wrangler d1 execute roundtable-db --command="SELECT 1"

# Expected output: 1

# Test R2 bucket
npx wrangler r2 object list roundtable-documents

# Expected output: (empty list is OK)

# Deploy Workers (dry run)
npx wrangler deploy --dry-run
```

## Step 8: Database Schema

Run the schema migration:

```bash
npx wrangler d1 execute roundtable-db --file=../schema.sql
```

Create `/Users/matteller/Projects/Roundtable/schema.sql`:

```sql
-- personas table (source of truth)
CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  version TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  is_system BOOLEAN DEFAULT 1,
  status TEXT DEFAULT 'draft',
  created_at TEXT,
  updated_at TEXT,
  deployed_at TEXT
);

-- sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_r2_key TEXT NOT NULL,
  file_size_bytes INTEGER,
  file_extension TEXT,
  selected_persona_ids TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- analyses table
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT,
  score_json TEXT,
  top_issues_json TEXT,
  rewritten_suggestions_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);
```

## Step 9: Create GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Workers

on:
  push:
    branches:
      - main
    paths:
      - 'api/**'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        working-directory: ./api
        run: npm ci
      
      - name: Deploy to Cloudflare
        working-directory: ./api
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

## Step 10: Cleanup Workflow

Create `.github/workflows/cleanup-skills.yml`:

```yaml
name: Cleanup Old Skills

on:
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight UTC
  workflow_dispatch:

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Cleanup old skills
        run: |
          curl -X POST https://bypass.badrobots.net/clibridge/admin/skills/cleanup \
            -H "CF-Access-Client-Id: ${{ secrets.CLIBRIDGE_CLIENT_ID }}" \
            -H "CF-Access-Client-Secret: ${{ secrets.CLIBRIDGE_CLIENT_SECRET }}" \
            -H "X-API-Key: ${{ secrets.CLIBRIDGE_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"skill_prefix":"roundtable-","older_than_days":60}'
```

## Summary of Created Resources

| Resource | Name | ID/Status |
|----------|------|-----------|
| D1 Database | roundtable-db | [Your ID] |
| R2 Bucket | roundtable-documents | ✅ Created |
| Workers Project | roundtable-api | [Not yet deployed] |

## GitHub Secrets Summary

| Secret Name | Purpose |
|-------------|---------|
| `CF_ACCOUNT_ID` | Cloudflare account identification |
| `CF_API_TOKEN` | Workers deployment authorization |
| `CLIBRIDGE_CLIENT_ID` | CLIBridge bypass authentication |
| `CLIBRIDGE_CLIENT_SECRET` | CLIBridge bypass authentication |
| `CLIBRIDGE_API_KEY` | CLIBridge API authorization |

## Next Steps

1. ✅ Run the commands above
2. ✅ Update wrangler.toml with your Database ID
3. ✅ Create all GitHub secrets
4. ✅ Commit wrangler.toml and GitHub workflows
5. ⏳ Wait for CLIBridge skill upload endpoint to be ready
6. ⏳ Begin implementation (Phase 2)

## Troubleshooting

### D1 Connection Issues
```bash
# List all D1 databases
npx wrangler d1 list

# Execute command with verbose output
npx wrangler d1 execute roundtable-db --command="SELECT 1" --verbose
```

### R2 Permission Issues
```bash
# Verify bucket exists
npx wrangler r2 bucket list

# Check bucket info
npx wrangler r2 bucket info roundtable-documents
```

### Workers Deployment Issues
```bash
# Check wrangler.toml syntax
npx wrangler deploy --dry-run

# Validate configuration
npx wrangler config validate
```

## Important Notes

- **Do not commit secrets** to the repository
- **wrangler.toml** can be committed (contains no secrets)
- **API credentials** for CLIBridge are in GitHub secrets only
- **Database ID** in wrangler.toml is safe to commit (not a secret)

---

**Document Status**: Setup guide  
**Last Updated**: 2025-02-11
