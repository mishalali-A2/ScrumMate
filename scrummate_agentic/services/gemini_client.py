"""
Singleton Gemini client for LLM operations.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from google import genai
from config import GENAI_API_KEY, GEMINI_MODEL


class GeminiClient:
    """Singleton wrapper for Gemini API client."""
    
    _instance = None
    _client = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            if not GENAI_API_KEY:
                raise ValueError(
                    "GENAI_API_KEY is not set. "
                    "Set it as an environment variable or in the .env file."
                )
            cls._client = genai.Client(api_key=GENAI_API_KEY)
        return cls._instance
    
    def generate(self, prompt: str, max_tokens: int = 1024) -> str:
        """
        Generate text using Gemini API.
        
        Args:
            prompt: The prompt to send to the model
            max_tokens: Maximum tokens in response (advisory)
            
        Returns:
            Generated text response
        """
        response = self._client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt
        )
        return response.text.strip()
    
    def generate_json(self, prompt: str) -> str:
        """
        Generate JSON response, with basic cleanup for markdown code blocks.
        
        Args:
            prompt: The prompt expecting JSON output
            
        Returns:
            Raw JSON string (caller should parse)
        """
        response = self.generate(prompt)
        
        # Clean up markdown code blocks if present
        if response.startswith("```json"):
            response = response[7:]
        elif response.startswith("```"):
            response = response[3:]
        if response.endswith("```"):
            response = response[:-3]
            
        return response.strip()
