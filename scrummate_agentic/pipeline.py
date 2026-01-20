"""
Main pipeline for processing meeting transcripts.

This module orchestrates the entire flow:
1. Chunking - Split transcript into semantic chunks
2. Embedding - Store chunks in vector database
3. Summarization - Generate meeting minutes
4. User Stories - Extract user stories from minutes
5. Assignment - Assign stories to team members
"""

import json
import re
import sys
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass

from config import CHUNKS_DIR, SUMMARIES_DIR, USER_STORIES_DIR
from services import (
    ChunkingService,
    EmbeddingService,
    SummarizationService,
    UserStoryService,
    AssignmentService,
)


@dataclass
class PipelineResult:
    """Result of a pipeline run."""
    success: bool
    meeting_id: str
    chunks_path: Optional[Path] = None
    chunks_count: int = 0
    minutes_path: Optional[Path] = None
    stories_path: Optional[Path] = None
    stories_count: int = 0
    assignments_path: Optional[Path] = None
    error: Optional[str] = None
    error_stage: Optional[str] = None


class MeetingPipeline:
    """
    Orchestrates the meeting transcript processing pipeline.
    
    The pipeline can be run in full or partially, depending on needs.
    """
    
    def __init__(self):
        self.chunking = ChunkingService()
        self.embedding = EmbeddingService()
        self.summarization = SummarizationService()
        self.userstory = UserStoryService()
        self.assignment = AssignmentService()
    
    def extract_meeting_id(self, transcript_data: Dict[str, Any]) -> str:
        """
        Extract a clean meeting ID from transcript data.
        
        Args:
            transcript_data: Raw transcript data
            
        Returns:
            Cleaned meeting ID string
        """
        meeting_url = transcript_data.get("meeting_url", "")
        
        # Try to extract Google Meet ID
        match = re.search(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", meeting_url)
        if match:
            return match.group(1)
        
        # Fall back to bot_id
        bot_id = transcript_data.get("bot_id", "")
        if bot_id:
            return bot_id[:12]  # Truncate for readability
        
        # Last resort: use a portion of the URL or generate one
        return "meeting-unknown"
    
    def run(
        self,
        transcript_path: Path,
        skip_assignment: bool = False
    ) -> PipelineResult:
        """
        Run the full pipeline on a transcript file.
        
        Args:
            transcript_path: Path to the transcript JSON file
            skip_assignment: If True, skip the assignment step
            
        Returns:
            PipelineResult with all output paths and status
        """
        # Load transcript
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                transcript_data = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            return PipelineResult(
                success=False,
                meeting_id="unknown",
                error=f"Failed to load transcript: {e}",
                error_stage="load"
            )
        
        meeting_id = self.extract_meeting_id(transcript_data)
        
        # Stage 1: Chunking
        print(f"[1/5] Chunking transcript for meeting: {meeting_id}")
        try:
            chunks = self.chunking.process_transcript(transcript_data, meeting_id)
            chunks_path = CHUNKS_DIR / f"{meeting_id}.json"
            with open(chunks_path, "w", encoding="utf-8") as f:
                json.dump({"chunks": chunks}, f, ensure_ascii=False, indent=2)
            print(f"      Created {len(chunks)} chunks")
        except Exception as e:
            return PipelineResult(
                success=False,
                meeting_id=meeting_id,
                error=f"Chunking failed: {e}",
                error_stage="chunking"
            )
        
        # Stage 2: Embeddings
        print(f"[2/5] Generating embeddings and storing in vector database")
        try:
            added = self.embedding.add_chunks(chunks)
            print(f"      Added {added} chunks to vector database")
        except Exception as e:
            return PipelineResult(
                success=False,
                meeting_id=meeting_id,
                chunks_path=chunks_path,
                chunks_count=len(chunks),
                error=f"Embedding failed: {e}",
                error_stage="embedding"
            )
        
        # Stage 3: Summarization
        print(f"[3/5] Generating meeting minutes")
        try:
            meeting_meta = {
                "meeting_id": meeting_id,
                "meeting_url": transcript_data.get("meeting_url"),
                "created_at": transcript_data.get("created_at"),
            }
            minutes = self.summarization.generate_minutes(chunks, meeting_meta)
            minutes_path = SUMMARIES_DIR / f"{meeting_id}_final.txt"
            with open(minutes_path, "w", encoding="utf-8") as f:
                f.write(minutes)
            print(f"      Minutes saved to {minutes_path}")
        except Exception as e:
            return PipelineResult(
                success=False,
                meeting_id=meeting_id,
                chunks_path=chunks_path,
                chunks_count=len(chunks),
                error=f"Summarization failed: {e}",
                error_stage="summarization"
            )
        
        # Stage 4: User Stories
        print(f"[4/5] Generating user stories")
        try:
            stories = self.userstory.generate_stories(minutes)
            stories_path = USER_STORIES_DIR / f"{meeting_id}_stories.json"
            with open(stories_path, "w", encoding="utf-8") as f:
                json.dump(stories, f, indent=2)
            print(f"      Generated {len(stories)} user stories")
        except ValueError as e:
            return PipelineResult(
                success=False,
                meeting_id=meeting_id,
                chunks_path=chunks_path,
                chunks_count=len(chunks),
                minutes_path=minutes_path,
                error=f"User story generation failed: {e}",
                error_stage="userstories"
            )
        
        # Stage 5: Assignment (optional)
        assignments_path = None
        if not skip_assignment:
            print(f"[5/5] Assigning user stories to team members")
            try:
                profiles = self.assignment.load_profiles()
                result = self.assignment.assign_stories(stories, profiles)
                
                # Save updated profiles
                self.assignment.save_profiles(result["updated_profiles"])
                
                # Save assignments
                assignments_path = USER_STORIES_DIR / f"{meeting_id}_assignments.json"
                with open(assignments_path, "w", encoding="utf-8") as f:
                    json.dump(result["assignments"], f, indent=2)
                print(f"      Assigned {len(result['assignments'])} stories")
            except (FileNotFoundError, ValueError) as e:
                return PipelineResult(
                    success=False,
                    meeting_id=meeting_id,
                    chunks_path=chunks_path,
                    chunks_count=len(chunks),
                    minutes_path=minutes_path,
                    stories_path=stories_path,
                    stories_count=len(stories),
                    error=f"Assignment failed: {e}",
                    error_stage="assignment"
                )
        else:
            print(f"[5/5] Skipping assignment step")
        
        print(f"\nPipeline completed successfully for meeting: {meeting_id}")
        
        return PipelineResult(
            success=True,
            meeting_id=meeting_id,
            chunks_path=chunks_path,
            chunks_count=len(chunks),
            minutes_path=minutes_path,
            stories_path=stories_path,
            stories_count=len(stories),
            assignments_path=assignments_path,
        )


def main():
    """CLI entry point."""
    if len(sys.argv) < 2:
        print("Usage: python pipeline.py <transcript.json> [--skip-assignment]")
        print("\nProcesses a meeting transcript through the full pipeline:")
        print("  1. Chunking - Split into semantic chunks")
        print("  2. Embedding - Store in vector database")
        print("  3. Summarization - Generate meeting minutes")
        print("  4. User Stories - Extract user stories")
        print("  5. Assignment - Assign to team members")
        sys.exit(1)
    
    transcript_path = Path(sys.argv[1])
    skip_assignment = "--skip-assignment" in sys.argv
    
    if not transcript_path.exists():
        print(f"Error: File not found: {transcript_path}")
        sys.exit(1)
    
    pipeline = MeetingPipeline()
    result = pipeline.run(transcript_path, skip_assignment=skip_assignment)
    
    if not result.success:
        print(f"\nPipeline failed at stage: {result.error_stage}")
        print(f"Error: {result.error}")
        sys.exit(1)
    
    print("\nOutput files:")
    print(f"  Chunks: {result.chunks_path}")
    print(f"  Minutes: {result.minutes_path}")
    print(f"  User Stories: {result.stories_path}")
    if result.assignments_path:
        print(f"  Assignments: {result.assignments_path}")


if __name__ == "__main__":
    main()
