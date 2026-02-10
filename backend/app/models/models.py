from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Text, JSON
from sqlalchemy.orm import relationship
from app.core.database import Base
from datetime import datetime

class User(Base):
    __tablename__ = "users"
    
    email = Column(String, primary_key=True, index=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    sessions = relationship("Session", back_populates="user", cascade="all, delete-orphan")
    personas = relationship("PersonaProfile", back_populates="created_by", cascade="all, delete-orphan")

class PersonaProfile(Base):
    __tablename__ = "persona_profiles"
    
    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    role = Column(String, nullable=False)
    is_system = Column(Boolean, default=False)
    is_custom = Column(Boolean, default=False)
    created_by_email = Column(String, ForeignKey("users.email"), nullable=True)
    profile_json = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    created_by = relationship("User", back_populates="personas")
    analyses = relationship("Analysis", back_populates="persona", cascade="all, delete-orphan")

class Session(Base):
    __tablename__ = "sessions"
    
    id = Column(String, primary_key=True, index=True)
    user_email = Column(String, ForeignKey("users.email"), nullable=False)
    file_name = Column(String, nullable=False)
    file_metadata = Column(JSON, nullable=True)
    selected_persona_ids = Column(JSON, nullable=False)  # List of persona IDs
    status = Column(String, default="uploaded")  # uploaded, analyzing, completed, partial, failed
    share_with_emails = Column(JSON, default=list)  # List of emails
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User", back_populates="sessions")
    analyses = relationship("Analysis", back_populates="session", cascade="all, delete-orphan")

class Analysis(Base):
    __tablename__ = "analyses"
    
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    persona_id = Column(String, ForeignKey("persona_profiles.id"), nullable=False)
    status = Column(String, default="pending")  # pending, running, completed, failed
    score_json = Column(JSON, nullable=True)
    top_issues_json = Column(JSON, nullable=True)
    rewritten_suggestions_json = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    session = relationship("Session", back_populates="analyses")
    persona = relationship("PersonaProfile", back_populates="analyses")