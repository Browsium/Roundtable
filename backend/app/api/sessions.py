from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import List, Optional
import json
import uuid
import os
from pathlib import Path
from app.core.database import get_db
from app.core.security import get_current_user, check_session_access
from app.core.config import settings
from app.models.models import User, Session as SessionModel, Analysis
from app.services.document_processor import DocumentProcessor
from app.services.analysis_service import AnalysisService
from app.schemas.schemas import SessionCreate, SessionResponse, AnalysisResponse, SessionShare
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/", response_model=SessionResponse)
async def create_session(
    file: UploadFile = File(...),
    selected_persona_ids: str = Form(...),  # JSON string
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a new session with uploaded file and selected personas."""
    try:
        # Parse selected persona IDs
        persona_ids = json.loads(selected_persona_ids)
        if not persona_ids:
            raise HTTPException(status_code=400, detail="No personas selected")
        
        # Save uploaded file temporarily
        session_id = str(uuid.uuid4())
        upload_dir = Path(settings.UPLOAD_DIR)
        upload_dir.mkdir(parents=True, exist_ok=True)
        
        file_path = upload_dir / f"{session_id}_{file.filename}"
        
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        # Extract text from file
        try:
            result = DocumentProcessor.process_file(str(file_path))
            document_text = result["text"]
            file_metadata = result["metadata"]
            
            # Try to extract version from filename
            version = DocumentProcessor.get_file_version(str(file_path))
            if version:
                file_metadata["version"] = version
                
        except Exception as e:
            # Clean up uploaded file
            os.remove(file_path)
            raise HTTPException(status_code=400, detail=f"Failed to process document: {e}")
        
        # Create session record
        session = SessionModel(
            id=session_id,
            user_email=current_user.email,
            file_name=file.filename,
            file_metadata=file_metadata,
            selected_persona_ids=persona_ids,
            status="uploaded",
            document_text=document_text  # Store extracted text
        )
        
        db.add(session)
        db.commit()
        db.refresh(session)
        
        # Clean up uploaded file (we only store extracted text)
        os.remove(file_path)
        
        return SessionResponse(
            id=session.id,
            file_name=session.file_name,
            file_metadata=session.file_metadata,
            selected_persona_ids=session.selected_persona_ids,
            status=session.status,
            created_at=session.created_at
        )
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid persona selection format")
    except Exception as e:
        logger.error(f"Error creating session: {e}")
        raise HTTPException(status_code=500, detail="Failed to create session")

@router.get("/", response_model=List[SessionResponse])
async def list_sessions(
    include_shared: bool = True,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List user's sessions (optionally including shared sessions)."""
    query = db.query(SessionModel).filter(SessionModel.user_email == current_user.email)
    
    if include_shared:
        # Also include sessions shared with user
        shared_query = db.query(SessionModel).filter(
            SessionModel.share_with_emails.contains([current_user.email])
        )
        sessions = query.union(shared_query).all()
    else:
        sessions = query.all()
    
    return [SessionResponse(
        id=s.id,
        file_name=s.file_name,
        file_metadata=s.file_metadata,
        selected_persona_ids=s.selected_persona_ids,
        status=s.status,
        created_at=s.created_at
    ) for s in sessions]

@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get session details and results."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check access
    if not check_session_access(session, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Load analyses
    analyses = db.query(Analysis).filter(Analysis.session_id == session_id).all()
    
    return SessionResponse(
        id=session.id,
        file_name=session.file_name,
        file_metadata=session.file_metadata,
        selected_persona_ids=session.selected_persona_ids,
        status=session.status,
        share_with_emails=session.share_with_emails,
        analyses=[AnalysisResponse(
            id=a.id,
            persona_id=a.persona_id,
            persona_name=a.persona.name if a.persona else None,
            status=a.status,
            score_json=a.score_json,
            top_issues_json=a.top_issues_json,
            rewritten_suggestions_json=a.rewritten_suggestions_json,
            error_message=a.error_message
        ) for a in analyses],
        created_at=session.created_at,
        updated_at=session.updated_at
    )

@router.post("/{session_id}/analyze")
async def start_analysis(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Start analysis for a session."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check ownership
    if session.user_email != current_user.email:
        raise HTTPException(status_code=403, detail="Only the owner can start analysis")
    
    if session.status in ["analyzing", "completed"]:
        raise HTTPException(status_code=400, detail=f"Analysis already {session.status}")
    
    try:
        # Initialize analysis service
        service = AnalysisService(db)
        await service.initialize_backend()
        
        # Start analysis (this runs in background)
        import asyncio
        asyncio.create_task(
            service.analyze_document(
                session_id=session_id,
                document_text=session.document_text,
                selected_persona_ids=session.selected_persona_ids,
                sequential=True  # MVP uses sequential
            )
        )
        
        return {"message": "Analysis started", "session_id": session_id}
        
    except Exception as e:
        logger.error(f"Error starting analysis: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start analysis: {e}")

@router.post("/{session_id}/retry/{persona_id}")
async def retry_analysis(
    session_id: str,
    persona_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Retry a failed analysis for a specific persona."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check ownership
    if session.user_email != current_user.email:
        raise HTTPException(status_code=403, detail="Only the owner can retry analysis")
    
    analysis = db.query(Analysis).filter(
        Analysis.session_id == session_id,
        Analysis.persona_id == persona_id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    
    if analysis.status != "failed":
        raise HTTPException(status_code=400, detail="Analysis is not in failed state")
    
    try:
        # Initialize analysis service
        service = AnalysisService(db)
        await service.initialize_backend()
        
        # Retry analysis
        result = await service.retry_failed_analysis(
            session_id=session_id,
            persona_id=persona_id,
            document_text=session.document_text
        )
        
        return result
        
    except Exception as e:
        logger.error(f"Error retrying analysis: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retry analysis: {e}")

@router.post("/{session_id}/share")
async def share_session(
    session_id: str,
    share_data: SessionShare,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Share a session with specific users."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check ownership
    if session.user_email != current_user.email:
        raise HTTPException(status_code=403, detail="Only the owner can share sessions")
    
    # Update share list
    current_shares = session.share_with_emails or []
    for email in share_data.emails:
        if email not in current_shares:
            current_shares.append(email)
    
    session.share_with_emails = current_shares
    db.commit()
    
    return {"message": "Session shared successfully", "shared_with": current_shares}

@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Delete a session."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check ownership
    if session.user_email != current_user.email:
        raise HTTPException(status_code=403, detail="Only the owner can delete sessions")
    
    db.delete(session)
    db.commit()
    
    return {"message": "Session deleted successfully"}