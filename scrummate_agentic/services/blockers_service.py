"""
Blockers report service for Daily Standup meetings.
Extracts structured team updates and blockers from standup minutes.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import Dict, Any

from config import STANDUPS_DIR, PROMPTS_DIR
from .gemini_client import GeminiClient


class BlockersService:
    """Generates a structured blockers report from standup minutes."""

    def __init__(self):
        self.gemini = GeminiClient()
        self._prompt_template = self._load_prompt()

    def _load_prompt(self) -> str:
        prompt_path = PROMPTS_DIR / "daily_standup" / "blockers_report.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate_report(self, minutes: str) -> Dict[str, Any]:
        """
        Generate a structured blockers report from standup minutes.

        Args:
            minutes: Standup meeting minutes text

        Returns:
            Dictionary with team_updates, blockers, and action_items

        Raises:
            ValueError: If the LLM response is not valid JSON
        """
        prompt = self._prompt_template.replace("{minutes}", minutes)
        json_text = self.gemini.generate_json(prompt)

        try:
            report = json.loads(json_text)
            if not isinstance(report, dict):
                raise ValueError("Expected a JSON object for blockers report")
            return report
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Failed to parse blockers report JSON from LLM response. "
                f"Error: {e}. Raw response:\n{json_text[:500]}..."
            )

    def generate_and_save(self, minutes: str, meeting_id: str) -> Path:
        """
        Generate a blockers report and save it to disk.

        Args:
            minutes: Standup meeting minutes text
            meeting_id: Meeting identifier

        Returns:
            Path to the saved blockers report JSON file
        """
        report = self.generate_report(minutes)

        output_path = STANDUPS_DIR / f"{meeting_id}_blockers.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

        return output_path
