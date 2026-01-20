"""
Summarization service for generating meeting minutes using hierarchical summarization.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from typing import List, Dict, Any, Tuple

from config import SUMMARY_BATCH_SIZE, SUMMARIES_DIR
from .gemini_client import GeminiClient


SCRUM_MASTER_PROMPT = """You are a Scrum Master reviewing meeting transcripts. Summarize what was actually discussed based ONLY on the transcript provided. Do not invent names, tasks, or information not present in the transcript."""


class SummarizationService:
    """Generates meeting minutes using hierarchical summarization."""
    
    def __init__(self, batch_size: int = SUMMARY_BATCH_SIZE):
        self.batch_size = batch_size
        self.gemini = GeminiClient()
    
    def generate_minutes(
        self,
        chunks: List[Dict[str, Any]],
        meeting_meta: Dict[str, Any]
    ) -> str:
        """
        Generate meeting minutes from chunks.
        
        Args:
            chunks: List of chunk dictionaries
            meeting_meta: Meeting metadata
            
        Returns:
            Final meeting minutes as string
        """
        # Sort chunks by time
        sorted_chunks = sorted(chunks, key=lambda c: c.get("start_time", 0))
        
        # Create batches
        batches = self._create_batches(sorted_chunks)
        
        # Summarize each batch
        batch_summaries = []
        for i, batch in enumerate(batches, 1):
            summary = self._summarize_batch(batch, i)
            batch_summaries.append(summary)
        
        # Combine into final minutes
        final_minutes = self._combine_summaries(batch_summaries, meeting_meta)
        
        return final_minutes
    
    def generate_and_save(
        self,
        chunks_path: Path,
        meeting_id: str
    ) -> Path:
        """
        Generate minutes from a chunks file and save to disk.
        
        Args:
            chunks_path: Path to the chunks JSON file
            meeting_id: Meeting identifier
            
        Returns:
            Path to the saved minutes file
        """
        chunks, meeting_meta = self._load_chunks(chunks_path)
        minutes = self.generate_minutes(chunks, meeting_meta)
        
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
    
    def _summarize_batch(self, chunks: List[Dict], batch_num: int) -> str:
        """Summarize a batch of chunks."""
        transcript_parts = []
        
        for chunk in chunks:
            speakers = chunk.get("speakers", ["unknown"])
            start_time = chunk.get("start_time", 0)
            text = chunk.get("text", "")
            speaker_str = " & ".join(speakers) if len(speakers) > 1 else speakers[0]
            transcript_parts.append(f"[{start_time:.0f}s | {speaker_str}]\n{text}")
        
        transcript = "\n\n".join(transcript_parts)
        
        prompt = f"""{SCRUM_MASTER_PROMPT}

Summarize this portion of the meeting. Focus on:
- What was discussed
- Any decisions made
- Action items mentioned (ALWAYS include who requested/assigned them)
- Blockers or concerns
- Progress updates
- Technical constraints or requirements

TRANSCRIPT:
{transcript}

SUMMARY:"""
        
        return self.gemini.generate(prompt)
    
    def _combine_summaries(
        self, 
        batch_summaries: List[str], 
        meeting_meta: Dict
    ) -> str:
        """Combine batch summaries into final minutes."""
        combined = "\n\n---\n\n".join([
            f"## Part {i+1}\n{summary}" 
            for i, summary in enumerate(batch_summaries)
        ])
        
        meta_section = f"""**MEETING METADATA**
- Meeting ID: {meeting_meta.get('meeting_id', 'N/A')}
- Platform: {meeting_meta.get('platform', 'N/A')}
- Start Time: {meeting_meta.get('start_time', 'N/A')}
- Meeting URL: {meeting_meta.get('meeting_url', 'N/A')}

---"""
        
        prompt = f"""You have summaries from different parts of a meeting. Create comprehensive meeting minutes with these sections:

**1. MEETING OVERVIEW**
**2. KEY DISCUSSION POINTS**
**3. DECISIONS MADE**
**4. ACTION ITEMS**
**5. TECHNICAL CONSTRAINTS & REQUIREMENTS**
**6. BLOCKERS & CONCERNS**
**7. NEXT STEPS**

BATCH SUMMARIES:
{combined}

FINAL MEETING MINUTES:"""
        
        full_minutes = self.gemini.generate(prompt, max_tokens=1024)
        return f"{meta_section}\n\n{full_minutes}"
