from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.config import settings
from app.core.database import get_db
from sqlalchemy.orm import Session
from app.models.models import User
import logging

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)

async def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> User:
    """Extract user from Cloudflare Access headers."""
    
    # In development, allow bypass
    if settings.DEBUG:
        email = request.headers.get("X-User-Email", "dev@example.com")
    else:
        email = request.headers.get(settings.CF_ACCESS_EMAIL_HEADER)
    
    if not email:
        raise HTTPException(status_code=401, detail="Authentication required")
    
    # Get or create user
    user = db.query(User).filter(User.email == email).first()
    if not user:
        is_admin = email in settings.admin_emails
        user = User(email=email, is_admin=is_admin)
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info(f"Created new user: {email} (admin={is_admin})")
    
    return user

async def get_admin_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """Verify user is admin."""
    # Explicitly cast to bool to satisfy type checking
    is_admin = bool(current_user.is_admin)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

def check_session_access(session, current_user: User) -> bool:
    """Check if user has access to a session."""
    if session.user_email == current_user.email:
        return True
    if current_user.email in (session.share_with_emails or []):
        return True
    # Explicitly cast to bool to satisfy type checking
    if bool(current_user.is_admin):
        return True
    return False