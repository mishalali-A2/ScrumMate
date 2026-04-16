"""
Chunking service for processing meeting transcripts into semantic chunks.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json
from datetime import datetime
from typing import List, Dict, Any, Optional

from config import (
    CHUNK_MIN_TOKENS,
    CHUNK_MAX_TOKENS,
    CHUNK_MERGE_GAP_SECONDS,
    CHUNK_MAX_SECONDS,
    CHUNKS_DIR,
)

# Token counting
try:
    import tiktoken
    _ENCODER = tiktoken.get_encoding("cl100k_base")
    def _count_tokens(text: str) -> int:
        return len(_ENCODER.encode(text))
except ImportError:
    def _count_tokens(text: str) -> int:
        # Fallback: words * 1.3
        return int(len(text.split()) * 1.3) + 1


class ChunkingService:
    """Processes transcripts into semantic chunks."""
    
    def __init__(
        self,
        min_tokens: int = CHUNK_MIN_TOKENS,
        max_tokens: int = CHUNK_MAX_TOKENS,
        merge_gap_seconds: float = CHUNK_MERGE_GAP_SECONDS,
        max_seconds: float = CHUNK_MAX_SECONDS,
    ):
        self.min_tokens = min_tokens
        self.max_tokens = max_tokens
        self.merge_gap_seconds = merge_gap_seconds
        self.max_seconds = max_seconds
    
    def process_transcript(
        self, 
        transcript_data: Dict[str, Any],
        meeting_id: str
    ) -> List[Dict[str, Any]]:
        """
        Process a transcript into chunks.
        
        Args:
            transcript_data: Raw transcript data with 'transcript' key
            meeting_id: Unique identifier for the meeting
            
        Returns:
            List of chunk dictionaries
        """
        segments = transcript_data.get("transcript", [])
        if not segments:
            return []
        
        # Get meeting start time
        meeting_start_str = transcript_data.get("created_at", "")
        meeting_start_time = self._parse_timestamp(meeting_start_str)
        
        # Build meeting metadata
        meeting_meta = {
            "bot_id": transcript_data.get("bot_id"),
            "meeting_url": transcript_data.get("meeting_url"),
            "created_at": transcript_data.get("created_at"),
            "stopped_at": transcript_data.get("stopped_at"),
            "statistics": transcript_data.get("statistics", {}),
        }
        
        # Process
        turns = self._build_turns(segments, meeting_start_time)
        chunks = self._build_chunks_from_turns(turns, meeting_meta, meeting_id)
        
        # Normalize
        for chunk in chunks:
            chunk["speakers"] = [
                s if s else "unknown" for s in chunk.get("speakers", [])
            ]
            chunk["segment_indexes"] = chunk.get("segment_indexes", [])
        
        return chunks
    
    def process_and_save(
        self,
        transcript_path: Path,
        meeting_id: str
    ) -> Path:
        """
        Process a transcript file and save chunks to disk.
        
        Args:
            transcript_path: Path to the transcript JSON file
            meeting_id: Unique identifier for the meeting
            
        Returns:
            Path to the saved chunks file
        """
        with open(transcript_path, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)
        
        chunks = self.process_transcript(transcript_data, meeting_id)
        
        output_path = CHUNKS_DIR / f"{meeting_id}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"chunks": chunks}, f, ensure_ascii=False, indent=2)
        
        return output_path
    
    def _parse_timestamp(self, ts_str: str) -> float:
        """Convert ISO timestamp to seconds since epoch."""
        try:
            dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
            return dt.timestamp()
        except (ValueError, AttributeError):
            return 0.0
    
    def _normalize_speaker(self, speaker: Optional[str]) -> str:
        """Normalize speaker name."""
        return speaker if speaker else "unknown"
    
    def _chunk_id_for(self, meeting_id: str, start: float, end: float) -> str:
        """Generate a unique chunk ID."""
        return f"{meeting_id}-{int(start*1000)}-{int(end*1000)}"
    
    def _split_text_by_tokens(self, text: str, max_tokens: int) -> List[str]:
        """Split text into pieces under max_tokens."""
        words = text.split()
        if not words:
            return []
        
        pieces = []
        current = []
        
        for word in words:
            current.append(word)
            if _count_tokens(" ".join(current)) >= max_tokens:
                if len(current) > 1:
                    last = current.pop()
                    pieces.append(" ".join(current))
                    current = [last]
                else:
                    pieces.append(" ".join(current))
                    current = []
        
        if current:
            pieces.append(" ".join(current))
        
        return pieces
    
    def _build_turns(
        self, 
        segments: List[Dict], 
        meeting_start_time: float
    ) -> List[Dict]:
        """Merge consecutive segments by same speaker."""
        if not segments:
            return []
        
        processed_segs = []
        for i, seg in enumerate(segments):
            speaker = self._normalize_speaker(seg.get("speaker"))
            timestamp = seg.get("timestamp", "")
            text = (seg.get("text") or "").strip()
            
            abs_time = self._parse_timestamp(timestamp)
            rel_time = abs_time - meeting_start_time if meeting_start_time > 0 else 0.0
            
            # Estimate end time
            if i < len(segments) - 1:
                next_ts = self._parse_timestamp(segments[i + 1].get("timestamp", ""))
                end_time = next_ts - meeting_start_time if meeting_start_time > 0 else rel_time + 2.0
            else:
                end_time = rel_time + 2.0
            
            processed_segs.append({
                "speaker": speaker,
                "start": rel_time,
                "end": end_time,
                "abs_start": timestamp,
                "abs_end": segments[i + 1].get("timestamp") if i < len(segments) - 1 else timestamp,
                "text": text,
                "index": i
            })
        
        # Merge by speaker and gap
        turns = []
        current = None
        
        for seg in processed_segs:
            if current is None:
                current = {
                    "speaker": seg["speaker"],
                    "start": seg["start"],
                    "end": seg["end"],
                    "abs_start": seg["abs_start"],
                    "abs_end": seg["abs_end"],
                    "texts": [seg["text"]],
                    "segment_indexes": [seg["index"]],
                    "segment_count": 1
                }
                continue
            
            gap = seg["start"] - current["end"]
            if seg["speaker"] == current["speaker"] and gap <= self.merge_gap_seconds:
                current["end"] = max(current["end"], seg["end"])
                current["abs_end"] = seg["abs_end"]
                current["texts"].append(seg["text"])
                current["segment_indexes"].append(seg["index"])
                current["segment_count"] += 1
            else:
                turns.append(current)
                current = {
                    "speaker": seg["speaker"],
                    "start": seg["start"],
                    "end": seg["end"],
                    "abs_start": seg["abs_start"],
                    "abs_end": seg["abs_end"],
                    "texts": [seg["text"]],
                    "segment_indexes": [seg["index"]],
                    "segment_count": 1
                }
        
        if current:
            turns.append(current)
        
        return turns
    
    def _build_chunks_from_turns(
        self,
        turns: List[Dict],
        meeting_meta: Dict,
        meeting_id: str
    ) -> List[Dict]:
        """Combine turns into chunks following size rules."""
        chunks = []
        current = None
        
        def close_current():
            nonlocal current
            if not current:
                return
            
            text = " ".join(current["texts"])
            token_count = _count_tokens(text)
            
            chunk = {
                "chunk_id": self._chunk_id_for(meeting_id, current["start"], current["end"]),
                "meeting_id": meeting_id,
                "meeting_meta": meeting_meta,
                "start_time": current["start"],
                "end_time": current["end"],
                "abs_start": current.get("abs_start"),
                "abs_end": current.get("abs_end"),
                "speakers": list(dict.fromkeys(current["speakers"])),
                "segment_indexes": current.get("segment_indexes", []),
                "segment_count": current.get("segment_count", 0),
                "text": text,
                "token_count": token_count,
                "char_count": len(text)
            }
            
            # Split if over token limit
            if token_count > self.max_tokens:
                pieces = self._split_text_by_tokens(text, self.max_tokens)
                seg_idxs = current.get("segment_indexes", [])
                
                for idx, piece in enumerate(pieces):
                    sub_chunk = dict(chunk)
                    sub_chunk["chunk_id"] = f"{chunk['chunk_id']}-part{idx+1}"
                    sub_chunk["text"] = piece
                    sub_chunk["token_count"] = _count_tokens(piece)
                    sub_chunk["char_count"] = len(piece)
                    
                    if seg_idxs:
                        start_idx = int(len(seg_idxs) * idx / len(pieces))
                        end_idx = int(len(seg_idxs) * (idx + 1) / len(pieces))
                        sub_chunk["segment_indexes"] = seg_idxs[start_idx:end_idx] or seg_idxs
                        sub_chunk["segment_count"] = len(sub_chunk["segment_indexes"])
                    
                    chunks.append(sub_chunk)
            else:
                chunks.append(chunk)
        
        for turn in turns:
            turn_text = " ".join(turn["texts"]).strip()
            if not turn_text:
                continue
            
            turn_tokens = _count_tokens(turn_text)
            
            # Case 1: Turn too long - split it
            if turn_tokens > self.max_tokens:
                if current:
                    close_current()
                    current = None
                
                current = {
                    "start": turn["start"],
                    "end": turn["end"],
                    "abs_start": turn.get("abs_start"),
                    "abs_end": turn.get("abs_end"),
                    "speakers": [turn["speaker"]],
                    "texts": [turn_text],
                    "segment_indexes": turn["segment_indexes"].copy(),
                    "segment_count": turn.get("segment_count", 1)
                }
                close_current()
                current = None
                continue
            
            # Case 2: Turn too short - merge into previous
            if turn_tokens < self.min_tokens and current is not None:
                candidate_text = current["texts"] + [turn_text]
                candidate_full = " ".join(candidate_text)
                candidate_tokens = _count_tokens(candidate_full)
                candidate_duration = max(current["end"], turn["end"]) - current["start"]
                
                if candidate_tokens <= self.max_tokens and candidate_duration <= self.max_seconds:
                    current["end"] = max(current["end"], turn["end"])
                    current["abs_end"] = turn.get("abs_end") or current["abs_end"]
                    if turn["speaker"] not in current["speakers"]:
                        current["speakers"].append(turn["speaker"])
                    current["texts"].append(turn_text)
                    current["segment_indexes"].extend(turn["segment_indexes"])
                    current["segment_count"] = current.get("segment_count", 0) + turn.get("segment_count", 1)
                    continue
                else:
                    close_current()
                    current = {
                        "start": turn["start"],
                        "end": turn["end"],
                        "abs_start": turn.get("abs_start"),
                        "abs_end": turn.get("abs_end"),
                        "speakers": [turn["speaker"]],
                        "texts": [turn_text],
                        "segment_indexes": turn["segment_indexes"].copy(),
                        "segment_count": turn.get("segment_count", 1)
                    }
                    continue
            
            # Case 3: Turn is meaningful size - create new chunk
            if current:
                close_current()
            
            current = {
                "start": turn["start"],
                "end": turn["end"],
                "abs_start": turn.get("abs_start"),
                "abs_end": turn.get("abs_end"),
                "speakers": [turn["speaker"]],
                "texts": [turn_text],
                "segment_indexes": turn["segment_indexes"].copy(),
                "segment_count": turn.get("segment_count", 1)
            }
        
        # Close final chunk
        if current:
            close_current()
        
        return chunks
