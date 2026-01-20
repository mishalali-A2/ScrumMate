"""
User story generation service.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import List, Dict, Any

from config import USER_STORIES_DIR
from .gemini_client import GeminiClient


USERSTORY_PROMPT = """
You are a senior Product Owner. Convert the following meeting minutes into FINAL, DEDUPLICATED, CLEAN user stories.

Your output MUST be a valid JSON array. Nothing else.

Each story must follow this schema:
{
  "id": "US-001",
  "user_story": "As a <role>, I want <feature> so that <benefit>.",
  "acceptance_criteria": ["...", "..."],
  "urgency": "High | Medium | Low",
  "skill_required": "Frontend | Backend | Full-stack | ML | DevOps | Database | UX/UI",
  "effort_points": 1 | 2 | 3 | 5 | 8 | 13
}

Rules:
- Remove duplicates.
- Rewrite unclear stories.
- Add missing acceptance criteria if logic requires it.
- Use Fibonacci for effort.
- ID must be sequential starting from US-001.

MEETING MINUTES:
"""


class UserStoryService:
    """Generates user stories from meeting minutes."""
    
    def __init__(self):
        self.gemini = GeminiClient()
    
    def generate_stories(self, minutes: str) -> List[Dict[str, Any]]:
        """
        Generate user stories from meeting minutes.
        
        Args:
            minutes: Meeting minutes text
            
        Returns:
            List of user story dictionaries
            
        Raises:
            ValueError: If the LLM response is not valid JSON
        """
        prompt = USERSTORY_PROMPT + minutes
        
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
    
    def generate_and_save(
        self,
        minutes_path: Path,
        meeting_id: str
    ) -> Path:
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
