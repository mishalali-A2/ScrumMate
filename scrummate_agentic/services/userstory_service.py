"""
User story generation service (Product Owner meetings only).
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import List, Dict, Any

from config import USER_STORIES_DIR, PROMPTS_DIR
from .gemini_client import GeminiClient


class UserStoryService:
    """Generates user stories from PO meeting minutes."""

    def __init__(self):
        self.gemini = GeminiClient()
        self._prompt_template = self._load_prompt()

    def _load_prompt(self) -> str:
        prompt_path = PROMPTS_DIR / "po_meeting" / "user_stories.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate_stories(self, minutes: str) -> List[Dict[str, Any]]:
        """
        Generate user stories from PO meeting minutes.

        Args:
            minutes: Meeting minutes text

        Returns:
            List of user story dictionaries

        Raises:
            ValueError: If the LLM response is not valid JSON
        """
        prompt = self._prompt_template.replace("{minutes}", minutes)
        json_text = self.gemini.generate_json(prompt)

        try:
            stories = json.loads(json_text)
            if not isinstance(stories, list):
                raise ValueError("Expected a JSON array of user stories")
            return stories
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Failed to parse user stories JSON from LLM response. "
                f"Error: {e}. Raw response:\n{json_text[:500]}..."
            )

    def generate_and_save(self, minutes_path: Path, meeting_id: str) -> Path:
        """
        Generate user stories from a minutes file and save to disk.

        Args:
            minutes_path: Path to the meeting minutes text file
            meeting_id: Meeting identifier

        Returns:
            Path to the saved user stories JSON file
        """
        with open(minutes_path, "r", encoding="utf-8") as f:
            minutes = f.read()

        stories = self.generate_stories(minutes)

        output_path = USER_STORIES_DIR / f"{meeting_id}_stories.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(stories, f, indent=2)

        return output_path
