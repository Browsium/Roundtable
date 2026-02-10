# Persona Roundtable Backend

FastAPI backend for the Persona Roundtable marketing copy review tool.

## Setup

1. Create virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the server:
```bash
python -m app.main
```

Or with uvicorn:
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## API Documentation

Once running, visit:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Configuration

Create a `.env` file in the backend directory:

```env
DEBUG=true
DATABASE_URL=sqlite:///./roundtable.db
ADMIN_USERS=matt@browsium.com
DEFAULT_AI_BACKEND=claude
AI_TIMEOUT=120
UPLOAD_DIR=./uploads
```

## AI Backends

The system supports multiple AI backends via CLI:

- **Claude Code** (`claude`): Primary backend
- **Codex CLI** (`codex`): OpenAI's CLI (not yet implemented)
- **Open Code** (`opencode`): This tool (not yet implemented)

Ensure the desired CLI is installed and authenticated before running analysis.

## Architecture

- **FastAPI**: Modern async Python web framework
- **SQLAlchemy**: Database ORM with SQLite (PostgreSQL-ready)
- **Pydantic**: Data validation and serialization
- **CLI Integration**: Spawns subprocesses for AI analysis
- **File Processing**: PyPDF2, python-docx, python-pptx for text extraction

## Persona System

Personas are stored as JSON files in `/personas/` and auto-loaded on startup:
- System personas: Pre-built, editable by admins
- Custom personas: User-created via Persona Builder UI
- Dynamic reloading: Admin endpoint to refresh from files