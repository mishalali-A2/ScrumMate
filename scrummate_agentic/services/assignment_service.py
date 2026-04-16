"""
Task assignment service for assigning user stories to team members.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import List, Dict, Any

from config import PROFILES_PATH, USER_STORIES_DIR, ASSIGNMENT_BATCH_SIZE
from .gemini_client import GeminiClient


ASSIGNMENT_PROMPT = """
You are an expert Scrum Master.

You will receive:
1. A list of team member profiles, each including:
   - name
   - role
   - skills
   - experience_years
   - assigned_effort_points

2. A batch of up to 10 user stories, each with:
   - id
   - description
   - urgency

Your task:
Assign each story to the most suitable members based on skill match, urgency, and current workload.

Rules:
- Choose a primary assignee with matching skills.
- Add support only if the story is complex or high urgency.
- Interns may assist but rarely as primary.
- Effort points use Fibonacci: 1, 2, 3, 5, 8, 13.
- Keep workload balanced by considering assigned_effort_points.

Return ONLY JSON:
{
  "assignments": [
    {
      "id": "<story-id>",
      "assigned_to": [
        {"name": "<member>", "role": "primary", "effort_points": <num>},
        {"name": "<member>", "role": "support", "effort_points": <num>}
      ]
    }
  ],
  "updated_member_efforts": [
    {
      "name": "<member>",
      "updated_assigned_effort_points": <new_total>
    }
  ]
}
"""


class AssignmentService:
    """Assigns user stories to team members based on skills and workload."""
    
    def __init__(self, batch_size: int = ASSIGNMENT_BATCH_SIZE):
        self.batch_size = batch_size
        self.gemini = GeminiClient()
    
    def load_profiles(self) -> List[Dict[str, Any]]:
        """Load team member profiles from disk."""
        if not PROFILES_PATH.exists():
            raise FileNotFoundError(
                f"Team profiles not found at {PROFILES_PATH}. "
                "Please create a profile.json file in the sprintmembers directory."
            )
        
        with open(PROFILES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    
    def save_profiles(self, profiles: List[Dict[str, Any]]) -> None:
        """Save updated profiles to disk."""
        with open(PROFILES_PATH, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=2)
    
    def assign_stories(
        self,
        stories: List[Dict[str, Any]],
        profiles: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Assign user stories to team members.
        
        Args:
            stories: List of user story dictionaries
            profiles: List of team member profiles
            
        Returns:
            Dictionary with 'assignments' and 'updated_profiles'
        """
        all_assignments = []
        current_profiles = profiles.copy()
        
        # Process in batches
        batches = [
            stories[i:i + self.batch_size]
            for i in range(0, len(stories), self.batch_size)
        ]
        
        for batch in batches:
            result = self._assign_batch(batch, current_profiles)
            all_assignments.extend(result.get("assignments", []))
            
            # Update profiles with new effort points
            current_profiles = self._apply_effort_updates(
                current_profiles,
                result.get("updated_member_efforts", [])
            )
        
        return {
            "assignments": all_assignments,
            "updated_profiles": current_profiles
        }
    
    def assign_and_save(
        self,
        stories_path: Path,
        meeting_id: str
    ) -> Path:
        """
        Assign stories from a file and save results.
        
        Args:
            stories_path: Path to user stories JSON file
            meeting_id: Meeting identifier
            
        Returns:
            Path to the saved assignments file
        """
        with open(stories_path, "r", encoding="utf-8") as f:
            stories = json.load(f)
        
        profiles = self.load_profiles()
        result = self.assign_stories(stories, profiles)
        
        # Save updated profiles
        self.save_profiles(result["updated_profiles"])
        
        # Save assignments alongside user stories
        output_path = USER_STORIES_DIR / f"{meeting_id}_assignments.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result["assignments"], f, indent=2)
        
        return output_path
    
    def _assign_batch(
        self,
        batch: List[Dict[str, Any]],
        profiles: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Assign a single batch of stories."""
        prompt = f"""
{ASSIGNMENT_PROMPT}

TEAM PROFILES:
{json.dumps(profiles, indent=2)}

USER STORIES:
{json.dumps(batch, indent=2)}
"""
        
        json_text = self.gemini.generate_json(prompt)
        
        try:
            return json.loads(json_text)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Failed to parse assignment JSON from LLM response. "
                f"Error: {e}. Raw response:\n{json_text[:500]}..."
            )
    
    def _apply_effort_updates(
        self,
        profiles: List[Dict[str, Any]],
        updates: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Apply effort point updates to profiles."""
        update_map = {
            u["name"]: u["updated_assigned_effort_points"]
            for u in updates
        }
        
        for profile in profiles:
            if profile["name"] in update_map:
                profile["assigned_effort_points"] = update_map[profile["name"]]
        
        return profiles
