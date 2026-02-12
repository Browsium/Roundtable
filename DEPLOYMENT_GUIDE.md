# Backend Deployment Guide

## Overview

The Roundtable backend is a FastAPI application that requires:
- Python 3.11+
- PostgreSQL database
- Environment variables for configuration

## Deployment Options

### Option 1: Cloudflare Workers (Recommended for Serverless)

#### Prerequisites
- Wrangler CLI installed: `npm install -g wrangler`
- Cloudflare account
- Database (Cloudflare D1 or external PostgreSQL)

#### Step 1: Prepare the Backend

1. **Install Python dependencies for Workers:**
   ```bash
   cd backend
   pip install -r requirements.txt
   ```

2. **Create Wrangler configuration:**
   ```toml
   # wrangler.toml
   name = "roundtable-backend"
   main = "app/main.py"
   compatibility_date = "2024-01-01"
   
   [env.production]
   vars = { ENVIRONMENT = "production" }
   
   # If using D1 database
   [[env.production.d1_databases]]
   binding = "DB"
   database_name = "roundtable-db"
   database_id = "your-database-id"
   ```

3. **Update database connection for serverless:**
   
   If using Cloudflare D1, modify `backend/app/db/base.py`:
   ```python
   # For D1 compatibility
   from sqlalchemy import create_engine
   import os
   
   DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./roundtable.db")
   engine = create_engine(DATABASE_URL)
   ```

#### Step 2: Set Up Database

**Option A: Cloudflare D1 (Serverless SQLite)**
```bash
# Create D1 database
wrangler d1 create roundtable-db

# Apply migrations
wrangler d1 execute roundtable-db --file=./backend/migrations/init.sql
```

**Option B: External PostgreSQL (Railway, Supabase, etc.)**
```bash
# Get connection string from your provider
# Example for Railway:
DATABASE_URL=postgresql://user:pass@roundtable-db.railway.app:5432/railway
```

#### Step 3: Configure Secrets

```bash
# Set environment variables
wrangler secret put DATABASE_URL
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

#### Step 4: Deploy

```bash
# Deploy to Cloudflare Workers
wrangler deploy

# Get your worker URL
wrangler deploy --dry-run  # Preview
wrangler deploy            # Production
```

#### Step 5: Update Frontend Settings

1. Go to your deployed frontend: `https://your-site.pages.dev/settings`
2. Set API URL to your worker: `https://roundtable-backend.your-account.workers.dev`
3. Save settings

---

### Option 2: Railway (Easiest Full-Stack)

#### Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your Roundtable repository

#### Step 2: Configure Services

**Add PostgreSQL Database:**
1. Click "New"
2. Select "Database" → "Add PostgreSQL"
3. Railway will automatically set `DATABASE_URL`

**Configure Backend Service:**
1. Select your backend service
2. Click "Settings" → "Build Command":
   ```
   pip install -r requirements.txt
   ```
3. Set "Start Command":
   ```
   uvicorn app.main:app --host 0.0.0.0 --port $PORT
   ```

#### Step 3: Set Environment Variables

Click "Variables" tab and add:
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
ENVIRONMENT=production
```

#### Step 4: Deploy

Railway auto-deploys on git push. Your backend URL will be:
`https://roundtable-backend-production.up.railway.app`

#### Step 5: Update Frontend

Go to `/settings` and set API URL to your Railway URL.

---

### Option 3: Render (Simple Alternative)

#### Step 1: Create Web Service

1. Go to [render.com](https://render.com)
2. Click "New Web Service"
3. Connect your GitHub repo
4. Configure:
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port 10000`

#### Step 2: Create PostgreSQL Database

1. Click "New PostgreSQL"
2. Copy the Internal Database URL

#### Step 3: Set Environment Variables

In your Web Service settings, add:
```
DATABASE_URL=postgresql://... (from step 2)
OPENAI_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
ENVIRONMENT=production
```

#### Step 4: Deploy

Render auto-deploys. URL format:
`https://roundtable-backend.onrender.com`

---

### Option 4: VPS (DigitalOcean, AWS, etc.)

#### Step 1: Set Up Server

```bash
# SSH into your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install dependencies
apt install -y python3-pip python3-venv postgresql postgresql-contrib nginx

# Create app directory
mkdir -p /var/www/roundtable
chown -R $USER:$USER /var/www/roundtable
```

#### Step 2: Configure PostgreSQL

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE roundtable;
CREATE USER roundtable_user WITH PASSWORD 'your-password';
GRANT ALL PRIVILEGES ON DATABASE roundtable TO roundtable_user;
\q
```

#### Step 3: Deploy Application

```bash
cd /var/www/roundtable

# Clone repository
git clone https://github.com/your-username/roundtable.git .

# Set up Python environment
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Set environment variables
export DATABASE_URL="postgresql://roundtable_user:your-password@localhost/roundtable"
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
export ENVIRONMENT="production"

# Run migrations
alembic upgrade head

# Install and configure Gunicorn
pip install gunicorn
```

#### Step 4: Create Systemd Service

```bash
sudo nano /etc/systemd/system/roundtable.service
```

Add:
```ini
[Unit]
Description=Roundtable Backend
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/roundtable/backend
Environment="PATH=/var/www/roundtable/backend/venv/bin"
Environment="DATABASE_URL=postgresql://roundtable_user:your-password@localhost/roundtable"
Environment="OPENAI_API_KEY=your-key"
Environment="ANTHROPIC_API_KEY=your-key"
Environment="ENVIRONMENT=production"
ExecStart=/var/www/roundtable/backend/venv/bin/gunicorn -w 4 -k uvicorn.workers.UvicornWorker app.main:app --bind 0.0.0.0:8000

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable roundtable
sudo systemctl start roundtable
sudo systemctl status roundtable
```

#### Step 5: Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/roundtable
```

Add:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/roundtable /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Step 6: Set Up SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## Post-Deployment Checklist

### 1. Test API Endpoints

```bash
# Health check
curl https://your-backend-url/health

# List personas
curl https://your-backend-url/api/personas

# Test file upload (optional)
curl -X POST -F "file=@test.pdf" https://your-backend-url/api/sessions/upload
```

### 2. Configure Frontend

1. Visit `/settings` on your frontend
2. Enter backend URL
3. Test the connection by navigating to `/personas`

### 3. Verify Database

```bash
# Connect to your database
# PostgreSQL:
psql $DATABASE_URL

# Check tables
\dt

# Verify data
SELECT * FROM personas;
```

### 4. Monitor Logs

**Cloudflare Workers:**
```bash
wrangler tail
```

**Railway:**
View logs in Railway dashboard

**Render:**
View logs in Render dashboard

**VPS:**
```bash
sudo journalctl -u roundtable -f
sudo tail -f /var/log/nginx/error.log
```

---

## Troubleshooting

### Database Connection Issues

1. Verify DATABASE_URL format: `postgresql://user:pass@host:port/dbname`
2. Check if database is accessible: `psql $DATABASE_URL`
3. Verify firewall rules allow connections

### CORS Errors

The backend already includes CORS middleware. If you still get errors:

```python
# In backend/app/main.py, update CORS origins:
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://your-frontend.pages.dev", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### File Upload Failures

1. Check file size limits (default 50MB)
2. Verify temp directory is writable
3. Check if upload directory exists:
   ```python
   import os
   os.makedirs("/tmp/uploads", exist_ok=True)
   ```

### Memory Issues

For large PDFs, increase worker timeout:
```bash
# Gunicorn
gunicorn -w 2 --timeout 120 app.main:app
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4 |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `ENVIRONMENT` | No | `development` or `production` |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

---

## Quick Reference Commands

```bash
# Test locally
cd backend
uvicorn app.main:app --reload

# Run migrations
alembic upgrade head

# Create migration
alembic revision --autogenerate -m "description"

# View logs
docker logs roundtable-backend  # if using Docker

# Check API
curl http://localhost:8000/health
```
