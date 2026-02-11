# Deployment Strategy for Persona Roundtable

## Overview

This document outlines the recommended deployment architecture and options for the Persona Roundtable application.

## Architecture

### Recommended: Cloudflare Pages + Oracle Cloud Free Tier

```
┌─────────────────┐         ┌──────────────────────┐
│  Cloudflare     │         │   Oracle Cloud       │
│    Pages        │◄───────►│   Free Tier VM       │
│  (Frontend)     │  HTTPS   │   (Backend + CLI)    │
└─────────────────┘         └──────────────────────┘
         │                           │
         │                           │
    Static assets               SQLite DB
    Next.js build               AI CLI tools
                                (Claude Code)
```

### Why This Architecture?

**Frontend on Cloudflare Pages:**
- ✅ Free tier with generous limits
- ✅ Global CDN (fast worldwide)
- ✅ Automatic deployments from GitHub
- ✅ Custom domains with SSL
- ✅ Perfect for Next.js static export

**Backend on Oracle Cloud Free Tier:**
- ✅ Always-free ARM instances (Ampere A1)
- ✅ 4 OCPUs, 24 GB RAM (very generous)
- ✅ Can install any CLI tools needed
- ✅ Persistent block storage
- ✅ Ubuntu/Oracle Linux support
- ✅ No sleep/spin-down like Render

## Deployment Steps

### 1. Frontend (Cloudflare Pages)

```bash
# Build the frontend for static export
cd frontend
npm run build

# Or use Cloudflare's Next.js adapter for full SSR
# (Requires @cloudflare/next-on-pages)
```

**Configuration:**
1. Connect GitHub repo to Cloudflare Pages
2. Set build command: `npm run build`
3. Set build output: `out` (static) or use adapter
4. Set environment variable: `NEXT_PUBLIC_API_URL=https://your-backend-url`

### 2. Backend (Oracle Cloud Free Tier)

**Step 1: Create VM Instance**
1. Sign up for Oracle Cloud Free Tier
2. Create Compute Instance:
   - Shape: VM.Standard.A1.Flex (ARM)
   - OCPUs: 1-4 (start with 1)
   - Memory: 6-24 GB (start with 6)
   - Image: Ubuntu 22.04
   - Boot volume: 50 GB

**Step 2: Setup Server**

```bash
# SSH into server
ssh ubuntu@<your-vm-ip>

# Update system
sudo apt update && sudo apt upgrade -y

# Install Python and dependencies
sudo apt install -y python3-pip python3-venv git

# Clone repository
git clone https://github.com/Browsium/Roundtable.git
cd Roundtable/backend

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install Claude Code CLI
curl -fsSL https://claude.ai/install.sh | sh
# Or follow Claude Code installation instructions

# Authenticate Claude Code
claude auth login

# Create systemd service
sudo nano /etc/systemd/system/roundtable.service
```

**Systemd Service File:**
```ini
[Unit]
Description=Persona Roundtable Backend
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Roundtable/backend
Environment="PATH=/home/ubuntu/Roundtable/backend/venv/bin:/usr/local/bin:/usr/bin"
Environment="PYTHONPATH=/home/ubuntu/Roundtable/backend"
ExecStart=/home/ubuntu/Roundtable/backend/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Start Service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable roundtable
sudo systemctl start roundtable

# Check status
sudo systemctl status roundtable
```

**Step 3: Configure Firewall**
```bash
# Open port 8000
sudo iptables -I INPUT -p tcp --dport 8000 -j ACCEPT
sudo netfilter-persistent save

# Or use Oracle Cloud Security List:
# Add Ingress Rule: TCP port 8000 from 0.0.0.0/0
```

**Step 4: Set Up Nginx (Optional but Recommended)**

```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/roundtable
```

**Nginx Config:**
```nginx
server {
    listen 80;
    server_name your-domain-or-ip;

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

```bash
sudo ln -s /etc/nginx/sites-available/roundtable /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**Step 5: SSL with Let's Encrypt**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Alternative Deployment Options

### Option 2: Render (Free Tier)

**Pros:**
- Super easy deployment
- GitHub integration
- Automatic deploys

**Cons:**
- Web services spin down after 15 min inactivity
- Cold start delay (~30 seconds)
- Need to install CLI in build step

**Setup:**
1. Create `render.yaml`:
```yaml
services:
  - type: web
    name: roundtable-backend
    runtime: python
    buildCommand: pip install -r requirements.txt && curl -fsSL https://claude.ai/install.sh | sh
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: PYTHON_VERSION
        value: 3.11.0
```

2. Environment variables in Render dashboard:
   - `DATABASE_URL`: SQLite path or PostgreSQL
   - `ADMIN_USERS`: matt@browsium.com

**Note:** For CLI authentication, you'd need to:
- Store auth token in environment variable
- Authenticate in build script

### Option 3: Railway

**Pros:**
- Easy deployment
- $5 free credit monthly
- Good for small projects

**Cons:**
- Paid for continuous usage
- Need to install CLI

### Option 4: Fly.io

**Pros:**
- Generous free tier
- Docker-based
- Global edge network

**Cons:**
- Need Docker knowledge
- CLI installation complexity

**Setup:**
```dockerfile
# Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN curl -fsSL https://claude.ai/install.sh | sh

# Copy requirements
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY backend/ .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```toml
# fly.toml
app = "roundtable-backend"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8000"

[[services]]
  internal_port = 8000
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

## CLI Authentication Strategy

### Critical Consideration

The backend requires authenticated CLI access (Claude Code). This is the main deployment challenge.

### Options:

**Option A: Interactive Auth (Development)**
- SSH into server
- Run `claude auth login`
- Authenticate manually
- Good for personal use

**Option B: Environment Token (Production)**
- Store API key/token in environment variable
- CLI reads from env var
- More complex but automated

**Option C: Pre-authenticated Docker Image**
- Build custom image with auth baked in
- Security concerns with embedded tokens

### Recommended: Option A for MVP

For the MVP, manual authentication is acceptable:
1. SSH into Oracle VM
2. Run `claude auth login` once
3. Token persists in home directory
4. Service uses that token

## Database Persistence

### SQLite (Current)
- Simple, file-based
- Works well for single-instance deployment
- Backup strategy: regular file backups

### PostgreSQL (Future)
If you need multi-instance or better reliability:
- Oracle Cloud offers managed PostgreSQL
- Or install PostgreSQL on same VM
- Update `DATABASE_URL` in config

## Security Considerations

1. **Cloudflare Access Integration**
   - Ensure `CF-Access-Authenticated-User-Email` header is passed
   - Configure in Cloudflare dashboard

2. **API Security**
   - Use HTTPS only
   - CORS configured for your domain
   - No API keys in code

3. **Server Security**
   - Firewall rules
   - Regular updates: `sudo apt update && sudo apt upgrade`
   - Fail2ban for SSH protection
   - Disable root login

4. **Secrets Management**
   - Never commit `.env` files
   - Use environment variables
   - Consider Oracle Cloud Secrets service

## Monitoring & Logs

### Backend Logs
```bash
# View logs
sudo journalctl -u roundtable -f

# Or use pm2
npm install -g pm2
pm2 start "uvicorn app.main:app --host 0.0.0.0 --port 8000" --name roundtable
pm2 logs
```

### Health Checks
- Backend: `/health` endpoint
- Set up UptimeRobot or similar for monitoring
- Alert on downtime

## Cost Breakdown

### Cloudflare Pages (Frontend)
- **Cost:** $0 (Free tier)
- **Limits:** Unlimited requests, 500 builds/month

### Oracle Cloud Free Tier (Backend)
- **Cost:** $0 (Always free resources)
- **Includes:**
  - 2 AMD-based Compute VMs
  - 4 ARM-based Ampere A1 cores
  - 24 GB RAM
  - 200 GB block storage
  - 10 TB outbound data transfer

### Total: $0/month for both services

## Deployment Checklist

### Pre-deployment
- [ ] Test locally with `python -m app.main`
- [ ] Ensure all environment variables are set
- [ ] Verify CLI authentication works
- [ ] Run database migrations (auto-created on first run)

### Frontend Deployment
- [ ] Build succeeds: `npm run build`
- [ ] Environment variables configured in Cloudflare
- [ ] Custom domain configured (optional)
- [ ] SSL certificate active

### Backend Deployment
- [ ] VM created and accessible
- [ ] Python dependencies installed
- [ ] CLI installed and authenticated
- [ ] Systemd service configured
- [ ] Firewall rules configured
- [ ] Nginx configured (optional)
- [ ] SSL configured (optional)
- [ ] Health endpoint responding

### Post-deployment
- [ ] Test file upload
- [ ] Test analysis flow
- [ ] Verify persona responses
- [ ] Check database persistence
- [ ] Monitor logs for errors
- [ ] Set up monitoring/alerts

## Troubleshooting

### Backend won't start
```bash
# Check logs
sudo journalctl -u roundtable -n 50

# Check port binding
sudo netstat -tlnp | grep 8000

# Test manually
cd /home/ubuntu/Roundtable/backend
source venv/bin/activate
python -m app.main
```

### CLI not found
```bash
# Check if claude is installed
which claude
claude --version

# If not in PATH, add to ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
```

### CORS errors
- Update `backend/app/main.py` CORS origins
- Add your Cloudflare domain to allowed origins

### Database locked
- SQLite doesn't support concurrent writes well
- Consider PostgreSQL if you need scaling

## Future Scaling

When ready to scale:
1. **PostgreSQL:** Move from SQLite to managed PostgreSQL
2. **Load Balancer:** Oracle Cloud Load Balancer
3. **Caching:** Redis for session state
4. **CDN:** Cloudflare for API responses
5. **Queue:** Celery for async analysis jobs

## Summary

**Recommended for MVP:**
- **Frontend:** Cloudflare Pages (free, fast, easy)
- **Backend:** Oracle Cloud Free Tier (powerful, always-on, free)

This gives you a production-ready setup at $0 cost with excellent performance.