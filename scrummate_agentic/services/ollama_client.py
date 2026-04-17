"""
Ollama local LLM client — used as a fallback when the Gemini API is unavailable
(rate limited, quota exhausted, or auth failure).

Talks to an Ollama server running at OLLAMA_BASE_URL (default http://localhost:11434)
using the /api/generate endpoint.

Special handling for Qwen3 hybrid-thinking models:
- Prepends `/no_think` to every prompt so the chat template skips the reasoning
  step entirely. This makes the model up to 3–5× faster on qwen3:4b.
- Also sends `think: false` (supported by newer Ollama versions).
- Strips any stray <think>…</think> blocks as a safety net.
- If the response is empty after stripping (i.e. the model still emitted only
  thinking content), retries once with an even more explicit directive.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import os
import re
import requests

from config import OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT


_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)
_OPEN_THINK_RE  = re.compile(r"^\s*<think>.*$", re.DOTALL | re.IGNORECASE)


class OllamaClient:
    """Singleton wrapper for a local Ollama server."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._base_url = OLLAMA_BASE_URL.rstrip("/")
            cls._instance._model    = OLLAMA_MODEL
            cls._instance._session  = requests.Session()
            cls._instance._is_qwen3 = "qwen3" in OLLAMA_MODEL.lower()
            # Honour CPU thread count — default to all logical cores minus one
            # so the OS stays responsive while Ollama runs.
            cls._instance._num_thread = max(1, (os.cpu_count() or 4) - 1)
        return cls._instance

    # ────────────────────────────── helpers ──────────────────────────────

    def _prepare_prompt(self, prompt: str) -> str:
        """For Qwen3 hybrid-thinking models, prepend `/no_think` to skip the
        reasoning stage (documented in Qwen's chat template)."""
        if self._is_qwen3:
            return f"/no_think\n{prompt}"
        return prompt

    def _clean_response(self, text: str) -> str:
        """Strip any <think>…</think> blocks and trailing whitespace."""
        text = _THINK_BLOCK_RE.sub("", text or "")
        # If the model emitted an unclosed <think>… (rare), drop it as well
        text = _OPEN_THINK_RE.sub("", text)
        return text.strip()

    def _build_options(self, max_tokens: int) -> dict:
        return {
            "num_predict": max_tokens,
            "temperature": 0.3,
            "top_p":       0.9,
            "num_thread":  self._num_thread,
            # 4096 keeps KV-cache small enough that all 37 model layers fit in
            # the RTX 3050 Ti's 4 GB VRAM (vs. splitting layers across CPU+GPU
            # with 8192). For meeting transcript summaries 4096 tokens is ample.
            "num_ctx":     4096,
        }

    # ────────────────────────────── public ──────────────────────────────

    def is_available(self) -> bool:
        """Quick health check — returns True if the Ollama server is reachable
        and the configured model is installed."""
        try:
            r = self._session.get(f"{self._base_url}/api/tags", timeout=3)
            if r.status_code != 200:
                return False
            tags = r.json().get("models", [])
            return any(m.get("name", "").startswith(self._model.split(":")[0]) for m in tags)
        except Exception:
            return False

    def generate(self, prompt: str, max_tokens: int = 1024) -> str:
        """Generate text from a prompt.

        Raises:
            RuntimeError: If the Ollama server returns a non-200 status or
                          produces an empty response even after retrying.
        """
        return self._do_generate(self._prepare_prompt(prompt), max_tokens, retry=True)

    def _do_generate(self, prompt: str, max_tokens: int, retry: bool) -> str:
        payload = {
            "model":   self._model,
            "prompt":  prompt,
            "stream":  False,
            # think=false is supported by newer Ollama versions for qwen3.
            # Older versions silently ignore it — harmless either way.
            "think":   False,
            "options": self._build_options(max_tokens),
        }
        r = self._session.post(
            f"{self._base_url}/api/generate",
            json=payload,
            timeout=OLLAMA_TIMEOUT,
        )
        if r.status_code != 200:
            raise RuntimeError(
                f"Ollama returned HTTP {r.status_code}: {r.text[:300]}"
            )

        raw    = r.json().get("response", "")
        cleaned = self._clean_response(raw)

        # If we got nothing back (qwen3 sometimes emits ONLY thinking content),
        # retry once with an explicit directive in the prompt body.
        if not cleaned and retry:
            print("[Ollama] Empty response after stripping reasoning — retrying with explicit directive.")
            assertive = (
                "/no_think\nRespond directly. Do NOT include any <think> tags or reasoning.\n\n"
                + prompt
            )
            return self._do_generate(assertive, max_tokens, retry=False)

        if not cleaned:
            raise RuntimeError(
                "Ollama returned an empty response after retries. Raw output "
                f"(first 400 chars): {raw[:400]!r}"
            )

        return cleaned

    def generate_json(self, prompt: str) -> str:
        """Generate a JSON response, stripping markdown fences / prose if present."""
        response = self.generate(prompt)

        # Strip ```json ... ``` fences
        if response.startswith("```json"):
            response = response[7:]
        elif response.startswith("```"):
            response = response[3:]
        if response.endswith("```"):
            response = response[:-3]
        response = response.strip()

        # Local models occasionally wrap JSON in a paragraph — try to salvage it.
        if response and response[0] not in "{[":
            match = re.search(r"(\{.*\}|\[.*\])", response, re.DOTALL)
            if match:
                response = match.group(1)

        return response.strip()
