from pydantic_settings import BaseSettings
from typing import List

class Settings(BaseSettings):
    APP_NAME: str = "Persona Roundtable"
    DEBUG: bool = False
    
    # Database
    DATABASE_URL: str = "sqlite:///./roundtable.db"
    
    # Cloudflare Access
    CF_ACCESS_EMAIL_HEADER: str = "CF-Access-Authenticated-User-Email"
    CF_ACCESS_ID_HEADER: str = "CF-Access-Authenticated-User-Id"
    CF_ACCESS_IDP_HEADER: str = "CF-Access-Authenticated-User-Identity-Provider"
    
    # Admin users (comma-separated emails)
    ADMIN_USERS: str = "matt@browsium.com"
    
    # AI Backend Configuration
    DEFAULT_AI_BACKEND: str = "claude"  # claude, codex, or opencode
    AI_TIMEOUT: int = 120  # seconds per persona analysis
    AI_RETRY_ATTEMPTS: int = 3
    
    # File Upload
    MAX_FILE_SIZE_MB: int = 50
    UPLOAD_DIR: str = "./uploads"
    
    # Persona Files
    PERSONAS_DIR: str = "./personas"
    
    @property
    def admin_emails(self) -> List[str]:
        return [email.strip() for email in self.ADMIN_USERS.split(",")]
    
    class Config:
        env_file = ".env"

settings = Settings()