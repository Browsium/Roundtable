from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.core.database import get_db
from app.core.security import get_current_user, get_admin_user
from app.models.models import User, PersonaProfile
from app.services.persona_service import PersonaService
from app.schemas.schemas import PersonaCreate, PersonaUpdate, PersonaResponse, PersonaReloadResponse
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/", response_model=List[PersonaResponse])
async def list_personas(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List all available personas (system + user's custom)."""
    personas = PersonaService.get_all_personas(db, current_user.email)
    return [PersonaResponse(
        id=p.id,
        name=p.name,
        role=p.role,
        is_system=p.is_system,
        is_custom=p.is_custom,
        profile_json=p.profile_json
    ) for p in personas]

@router.get("/{persona_id}", response_model=PersonaResponse)
async def get_persona(
    persona_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get a specific persona by ID."""
    persona = PersonaService.get_persona(db, persona_id, current_user.email)
    
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    
    return PersonaResponse(
        id=persona.id,
        name=persona.name,
        role=persona.role,
        is_system=persona.is_system,
        is_custom=persona.is_custom,
        profile_json=persona.profile_json
    )

@router.post("/", response_model=PersonaResponse)
async def create_persona(
    persona_data: PersonaCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a new custom persona."""
    try:
        persona = PersonaService.create_custom_persona(
            db,
            current_user.email,
            persona_data.profile_json
        )
        
        return PersonaResponse(
            id=persona.id,
            name=persona.name,
            role=persona.role,
            is_system=persona.is_system,
            is_custom=persona.is_custom,
            profile_json=persona.profile_json
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating persona: {e}")
        raise HTTPException(status_code=500, detail="Failed to create persona")

@router.put("/{persona_id}", response_model=PersonaResponse)
async def update_persona(
    persona_id: str,
    persona_data: PersonaUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update a persona. Only admins can update system personas."""
    try:
        is_admin = bool(current_user.is_admin)
        persona = PersonaService.update_persona(
            db,
            persona_id,
            current_user.email,
            is_admin,
            persona_data.profile_json
        )
        
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")
        
        return PersonaResponse(
            id=persona.id,
            name=persona.name,
            role=persona.role,
            is_system=persona.is_system,
            is_custom=persona.is_custom,
            profile_json=persona.profile_json
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"Error updating persona: {e}")
        raise HTTPException(status_code=500, detail="Failed to update persona")

@router.delete("/{persona_id}")
async def delete_persona(
    persona_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Delete a persona. Only admins can delete system personas."""
    try:
        is_admin = bool(current_user.is_admin)
        success = PersonaService.delete_persona(
            db,
            persona_id,
            current_user.email,
            is_admin
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="Persona not found")
        
        return {"message": "Persona deleted successfully"}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"Error deleting persona: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete persona")

@router.post("/reload", response_model=PersonaReloadResponse)
async def reload_personas(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """Reload system personas from JSON files (admin only)."""
    try:
        result = PersonaService.reload_personas_from_files(db)
        return PersonaReloadResponse(
            message="Personas reloaded successfully",
            loaded=result["loaded"],
            removed=result["removed"]
        )
    except Exception as e:
        logger.error(f"Error reloading personas: {e}")
        raise HTTPException(status_code=500, detail="Failed to reload personas")