"""
Summarization service for generating meeting minutes using hierarchical summarization.
Prompts are loaded from the prompts/ folder based on meeting type.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import List, Dict, Any, Tuple

from config import SUMMARY_BATCH_SIZE, SUMMARIES_DIR, PROMPTS_DIR, MEETING_TYPE_PO, MEETING_TYPE_PROMPT_FOLDER
from .gemini_client import GeminiClient


class SummarizationService:
    """Generates meeting minutes using hierarchical summarization."""

    def __init__(self, batch_size: int = SUMMARY_BATCH_SIZE):
        self.batch_size = batch_size
        self.gemini = GeminiClient()

    def _load_prompt(self, meeting_type: str, filename: str) -> str:
        """Load a prompt template from the prompts directory."""
        folder = MEETING_TYPE_PROMPT_FOLDER.get(meeting_type, MEETING_TYPE_PROMPT_FOLDER[MEETING_TYPE_PO])
        prompt_path = PROMPTS_DIR / folder / filename
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate_minutes(
        self,
        chunks: List[Dict[str, Any]],
        meeting_meta: Dict[str, Any],
        meeting_type: str = MEETING_TYPE_PO,
    ) -> str:
        """
        Generate meeting minutes from chunks.

        Args:
            chunks: List of chunk dictionaries
            meeting_meta: Meeting metadata
            meeting_type: One of 'product-owner', 'daily-standup', 'retrospective'

        Returns:
            Final meeting minutes as string
        """
        batch_prompt = self._load_prompt(meeting_type, "batch_summary.txt")
        final_prompt = self._load_prompt(meeting_type, "final_minutes.txt")

        sorted_chunks = sorted(chunks, key=lambda c: c.get("start_time", 0))
        batches = self._create_batches(sorted_chunks)

        batch_summaries = []
        for i, batch in enumerate(batches, 1):
            summary = self._summarize_batch(batch, i, batch_prompt)
            batch_summaries.append(summary)

        return self._combine_summaries(batch_summaries, meeting_meta, final_prompt)

    def generate_and_save(
        self,
        chunks_path: Path,
        meeting_id: str,
        meeting_type: str = MEETING_TYPE_PO,
    ) -> Path:
        """
        Generate minutes from a chunks file and save to disk.

        Args:
            chunks_path: Path to the chunks JSON file
            meeting_id: Meeting identifier
            meeting_type: Meeting type string

        Returns:
            Path to the saved minutes file
        """
        chunks, meeting_meta = self._load_chunks(chunks_path)
        minutes = self.generate_minutes(chunks, meeting_meta, meeting_type)

        output_path = SUMMARIES_DIR / f"{meeting_id}_final.txt"
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(minutes)

        return output_path

    def _load_chunks(self, filepath: Path) -> Tuple[List[Dict], Dict]:
        """Load chunks from JSON file."""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        chunks = data.get("chunks", [])
        chunks.sort(key=lambda c: c.get("start_time", 0))

        meeting_meta = {
            "meeting_id": chunks[0].get("meeting_id", "unknown") if chunks else "unknown",
            "platform": chunks[0].get("meeting_meta", {}).get("platform", "unknown") if chunks else "unknown",
            "start_time": chunks[0].get("meeting_meta", {}).get("start_time", "unknown") if chunks else "unknown",
            "meeting_url": chunks[0].get("meeting_meta", {}).get("meeting_url", "N/A") if chunks else "N/A",
        }

        return chunks, meeting_meta

    def _create_batches(self, chunks: List[Dict]) -> List[List[Dict]]:
        """Split chunks into batches."""
        return [
            chunks[i:i + self.batch_size]
            for i in range(0, len(chunks), self.batch_size)
        ]

    def _summarize_batch(self, chunks: List[Dict], batch_num: int, prompt_template: str) -> str:
        """Summarize a batch of chunks using the provided prompt template."""
        transcript_parts = []

        for chunk in chunks:
            speakers = chunk.get("speakers", ["unknown"])
            start_time = chunk.get("start_time", 0)
            text = chunk.get("text", "")
            speaker_str = " & ".join(speakers) if len(speakers) > 1 else speakers[0]
            transcript_parts.append(f"[{start_time:.0f}s | {speaker_str}]\n{text}")

        transcript = "\n\n".join(transcript_parts)
        prompt = prompt_template.replace("{transcript}", transcript)

        return self.gemini.generate(prompt)

    def _combine_summaries(
        self,
        batch_summaries: List[str],
        meeting_meta: Dict,
        final_prompt_template: str,
    ) -> str:
        """Combine batch summaries into final minutes."""
        combined = "\n\n---\n\n".join([
            f"## Part {i+1}\n{summary}"
            for i, summary in enumerate(batch_summaries)
        ])

        meta_section = (
            f"**MEETING METADATA**\n"
            f"- Meeting ID: {meeting_meta.get('meeting_id', 'N/A')}\n"
            f"- Platform: {meeting_meta.get('platform', 'N/A')}\n"
            f"- Start Time: {meeting_meta.get('start_time', 'N/A')}\n"
            f"- Meeting URL: {meeting_meta.get('meeting_url', 'N/A')}\n\n---"
        )

        prompt = final_prompt_template.replace("{combined}", combined)
        full_minutes = self.gemini.generate(prompt, max_tokens=1024)
        return f"{meta_section}\n\n{full_minutes}"
