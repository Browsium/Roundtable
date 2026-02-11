# Render Deployment Guide

## Quick Deploy (5 minutes)

This guide gets you running on Render's free tier with a cron job to prevent spin-down.

## Prerequisites

1. [Render.com](https://render.com) account (free)
2. [Cron-Job.org](https://cron-job.org) account (free) or similar
3. GitHub repo already pushed (✅ Done)

## Step 1: Create Web Service on Render

### Option A: Via Blueprint (Recommended)

1. Go to Render Dashboard
2. Click "New" → "Blueprint"
3. Connect your GitHub repo (Browsium/Roundtable)
4. Render will detect `render.yaml` and create the service automatically

### Option B: Manual Setup

1. Go to Render Dashboard
2. Click "New" → "Web Service"
3. Connect GitHub repo
4. Configure:
   - **Name**: roundtable-backend
   - **Runtime**: Python 3
   - **Build Command**: 
     ```bash
     pip install -r requirements.txt && curl -fsSL https://claude.ai/install.sh | sh
     ```
   - **Start Command**:
     ```bash
     export PATH="$HOME/.local/bin:$PATH" && uvicorn app.main:app --host 0.0.0.0 --port $PORT
     ```
5. Click "Create Web Service"

## Step 2: Configure Environment Variables

In Render Dashboard → Your Service → Environment:

```
ADMIN_USERS=matt@browsium.com
DATABASE_URL=sqlite:///./data/roundtable.db
PERSONAS_DIR=./personas
DEFAULT_AI_BACKEND=claude
AI_TIMEOUT=120
AI_RETRY_ATTEMPTS=3
MAX_FILE_SIZE_MB=50
```

## Step 3: Set Up Persistent Disk

1. In Render Dashboard → Disks
2. Create Disk:
   - **Name**: data
   - **Mount Path**: /opt/render/project/src/data
   - **Size**: 1 GB
3. Attach to your web service

This preserves:
- SQLite database
- Persona JSON files (if edited)
- Uploads

## Step 4: Authenticate Claude Code CLI

This is the tricky part. You have **two options**:

### Option A: One-Time Authentication (Recommended for MVP)

1. Wait for first deployment to complete (it will fail authentication)
2. In Render Dashboard → Shell, open a shell session:
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   claude auth login
   ```
3. Follow prompts to authenticate (you'll get a URL to visit)
4. Once complete, restart service

**Note**: Free tier instances restart periodically, so you'll need to re-auth occasionally.

### Option B: Environment Token (More Complex)

If you have a Claude API token:

1. Set environment variable in Render:
   ```
   CLAUDE_API_KEY=your-key-here
   ```

2. Modify backend to use API instead of CLI (requires code changes)

For MVP, **Option A** is fine.

## Step 5: Set Up Cron Job (Prevent Spin-Down)

### Using Cron-Job.org (Free)

1. Sign up at [cron-job.org](https://cron-job.org)
2. Create new cron job:
   - **Title**: Keep Roundtable Alive
   - **URL**: `https://your-service-name.onrender.com/health`
   - **Schedule**: Every 10 minutes
   - **HTTP Method**: GET
3. Save and enable

### Alternative: UptimeRobot (Free)

1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. Add new monitor:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: Roundtable Backend
   - **URL**: `https://your-service-name.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
3. This both keeps it awake AND monitors uptime

## Step 6: Update Frontend API URL

In your Cloudflare Pages deployment:

1. Set environment variable:
   ```
   NEXT_PUBLIC_API_URL=https://your-service-name.onrender.com
   ```

2. Redeploy frontend if needed

## Step 7: Test the Deployment

1. Visit: `https://your-service-name.onrender.com/health`
   - Should return: `{"status": "healthy"}`

2. Test via frontend:
   - Upload a document
   - Select personas
   - Start analysis
   - Monitor for ~10 minutes (9 personas × 1-2 min each)

## Troubleshooting

### Issue: Service keeps sleeping

**Problem**: Cron isn't hitting frequently enough

**Solution**: 
- Verify cron URL is correct
- Check that `/health` endpoint responds (not just `/`)
- Increase frequency to every 5 minutes

### Issue: Claude not found

**Problem**: CLI not in PATH

**Solution**: 
- SSH into Render shell
- Find claude: `find / -name claude 2>/dev/null`
- Update PATH in start command

### Issue: Database not persisting

**Problem**: Disk not mounted correctly

**Solution**:
- Verify `DATABASE_URL` points to `./data/roundtable.db`
- Ensure disk is attached and mounted at `/opt/render/project/src/data`

### Issue: Analysis times out

**Problem**: 9 personas × 120s = 18 minutes, may hit Render limits

**Solution**:
- Reduce `AI_TIMEOUT` to 60s
- Implement parallel processing (Phase 2 feature)
- Monitor logs for specific persona failures

### Issue: CORS errors

**Problem**: Frontend can't reach backend

**Solution**:
- Verify CORS is configured in `backend/app/main.py`
- Add your Cloudflare domain to allowed origins
- Check browser console for exact error

## Limitations of Render Free Tier

⚠️ **Be aware**:

1. **Spin-down**: Without cron, sleeps after 15 min
2. **Cold start**: 30 seconds to wake up
3. **RAM**: 512MB (may struggle with large files)
4. **CPU**: Shared, slower than dedicated
5. **Disk**: Ephemeral except for mounted disk
6. **Instance restarts**: Happens periodically (re-auth needed)

## When to Migrate

Consider moving to **Fly.io** or **Oracle Cloud** when:

- ❌ Cold starts become unacceptable
- ❌ Frequent re-authentication is annoying
- ❌ Need more RAM/CPU
- ❌ Want parallel processing
- ✅ Ready for production

## Next Steps

1. ✅ Deploy to Render (follow steps above)
2. ✅ Set up Cloudflare Pages for frontend
3. ⏳ Monitor for issues
4. ⏳ Plan migration to Fly.io/Oracle when ready

## Cost

- **Render**: $0 (Free tier)
- **Cron-Job.org**: $0 (Free tier)
- **Cloudflare Pages**: $0 (Free tier)
- **Total**: $0/month

## Support

- Render Docs: https://render.com/docs
- Claude Code Issues: https://github.com/anthropics/claude-code/issues
- Your Repo: https://github.com/Browsium/Roundtable