import asyncio
import logging
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.models.models import Session as SessionModel, Analysis, PersonaProfile
from app.services.ai_backends import AIBackendFactory
from app.services.persona_service import PersonaService
from app.core.config import settings

logger = logging.getLogger(__name__)

class AnalysisService:
    """Service for orchestrating roundtable analysis."""
    
    def __init__(self, db: Session):
        self.db = db
        self.backend = None
    
    async def initialize_backend(self, backend_name: Optional[str] = None):
        """Initialize the AI backend."""
        try:
            self.backend = AIBackendFactory.get_backend(backend_name)
            logger.info(f"Initialized AI backend: {backend_name or settings.DEFAULT_AI_BACKEND}")
        except Exception as e:
            logger.error(f"Failed to initialize AI backend: {e}")
            raise
    
    async def analyze_document(
        self,
        session_id: str,
        document_text: str,
        selected_persona_ids: List[str],
        sequential: bool = True  # For MVP, sequential is safer
    ) -> Dict[str, Any]:
        """Analyze a document with selected personas."""
        
        # Get session
        session = self.db.query(SessionModel).filter(SessionModel.id == session_id).first()
        if not session:
            raise ValueError(f"Session not found: {session_id}")
        
        # Update session status
        session.status = "analyzing"
        self.db.commit()
        
        # Get personas
        personas = []
        for persona_id in selected_persona_ids:
            persona = PersonaService.get_persona(self.db, persona_id)
            if persona:
                personas.append(persona)
        
        if not personas:
            session.status = "failed"
            self.db.commit()
            raise ValueError("No valid personas selected")
        
        # Create analysis records
        analyses = []
        for persona in personas:
            analysis = Analysis(
                session_id=session_id,
                persona_id=persona.id,
                status="pending"
            )
            self.db.add(analysis)
            analyses.append((analysis, persona))
        
        self.db.commit()
        
        # Run analyses
        if sequential:
            results = await self._run_sequential_analyses(analyses, document_text)
        else:
            results = await self._run_parallel_analyses(analyses, document_text)
        
        # Update session status based on results
        failed_count = sum(1 for r in results if r.get('status') == 'failed')
        completed_count = sum(1 for r in results if r.get('status') == 'completed')
        
        if failed_count == len(results):
            session.status = "failed"
        elif failed_count > 0:
            session.status = "partial"
        else:
            session.status = "completed"
        
        self.db.commit()
        
        return {
            "session_id": session_id,
            "total_personas": len(personas),
            "completed": completed_count,
            "failed": failed_count,
            "results": results
        }
    
    async def _run_sequential_analyses(
        self,
        analyses: List[tuple],
        document_text: str
    ) -> List[Dict[str, Any]]:
        """Run analyses sequentially (safer for MVP)."""
        results = []
        
        for analysis, persona in analyses:
            try:
                # Update status to running
                analysis.status = "running"
                self.db.commit()
                
                # Run analysis
                profile_data = persona.profile_json
                result = await self.backend.run_analysis(profile_data, document_text)
                
                # Update analysis record
                analysis.status = "completed"
                analysis.score_json = result.get('dimension_scores')
                analysis.top_issues_json = result.get('top_3_issues')
                analysis.rewritten_suggestions_json = {
                    "what_works_well": result.get('what_works_well', []),
                    "overall_verdict": result.get('overall_verdict', ''),
                    "rewritten_headline": result.get('rewritten_headline_suggestion', '')
                }
                self.db.commit()
                
                results.append({
                    "persona_id": persona.id,
                    "persona_name": persona.name,
                    "status": "completed",
                    "result": result
                })
                
            except Exception as e:
                logger.error(f"Analysis failed for persona {persona.id}: {e}")
                
                # Update analysis record
                analysis.status = "failed"
                analysis.error_message = str(e)
                self.db.commit()
                
                results.append({
                    "persona_id": persona.id,
                    "persona_name": persona.name,
                    "status": "failed",
                    "error": str(e)
                })
        
        return results
    
    async def _run_parallel_analyses(
        self,
        analyses: List[tuple],
        document_text: str
    ) -> List[Dict[str, Any]]:
        """Run analyses in parallel (for Phase 2)."""
        # For MVP, we'll just call sequential
        # Phase 2 will implement true parallel processing
        return await self._run_sequential_analyses(analyses, document_text)
    
    async def retry_failed_analysis(
        self,
        session_id: str,
        persona_id: str,
        document_text: str
    ) -> Dict[str, Any]:
        """Retry a failed analysis."""
        
        analysis = self.db.query(Analysis).filter(
            Analysis.session_id == session_id,
            Analysis.persona_id == persona_id
        ).first()
        
        if not analysis:
            raise ValueError(f"Analysis not found for session {session_id}, persona {persona_id}")
        
        if analysis.status != "failed":
            raise ValueError("Analysis is not in failed state")
        
        persona = PersonaService.get_persona(self.db, persona_id)
        if not persona:
            raise ValueError(f"Persona not found: {persona_id}")
        
        try:
            # Update status to running
            analysis.status = "running"
            analysis.error_message = None
            self.db.commit()
            
            # Run analysis
            profile_data = persona.profile_json
            result = await self.backend.run_analysis(profile_data, document_text)
            
            # Update analysis record
            analysis.status = "completed"
            analysis.score_json = result.get('dimension_scores')
            analysis.top_issues_json = result.get('top_3_issues')
            analysis.rewritten_suggestions_json = {
                "what_works_well": result.get('what_works_well', []),
                "overall_verdict": result.get('overall_verdict', ''),
                "rewritten_headline": result.get('rewritten_headline_suggestion', '')
            }
            self.db.commit()
            
            # Update session status if all analyses are now complete
            await self._update_session_status(session_id)
            
            return {
                "persona_id": persona.id,
                "persona_name": persona.name,
                "status": "completed",
                "result": result
            }
            
        except Exception as e:
            logger.error(f"Retry failed for persona {persona_id}: {e}")
            
            analysis.status = "failed"
            analysis.error_message = str(e)
            self.db.commit()
            
            return {
                "persona_id": persona.id,
                "persona_name": persona.name,
                "status": "failed",
                "error": str(e)
            }
    
    async def _update_session_status(self, session_id: str):
        """Update session status based on analysis results."""
        session = self.db.query(SessionModel).filter(SessionModel.id == session_id).first()
        if not session:
            return
        
        analyses = self.db.query(Analysis).filter(Analysis.session_id == session_id).all()
        
        if not analyses:
            return
        
        failed_count = sum(1 for a in analyses if a.status == "failed")
        completed_count = sum(1 for a in analyses if a.status == "completed")
        
        if failed_count == len(analyses):
            session.status = "failed"
        elif failed_count > 0:
            session.status = "partial"
        elif completed_count == len(analyses):
            session.status = "completed"
        
        self.db.commit()