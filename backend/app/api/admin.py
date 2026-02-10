from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.core.database import get_db
from app.core.security import get_admin_user
from app.models.models import User, Session as SessionModel
from app.services.persona_service import PersonaService
from app.services.ai_backends import AIBackendFactory
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/users")
async def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """List all users (admin only)."""
    users = db.query(User).all()
    return [{
        "email": u.email,
        "is_admin": bool(u.is_admin),
        "created_at": u.created_at
    } for u in users]

@router.get("/sessions")
async def list_all_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """List all sessions (admin only)."""
    sessions = db.query(SessionModel).all()
    return [{
        "id": s.id,
        "user_email": s.user_email,
        "file_name": s.file_name,
        "status": s.status,
        "created_at": s.created_at
    } for s in sessions]

@router.get("/backends")
async def list_ai_backends(
    current_user: User = Depends(get_admin_user)
):
    """List available AI backends (admin only)."""
    available = AIBackendFactory.list_available_backends()
    return {
        "available": available,
        "default": "claude"
    }

@router.post("/personas/{persona_id}/promote")
async def promote_persona_to_system(
    persona_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """Promote a custom persona to system persona (admin only)."""
    persona = PersonaService.get_persona(db, persona_id)
    
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    
    if persona.is_system:
        raise HTTPException(status_code=400, detail="Persona is already a system persona")
    
    persona.is_system = True
    persona.is_custom = False
    db.commit()
    
    return {"message": f"Persona '{persona.name}' promoted to system persona"}