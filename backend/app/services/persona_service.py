import json
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.models.models import PersonaProfile
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)

class PersonaService:
    """Service for managing persona profiles."""
    
    @staticmethod
    def load_system_personas(db: Session) -> None:
        """Load system personas from JSON files into database."""
        personas_dir = Path(settings.PERSONAS_DIR)
        
        if not personas_dir.exists():
            logger.warning(f"Personas directory not found: {personas_dir}")
            return
        
        for json_file in personas_dir.glob("*.json"):
            try:
                with open(json_file, 'r', encoding='utf-8') as f:
                    profile_data = json.load(f)
                
                persona_id = profile_data.get('id')
                if not persona_id:
                    logger.warning(f"Persona file {json_file} missing 'id' field")
                    continue
                
                # Check if persona already exists
                existing = db.query(PersonaProfile).filter(
                    PersonaProfile.id == persona_id
                ).first()
                
                if existing:
                    # Update existing persona
                    existing.profile_json = profile_data
                    existing.name = profile_data.get('name', existing.name)
                    existing.role = profile_data.get('role', existing.role)
                    logger.info(f"Updated system persona: {persona_id}")
                else:
                    # Create new system persona
                    persona = PersonaProfile(
                        id=persona_id,
                        name=profile_data.get('name', 'Unknown'),
                        role=profile_data.get('role', 'Unknown'),
                        is_system=True,
                        is_custom=False,
                        profile_json=profile_data
                    )
                    db.add(persona)
                    logger.info(f"Created system persona: {persona_id}")
                
                db.commit()
                
            except Exception as e:
                logger.error(f"Error loading persona from {json_file}: {e}")
                db.rollback()
    
    @staticmethod
    def get_all_personas(db: Session, user_email: Optional[str] = None) -> List[PersonaProfile]:
        """Get all available personas (system + user's custom)."""
        query = db.query(PersonaProfile)
        
        if user_email:
            # System personas + user's custom personas
            query = query.filter(
                (PersonaProfile.is_system == True) | 
                (PersonaProfile.created_by_email == user_email)
            )
        else:
            # Only system personas
            query = query.filter(PersonaProfile.is_system == True)
        
        return query.all()
    
    @staticmethod
    def get_persona(db: Session, persona_id: str, user_email: Optional[str] = None) -> Optional[PersonaProfile]:
        """Get a specific persona by ID."""
        query = db.query(PersonaProfile).filter(PersonaProfile.id == persona_id)
        
        if user_email:
            # Must be system or owned by user
            query = query.filter(
                (PersonaProfile.is_system == True) | 
                (PersonaProfile.created_by_email == user_email)
            )
        else:
            query = query.filter(PersonaProfile.is_system == True)
        
        return query.first()
    
    @staticmethod
    def create_custom_persona(
        db: Session, 
        user_email: str, 
        persona_data: Dict[str, Any]
    ) -> PersonaProfile:
        """Create a new custom persona."""
        persona_id = persona_data.get('id')
        if not persona_id:
            raise ValueError("Persona must have an 'id' field")
        
        # Check if ID already exists
        existing = db.query(PersonaProfile).filter(PersonaProfile.id == persona_id).first()
        if existing:
            raise ValueError(f"Persona with ID '{persona_id}' already exists")
        
        persona = PersonaProfile(
            id=persona_id,
            name=persona_data.get('name', 'Unnamed Persona'),
            role=persona_data.get('role', 'Unknown Role'),
            is_system=False,
            is_custom=True,
            created_by_email=user_email,
            profile_json=persona_data
        )
        
        db.add(persona)
        db.commit()
        db.refresh(persona)
        
        return persona
    
    @staticmethod
    def update_persona(
        db: Session,
        persona_id: str,
        user_email: str,
        is_admin: bool,
        persona_data: Dict[str, Any]
    ) -> Optional[PersonaProfile]:
        """Update a persona. Only admins can update system personas."""
        persona = db.query(PersonaProfile).filter(PersonaProfile.id == persona_id).first()
        
        if not persona:
            return None
        
        # Check permissions
        if persona.is_system and not is_admin:
            raise PermissionError("Only admins can update system personas")
        
        if not persona.is_system and persona.created_by_email != user_email:
            raise PermissionError("You can only update your own custom personas")
        
        # Update fields
        persona.name = persona_data.get('name', persona.name)
        persona.role = persona_data.get('role', persona.role)
        persona.profile_json = persona_data
        
        db.commit()
        db.refresh(persona)
        
        return persona
    
    @staticmethod
    def delete_persona(
        db: Session,
        persona_id: str,
        user_email: str,
        is_admin: bool
    ) -> bool:
        """Delete a persona. Only admins can delete system personas."""
        persona = db.query(PersonaProfile).filter(PersonaProfile.id == persona_id).first()
        
        if not persona:
            return False
        
        # Check permissions
        if persona.is_system and not is_admin:
            raise PermissionError("Only admins can delete system personas")
        
        if not persona.is_system and persona.created_by_email != user_email:
            raise PermissionError("You can only delete your own custom personas")
        
        db.delete(persona)
        db.commit()
        
        return True
    
    @staticmethod
    def reload_personas_from_files(db: Session) -> Dict[str, int]:
        """Reload all system personas from JSON files."""
        # First, mark all system personas for potential deletion
        system_personas = db.query(PersonaProfile).filter(
            PersonaProfile.is_system == True
        ).all()
        
        existing_ids = {p.id for p in system_personas}
        loaded_ids = set()
        
        personas_dir = Path(settings.PERSONAS_DIR)
        
        if personas_dir.exists():
            for json_file in personas_dir.glob("*.json"):
                try:
                    with open(json_file, 'r', encoding='utf-8') as f:
                        profile_data = json.load(f)
                    
                    persona_id = profile_data.get('id')
                    if not persona_id:
                        continue
                    
                    existing = db.query(PersonaProfile).filter(
                        PersonaProfile.id == persona_id
                    ).first()
                    
                    if existing:
                        existing.profile_json = profile_data
                        existing.name = profile_data.get('name', existing.name)
                        existing.role = profile_data.get('role', existing.role)
                    else:
                        persona = PersonaProfile(
                            id=persona_id,
                            name=profile_data.get('name', 'Unknown'),
                            role=profile_data.get('role', 'Unknown'),
                            is_system=True,
                            is_custom=False,
                            profile_json=profile_data
                        )
                        db.add(persona)
                    
                    loaded_ids.add(persona_id)
                    
                except Exception as e:
                    logger.error(f"Error loading persona from {json_file}: {e}")
        
        # Remove system personas that no longer have files
        for persona_id in existing_ids - loaded_ids:
            persona = db.query(PersonaProfile).filter(PersonaProfile.id == persona_id).first()
            if persona:
                db.delete(persona)
        
        db.commit()
        
        return {
            "loaded": len(loaded_ids),
            "removed": len(existing_ids - loaded_ids)
        }