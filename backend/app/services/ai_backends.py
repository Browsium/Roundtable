from abc import ABC, abstractmethod
import subprocess
import json
import asyncio
import logging
from typing import Dict, Any, Optional
from app.core.config import settings

logger = logging.getLogger(__name__)

class AIBackend(ABC):
    """Abstract base class for AI CLI backends."""
    
    @abstractmethod
    async def run_analysis(self, persona_profile: Dict[str, Any], document_text: str) -> Dict[str, Any]:
        """Run analysis for a persona on the given document."""
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        """Check if this backend is available (CLI installed)."""
        pass

class ClaudeCodeBackend(AIBackend):
    """Claude Code CLI backend."""
    
    def __init__(self):
        self.command = "claude"
    
    def is_available(self) -> bool:
        try:
            subprocess.run([self.command, "--version"], capture_output=True, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    def _build_prompt(self, persona_profile: Dict[str, Any], document_text: str) -> str:
        """Build the analysis prompt."""
        prompt = f"""<persona>
{json.dumps(persona_profile, indent=2)}
</persona>

<role_instruction>
You are embodying the persona described above. You are attending a marketing review roundtable. Your job is to critically evaluate the following marketing content from your professional perspective. Be direct. Be specific. Do not soften your feedback. The team wants honest, constructive criticism that will make their marketing better — not validation.
</role_instruction>

<marketing_content>
{document_text[:8000]}  <!-- Limit to avoid token limits -->
</marketing_content>

<evaluation_framework>
Score each dimension 1-10 and provide specific commentary:
1. Relevance to my role: Does this speak to my actual priorities and pain points?
2. Technical credibility: Is it accurate? Does it avoid buzzword-stuffing?
3. Differentiation: Can I tell how this is different from competitors?
4. Actionability: Do I know what to do next after reading this?
5. Trust signals: Does this build or erode my trust? Why?
6. Language fit: Does this sound like it was written by someone who understands my world?
</evaluation_framework>

<output_format>
Respond in this exact JSON structure:
{{
  "persona_role": "{persona_profile.get('role', 'Unknown')}",
  "overall_score": <1-10>,
  "dimension_scores": {{
    "relevance": {{"score": <1-10>, "commentary": "..."}},
    "technical_credibility": {{"score": <1-10>, "commentary": "..."}},
    "differentiation": {{"score": <1-10>, "commentary": "..."}},
    "actionability": {{"score": <1-10>, "commentary": "..."}},
    "trust_signals": {{"score": <1-10>, "commentary": "..."}},
    "language_fit": {{"score": <1-10>, "commentary": "..."}}
  }},
  "top_3_issues": [
    {{"issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..."}},
    {{"issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..."}},
    {{"issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..."}}
  ],
  "what_works_well": ["...", "..."],
  "overall_verdict": "Would I engage further based on this content? Why or why not?",
  "rewritten_headline_suggestion": "..."
}}
</output_format>

Respond with ONLY the JSON. No markdown code blocks, no explanations, just valid JSON."""
        return prompt
    
    async def run_analysis(self, persona_profile: Dict[str, Any], document_text: str) -> Dict[str, Any]:
        prompt = self._build_prompt(persona_profile, document_text)
        
        for attempt in range(settings.AI_RETRY_ATTEMPTS):
            try:
                process = await asyncio.create_subprocess_exec(
                    self.command,
                    "-p", prompt,
                    "--output-format", "json",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=settings.AI_TIMEOUT
                )
                
                if process.returncode != 0:
                    error_msg = stderr.decode() if stderr else "Unknown error"
                    logger.error(f"Claude Code error: {error_msg}")
                    raise Exception(f"Claude Code failed: {error_msg}")
                
                response_text = stdout.decode()
                # Try to parse JSON response
                try:
                    result = json.loads(response_text)
                    return result
                except json.JSONDecodeError:
                    # Try to extract JSON from markdown code blocks
                    import re
                    json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', response_text, re.DOTALL)
                    if json_match:
                        result = json.loads(json_match.group(1))
                        return result
                    raise Exception("Could not parse JSON response")
                
            except asyncio.TimeoutError:
                logger.warning(f"Claude Code timeout on attempt {attempt + 1}")
                if attempt == settings.AI_RETRY_ATTEMPTS - 1:
                    raise Exception("Analysis timed out after all retries")
            except Exception as e:
                logger.error(f"Claude Code error on attempt {attempt + 1}: {e}")
                if attempt == settings.AI_RETRY_ATTEMPTS - 1:
                    raise
                await asyncio.sleep(2 ** attempt)  # Exponential backoff
        
        raise Exception("Failed after all retries")

class CodexBackend(AIBackend):
    """OpenAI Codex CLI backend."""
    
    def __init__(self):
        self.command = "codex"
    
    def is_available(self) -> bool:
        try:
            subprocess.run([self.command, "--version"], capture_output=True, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    async def run_analysis(self, persona_profile: Dict[str, Any], document_text: str) -> Dict[str, Any]:
        # Similar implementation to Claude Code
        # For MVP, we'll focus on Claude Code first
        raise NotImplementedError("Codex backend not yet implemented")

class OpenCodeBackend(AIBackend):
    """Open Code CLI backend."""
    
    def __init__(self):
        self.command = "opencode"
    
    def is_available(self) -> bool:
        try:
            subprocess.run([self.command, "--version"], capture_output=True, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    async def run_analysis(self, persona_profile: Dict[str, Any], document_text: str) -> Dict[str, Any]:
        # Similar implementation to Claude Code
        # For MVP, we'll focus on Claude Code first
        raise NotImplementedError("OpenCode backend not yet implemented")

class AIBackendFactory:
    """Factory for creating AI backend instances."""
    
    _backends = {
        "claude": ClaudeCodeBackend,
        "codex": CodexBackend,
        "opencode": OpenCodeBackend
    }
    
    @classmethod
    def get_backend(cls, backend_name: Optional[str] = None) -> AIBackend:
        """Get an AI backend instance."""
        backend_name = backend_name or settings.DEFAULT_AI_BACKEND
        backend_class = cls._backends.get(backend_name)
        
        if not backend_class:
            raise ValueError(f"Unknown backend: {backend_name}")
        
        backend = backend_class()
        if not backend.is_available():
            raise RuntimeError(f"Backend {backend_name} is not available. Is the CLI installed?")
        
        return backend
    
    @classmethod
    def list_available_backends(cls) -> list:
        """List all available backends."""
        available = []
        for name, backend_class in cls._backends.items():
            try:
                backend = backend_class()
                if backend.is_available():
                    available.append(name)
            except:
                pass
        return available