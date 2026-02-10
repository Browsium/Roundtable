from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import logging

from app.core.config import settings
from app.core.database import engine, Base, SessionLocal
from app.api import personas, sessions, admin
from app.services.persona_service import PersonaService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    logger.info("Starting up Persona Roundtable API...")
    
    # Create database tables
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created")
    
    # Load system personas
    db = SessionLocal()
    try:
        PersonaService.load_system_personas(db)
        logger.info("System personas loaded")
    except Exception as e:
        logger.error(f"Error loading system personas: {e}")
    finally:
        db.close()
    
    yield
    
    # Shutdown
    logger.info("Shutting down...")

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(personas.router, prefix="/api/personas", tags=["personas"])
app.include_router(sessions.router, prefix="/api/sessions", tags=["sessions"])
app.include_router(admin.router, prefix="/api/admin", tags=["admin"])

@app.get("/")
async def root():
    return {
        "message": "Persona Roundtable API",
        "version": "1.0.0",
        "docs": "/docs"
    }

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)