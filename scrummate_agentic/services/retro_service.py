"""
Retrospective analysis service.
Extracts structured went-well / didn't-go-well / action items from retro minutes.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import Dict, Any

from config import RETROSPECTIVES_DIR, PROMPTS_DIR
from .gemini_client import GeminiClient


class RetroService:
    """Generates a structured retrospective analysis from retro minutes."""

    def __init__(self):
        self.gemini = GeminiClient()
        self._prompt_template = self._load_prompt()

    def _load_prompt(self) -> str:
        prompt_path = PROMPTS_DIR / "retrospective" / "retro_analysis.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate_analysis(self, minutes: str) -> Dict[str, Any]:
        """
        Generate a structured retrospective analysis from retro minutes.

        Args:
            minutes: Retrospective meeting minutes text

        Returns:
            Dictionary with went_well, didnt_go_well, action_items, team_health, metrics

        Raises:
            ValueError: If the LLM response is not valid JSON
        """
        prompt = self._prompt_template.replace("{minutes}", minutes)
        json_text = self.gemini.generate_json(prompt)

        try:
            analysis = json.loads(json_text)
            if not isinstance(analysis, dict):
                raise ValueError("Expected a JSON object for retro analysis")
            return analysis
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Failed to parse retro analysis JSON from LLM response. "
                f"Error: {e}. Raw response:\n{json_text[:500]}..."
            )

    def generate_and_save(self, minutes: str, meeting_id: str) -> Path:
        """
        Generate a retro analysis and save it to disk.

        Args:
            minutes: Retrospective meeting minutes text
            meeting_id: Meeting identifier

        Returns:
            Path to the saved retro analysis JSON file
        """
        analysis = self.generate_analysis(minutes)

        output_path = RETROSPECTIVES_DIR / f"{meeting_id}_retro.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(analysis, f, indent=2)

        return output_path
