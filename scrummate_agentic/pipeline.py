"""
Main pipeline for processing meeting transcripts.

Pipeline stages vary by meeting type:

  Product Owner:     Chunking -> Embedding -> Minutes -> User Stories -> Assignment
  Daily Standup:     Chunking -> Embedding -> Minutes -> Blockers Report
  Retrospective:     Chunking -> Embedding -> Minutes -> Retro Analysis
"""

import json
import re
import sys
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

from config import (
    CHUNKS_DIR, SUMMARIES_DIR, USER_STORIES_DIR, STANDUPS_DIR, RETROSPECTIVES_DIR,
    MEETING_TYPE_PO, MEETING_TYPE_STANDUP, MEETING_TYPE_RETRO, VALID_MEETING_TYPES,
)
from services import (
    ChunkingService,
    EmbeddingService,
    SummarizationService,
    UserStoryService,
    AssignmentService,
    BlockersService,
    RetroService,
)


@dataclass
class PipelineResult:
    """Result of a pipeline run."""
    success: bool
    meeting_id: str
    meeting_type: str = MEETING_TYPE_PO
    chunks_path: Optional[Path] = None
    chunks_count: int = 0
    minutes_path: Optional[Path] = None
    # PO meeting outputs
    stories_path: Optional[Path] = None
    stories_count: int = 0
    assignments_path: Optional[Path] = None
    # Standup outputs
    blockers_path: Optional[Path] = None
    # Retro outputs
    retro_path: Optional[Path] = None
    error: Optional[str] = None
    error_stage: Optional[str] = None


class MeetingPipeline:
    """
    Orchestrates the meeting transcript processing pipeline.
    Stages are selected based on meeting_type.
    """

    def __init__(self):
        self.chunking = ChunkingService()
        self.embedding = EmbeddingService()
        self.summarization = SummarizationService()
        self.userstory = UserStoryService()
        self.assignment = AssignmentService()
        self.blockers = BlockersService()
        self.retro = RetroService()

    def extract_meeting_id(self, transcript_data: Dict[str, Any]) -> str:
        """Extract a clean meeting ID from transcript data."""
        meeting_url = transcript_data.get("meeting_url", "")

        match = re.search(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", meeting_url)
        if match:
            return match.group(1)

        bot_id = transcript_data.get("bot_id", "")
        if bot_id:
            return bot_id[:12]

        return "meeting-unknown"

    def run(
        self,
        transcript_path: Path,
        meeting_type: str = MEETING_TYPE_PO,
        skip_assignment: bool = False,
    ) -> PipelineResult:
        """
        Run the pipeline on a transcript file.

        Args:
            transcript_path: Path to the transcript JSON file
            meeting_type: 'product-owner', 'daily-standup', or 'retrospective'
            skip_assignment: If True, skip assignment step (PO meeting only)

        Returns:
            PipelineResult with all output paths and status
        """
        # Validate and normalise meeting type
        if meeting_type not in VALID_MEETING_TYPES:
            print(f"Unknown meeting type '{meeting_type}', defaulting to product-owner")
            meeting_type = MEETING_TYPE_PO

        # --- Load transcript ---
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                transcript_data = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            return PipelineResult(
                success=False, meeting_id="unknown", meeting_type=meeting_type,
                error=f"Failed to load transcript: {e}", error_stage="load"
            )

        meeting_id = self.extract_meeting_id(transcript_data)
        result = PipelineResult(success=False, meeting_id=meeting_id, meeting_type=meeting_type)

        # --- Stage 1: Chunking ---
        print(f"[1/4] Chunking transcript for meeting: {meeting_id} (type: {meeting_type})")
        try:
            chunks = self.chunking.process_transcript(transcript_data, meeting_id)
            chunks_path = CHUNKS_DIR / f"{meeting_id}.json"
            with open(chunks_path, "w", encoding="utf-8") as f:
                json.dump({"chunks": chunks}, f, ensure_ascii=False, indent=2)
            result.chunks_path = chunks_path
            result.chunks_count = len(chunks)
            print(f"      Created {len(chunks)} chunks")
        except Exception as e:
            result.error = f"Chunking failed: {e}"
            result.error_stage = "chunking"
            return result

        # --- Stage 2: Embeddings ---
        print(f"[2/4] Generating embeddings and storing in vector database")
        try:
            added = self.embedding.add_chunks(chunks)
            print(f"      Added {added} chunks to vector database")
        except Exception as e:
            result.error = f"Embedding failed: {e}"
            result.error_stage = "embedding"
            return result

        # --- Stage 3: Summarization (meeting-type-aware prompts) ---
        print(f"[3/4] Generating meeting minutes")
        try:
            meeting_meta = {
                "meeting_id": meeting_id,
                "meeting_url": transcript_data.get("meeting_url"),
                "created_at": transcript_data.get("created_at"),
            }
            minutes = self.summarization.generate_minutes(chunks, meeting_meta, meeting_type)
            minutes_path = SUMMARIES_DIR / f"{meeting_id}_final.txt"
            with open(minutes_path, "w", encoding="utf-8") as f:
                f.write(minutes)
            result.minutes_path = minutes_path
            print(f"      Minutes saved to {minutes_path}")
        except Exception as e:
            result.error = f"Summarization failed: {e}"
            result.error_stage = "summarization"
            return result

        # --- Stage 4: Type-specific analysis ---
        if meeting_type == MEETING_TYPE_PO:
            return self._run_po_stages(result, minutes, meeting_id, skip_assignment)

        elif meeting_type == MEETING_TYPE_STANDUP:
            return self._run_standup_stages(result, minutes, meeting_id)

        elif meeting_type == MEETING_TYPE_RETRO:
            return self._run_retro_stages(result, minutes, meeting_id)

        result.success = True
        return result

    # ------------------------------------------------------------------
    # Stage 4 variants
    # ------------------------------------------------------------------

    def _run_po_stages(
        self,
        result: PipelineResult,
        minutes: str,
        meeting_id: str,
        skip_assignment: bool,
    ) -> PipelineResult:
        """User stories + assignment for PO meetings."""
        print(f"[4/4] Generating user stories")
        try:
            stories = self.userstory.generate_stories(minutes)
            stories_path = USER_STORIES_DIR / f"{meeting_id}_stories.json"
            with open(stories_path, "w", encoding="utf-8") as f:
                json.dump(stories, f, indent=2)
            result.stories_path = stories_path
            result.stories_count = len(stories)
            print(f"      Generated {len(stories)} user stories")
        except ValueError as e:
            result.error = f"User story generation failed: {e}"
            result.error_stage = "userstories"
            return result

        if not skip_assignment:
            print(f"      Assigning stories to team members")
            try:
                profiles = self.assignment.load_profiles()
                assignment_result = self.assignment.assign_stories(stories, profiles)
                self.assignment.save_profiles(assignment_result["updated_profiles"])

                assignments_path = USER_STORIES_DIR / f"{meeting_id}_assignments.json"
                with open(assignments_path, "w", encoding="utf-8") as f:
                    json.dump(assignment_result["assignments"], f, indent=2)
                result.assignments_path = assignments_path
                print(f"      Assigned {len(assignment_result['assignments'])} stories")
            except (FileNotFoundError, ValueError) as e:
                result.error = f"Assignment failed: {e}"
                result.error_stage = "assignment"
                return result
        else:
            print(f"      Skipping assignment step")

        result.success = True
        print(f"\nPipeline completed for {meeting_id} ({MEETING_TYPE_PO})")
        return result

    def _run_standup_stages(
        self,
        result: PipelineResult,
        minutes: str,
        meeting_id: str,
    ) -> PipelineResult:
        """Blockers report for Daily Standup meetings."""
        print(f"[4/4] Generating blockers report")
        try:
            blockers_path = self.blockers.generate_and_save(minutes, meeting_id)
            result.blockers_path = blockers_path
            print(f"      Blockers report saved to {blockers_path}")
        except ValueError as e:
            result.error = f"Blockers report generation failed: {e}"
            result.error_stage = "blockers"
            return result

        result.success = True
        print(f"\nPipeline completed for {meeting_id} ({MEETING_TYPE_STANDUP})")
        return result

    def _run_retro_stages(
        self,
        result: PipelineResult,
        minutes: str,
        meeting_id: str,
    ) -> PipelineResult:
        """Retro analysis for Retrospective meetings."""
        print(f"[4/4] Generating retrospective analysis")
        try:
            retro_path = self.retro.generate_and_save(minutes, meeting_id)
            result.retro_path = retro_path
            print(f"      Retro analysis saved to {retro_path}")
        except ValueError as e:
            result.error = f"Retro analysis generation failed: {e}"
            result.error_stage = "retro"
            return result

        result.success = True
        print(f"\nPipeline completed for {meeting_id} ({MEETING_TYPE_RETRO})")
        return result


def main():
    """CLI entry point."""
    if len(sys.argv) < 2:
        print("Usage: python pipeline.py <transcript.json> [--type=product-owner|daily-standup|retrospective] [--skip-assignment]")
        print("\nPipeline stages by meeting type:")
        print("  product-owner  : Chunking -> Embedding -> Minutes -> User Stories -> Assignment")
        print("  daily-standup  : Chunking -> Embedding -> Minutes -> Blockers Report")
        print("  retrospective  : Chunking -> Embedding -> Minutes -> Retro Analysis")
        sys.exit(1)

    transcript_path = Path(sys.argv[1])
    skip_assignment = "--skip-assignment" in sys.argv

    meeting_type = MEETING_TYPE_PO
    for arg in sys.argv[2:]:
        if arg.startswith("--type="):
            meeting_type = arg.split("=", 1)[1]

    if not transcript_path.exists():
        print(f"Error: File not found: {transcript_path}")
        sys.exit(1)

    pipeline = MeetingPipeline()
    result = pipeline.run(transcript_path, meeting_type=meeting_type, skip_assignment=skip_assignment)

    if not result.success:
        print(f"\nPipeline failed at stage: {result.error_stage}")
        print(f"Error: {result.error}")
        sys.exit(1)

    print("\nOutput files:")
    if result.chunks_path:
        print(f"  Chunks:      {result.chunks_path}")
    if result.minutes_path:
        print(f"  Minutes:     {result.minutes_path}")
    if result.stories_path:
        print(f"  Stories:     {result.stories_path}")
    if result.assignments_path:
        print(f"  Assignments: {result.assignments_path}")
    if result.blockers_path:
        print(f"  Blockers:    {result.blockers_path}")
    if result.retro_path:
        print(f"  Retro:       {result.retro_path}")


if __name__ == "__main__":
    main()
