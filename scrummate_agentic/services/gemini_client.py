"""
Singleton Gemini client for LLM operations — with automatic fallback to a local
Ollama model (qwen3:4b by default) when Gemini returns a rate-limit / quota /
auth error, or is unreachable.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from google import genai
from config import GENAI_API_KEY, GEMINI_MODEL


# Substrings that indicate the Gemini call failed for a reason where retrying
# against a local model is the right call. We keep this generous because the
# SDK surfaces different phrasings for the same underlying problem.
_FALLBACK_TRIGGERS = (
    # Rate-limit / quota
    "429",                          # Too Many Requests
    "quota",
    "rate limit",
    "rate_limit",
    "resource_exhausted",
    "resource has been exhausted",
    "exceeded",
    # Overload / availability (e.g. "503 UNAVAILABLE: This model is currently
    # experiencing high demand…")
    "503",
    "unavailable",
    "high demand",
    "service_unavailable",
    "overloaded",
    # Server errors
    "500 internal",
    "internal server error",
    "500",
    "502",
    "504",
    # Auth / config
    "unauthenticated",
    "permission_denied",
    "api key",
    "invalid api key",
    # Network / transport
    "deadline exceeded",
    "timeout",
    "timed out",
    "connection",
)


def _should_fallback(err: Exception) -> bool:
    """Return True if a Gemini failure should trigger an Ollama retry."""
    msg = str(err).lower()
    return any(trigger in msg for trigger in _FALLBACK_TRIGGERS)


class GeminiClient:
    """Singleton wrapper for Gemini API client with Ollama fallback."""

    _instance = None
    _client = None
    _ollama = None               # Lazily-initialised Ollama client
    _force_ollama = False        # Once Gemini hits a hard limit this session, skip it

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            if not GENAI_API_KEY:
                # No Gemini key at all — run entirely on Ollama.
                print("[LLM] GENAI_API_KEY not set — using local Ollama for all LLM calls.")
                cls._force_ollama = True
                cls._client = None
            else:
                try:
                    cls._client = genai.Client(api_key=GENAI_API_KEY)
                except Exception as e:
                    print(f"[LLM] Could not initialise Gemini client ({e}). Falling back to Ollama.")
                    cls._force_ollama = True
                    cls._client = None
        return cls._instance

    # ────────────────────────────── private ──────────────────────────────

    def _get_ollama(self):
        """Lazy-load the Ollama client so startup doesn't require it."""
        if self._ollama is None:
            from .ollama_client import OllamaClient
            self._ollama = OllamaClient()
        return self._ollama

    def _call_gemini(self, prompt: str) -> str:
        """Call Gemini directly. Raises on failure."""
        response = self._client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        return (response.text or "").strip()

    # ────────────────────────────── public ──────────────────────────────

    def generate(self, prompt: str, max_tokens: int = 1024) -> str:
        """
        Generate text using Gemini. On rate-limit / quota / auth errors,
        transparently retry with the local Ollama model.
        """
        # Fast path: Gemini already unusable this run → go straight to Ollama.
        if self._force_ollama or self._client is None:
            return self._get_ollama().generate(prompt, max_tokens=max_tokens)

        try:
            return self._call_gemini(prompt)
        except Exception as e:
            if _should_fallback(e):
                print(f"\n[LLM] ⚠️ Gemini unavailable ({type(e).__name__}) — switching to local Ollama (qwen3:4b) for the rest of this pipeline run.")
                print(f"[LLM] Gemini error detail: {str(e)[:220]}")
                # Lock this run to Ollama so we don't retry Gemini on every call.
                GeminiClient._force_ollama = True
                return self._get_ollama().generate(prompt, max_tokens=max_tokens)
            # Unexpected error — let it propagate.
            raise

    def generate_json(self, prompt: str) -> str:
        """
        Generate JSON response. Falls back to Ollama with the same rules as
        `generate()`. Caller is responsible for `json.loads` on the result.
        """
        if self._force_ollama or self._client is None:
            return self._get_ollama().generate_json(prompt)

        try:
            response = self._call_gemini(prompt)
        except Exception as e:
            if _should_fallback(e):
                print(f"\n[LLM] ⚠️ Gemini unavailable ({type(e).__name__}) — switching to local Ollama (qwen3:4b) for the rest of this pipeline run.")
                print(f"[LLM] Gemini error detail: {str(e)[:220]}")
                GeminiClient._force_ollama = True
                return self._get_ollama().generate_json(prompt)
            raise

        # Same cleanup as before — strip markdown fences if the model wrapped
        # its JSON output.
        if response.startswith("```json"):
            response = response[7:]
        elif response.startswith("```"):
            response = response[3:]
        if response.endswith("```"):
            response = response[:-3]

        return response.strip()
