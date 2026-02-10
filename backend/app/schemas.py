from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from datetime import datetime

# Persona Schemas
class PersonaBase(BaseModel):
    id: str
    name: str
    role: str
    is_system: bool
    is_custom: bool
    profile_json: Dict[str, Any]

class PersonaResponse(PersonaBase):
    class Config:
        from_attributes = True

class PersonaCreate(BaseModel):
    profile_json: Dict[str, Any]

class PersonaUpdate(BaseModel):
    profile_json: Dict[str, Any]

class PersonaReloadResponse(BaseModel):
    message: str
    loaded: int
    removed: int

# Analysis Schemas
class AnalysisResponse(BaseModel):
    id: int
    persona_id: str
    persona_name: Optional[str]
    status: str
    score_json: Optional[Dict[str, Any]]
    top_issues_json: Optional[List[Dict[str, Any]]]
    rewritten_suggestions_json: Optional[Dict[str, Any]]
    error_message: Optional[str]

    class Config:
        from_attributes = True

# Session Schemas
class SessionResponse(BaseModel):
    id: str
    file_name: str
    file_metadata: Optional[Dict[str, Any]]
    selected_persona_ids: List[str]
    status: str
    share_with_emails: Optional[List[str]] = None
    analyses: Optional[List[AnalysisResponse]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class SessionCreate(BaseModel):
    selected_persona_ids: List[str]

class SessionShare(BaseModel):
    emails: List[str]

class AnalysisStartResponse(BaseModel):
    message: str
    session_id: str

# User Schemas
class UserResponse(BaseModel):
    email: str
    is_admin: bool
    created_at: datetime

    class Config:
        from_attributes = True