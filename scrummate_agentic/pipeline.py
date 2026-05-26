"""Main pipeline for processing meeting transcripts.

Pipeline stages vary by meeting type:

  Product Owner:     Chunking -> Embedding -> Minutes -> User Stories -> Assignment -> n8n Trigger
  Daily Standup:     Chunking -> Embedding -> Minutes -> Blockers Report
  Retrospective:     Chunking -> Embedding -> Minutes -> Retro Analysis
"""

import json
import re
import sys
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

import requests  # for n8n trigger

from config import (
    CHUNKS_DIR, SUMMARIES_DIR, USER_STORIES_DIR, STANDUPS_DIR, RETROSPECTIVES_DIR,
    MEETING_TYPE_PO, MEETING_TYPE_STANDUP, MEETING_TYPE_RETRO, VALID_MEETING_TYPES,
    N8N_BASE_URL, N8N_API_KEY, N8N_WORKFLOW_ID, N8N_ENABLED,
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


# ========== n8n Trigger Service (embedded) ==========
class N8nTriggerService:
    """Trigger an n8n workflow with user stories data."""
    def __init__(self, base_url: str, api_key: str, workflow_id: str):
        self.base_url = base_url.rstrip('/')
        self.workflow_id = workflow_id
        self.headers = {'Content-Type': 'application/json'}
        if api_key:
            self.headers['X-N8N-API-KEY'] = api_key

    def trigger_workflow(self, stories_data: Dict[str, Any]) -> bool:
        stories_json_str = json.dumps(stories_data, ensure_ascii=False, indent=2)
        payload = {"userStories": stories_json_str}
        return self._trigger_webhook_or_run(payload)

    def _trigger_webhook_or_run(self, payload: dict) -> bool:
        info_url = f"{self.base_url}/api/v1/workflows/{self.workflow_id}"
        try:
            resp = requests.get(info_url, headers=self.headers, timeout=10)
            if resp.status_code == 200:
                info = resp.json()
                webhook_node = self._find_webhook_node(info)
                if webhook_node:
                    path, method = self._normalize_webhook(webhook_node)
                    return self._call_webhook(path, method, payload)
        except Exception as e:
            print(f"⚠️ n8n webhook detection failed: {e}")
        return self._call_run_api(payload)

    def _find_webhook_node(self, workflow_info: dict) -> Optional[dict]:
        nodes = workflow_info.get("nodes") or workflow_info.get("workflow", {}).get("nodes", []) or []
        for n in nodes:
            t = n.get("type", "") or ""
            if "webhook" in t.lower() or n.get("typeName", "").lower() == "webhook":
                return n
        return None

    def _normalize_webhook(self, node: dict):
        params = node.get("parameters", {}) or {}
        raw_path = params.get("path") or params.get("webhookPath") or params.get("pathValue") or ""
        raw_path = str(raw_path).strip()
        method = params.get("httpMethod") or params.get("method") or "POST"
        if isinstance(method, (list, tuple)) and method:
            method = method[0]
        method = str(method).upper() if method else "POST"

        if not raw_path:
            norm = "/webhook"
        elif raw_path.startswith("/"):
            norm = raw_path
        elif "webhook" in raw_path.lower():
            norm = "/" + raw_path
        else:
            norm = "/webhook/" + raw_path
        return norm, method

    def _call_webhook(self, path: str, method: str, payload: dict) -> bool:
        url = self.base_url + path
        try:
            if method == "GET":
                resp = requests.get(url, params=payload, timeout=30)
            else:
                resp = requests.post(url, json=payload, timeout=30)
            if 200 <= resp.status_code < 300:
                print("✅ n8n workflow triggered via webhook")
                return True
            print(f"⚠️ n8n webhook returned {resp.status_code}")
            return False
        except Exception as e:
            print(f"⚠️ n8n webhook call failed: {e}")
            return False

    def _call_run_api(self, payload: dict) -> bool:
        url = f"{self.base_url}/api/v1/workflows/{self.workflow_id}/run"
        run_payload = {"inputData": payload.get("userStories", "")}
        try:
            resp = requests.post(url, headers=self.headers, json=run_payload, timeout=30)
            if 200 <= resp.status_code < 300:
                print("✅ n8n workflow triggered via /run API")
                return True
            print(f"⚠️ n8n /run returned {resp.status_code}")
            return False
        except Exception as e:
            print(f"⚠️ n8n /run failed: {e}")
            return False


# ========== Pipeline Classes ==========
@dataclass
class PipelineResult:
    """Result of a pipeline run."""
    success: bool
    meeting_id: str
    meeting_type: str = MEETING_TYPE_PO
    chunks_path: Optional[Path] = None
    chunks_count: int = 0
    minutes_path: Optional[Path] = None
    stories_path: Optional[Path] = None
    stories_count: int = 0
    assignments_path: Optional[Path] = None
    blockers_path: Optional[Path] = None
    retro_path: Optional[Path] = None
    error: Optional[str] = None
    error_stage: Optional[str] = None


class MeetingPipeline:
    def __init__(self):
        self.chunking = ChunkingService()
        self.embedding = EmbeddingService()
        self.summarization = SummarizationService()
        self.userstory = UserStoryService()
        self.assignment = AssignmentService()
        self.blockers = BlockersService()
        self.retro = RetroService()

        # Initialise n8n trigger if enabled
        if N8N_ENABLED and N8N_BASE_URL and N8N_WORKFLOW_ID:
            self.n8n = N8nTriggerService(N8N_BASE_URL, N8N_API_KEY, N8N_WORKFLOW_ID)
        else:
            self.n8n = None
            if N8N_ENABLED:
                print("⚠️ n8n integration enabled but missing config (BASE_URL/WORKFLOW_ID) – skipping")

    @staticmethod
    def _extract_project_name(minutes: str, meeting_id: str) -> str:
        """
        Best-effort extraction of the project/product name from meeting minutes text.

        Tries the following patterns in order:
          1. Markdown H1 heading:            # RetailEdge App — Sprint 6
          2. Bold title line:                **RetailEdge App - Meeting Minutes**
          3. Intro sentence:                 "Here are the ... minutes for <Name> —"
                                             "Here are the <Name> minutes:"
          4. Any bold capitalised phrase on its own line longer than 4 words
          5. Fallback: the meeting_id itself
        """
        # Strip the metadata block so we don't match fields inside it
        body = re.sub(r'\*\*MEETING METADATA\*\*.*?---', '', minutes, flags=re.DOTALL).strip()

        # 1. Markdown H1: # Some Project Name — extra stuff
        m = re.search(r'^#\s+(.+?)(?:\s+[—–-]|\s*$)', body, re.MULTILINE)
        if m:
            return m.group(1).strip()

        # 2. Bold title line: **Some Project Name — Meeting Minutes**
        m = re.search(r'^\*\*([^*\n]{6,}?)\s*(?:[—–-][^*\n]*)?\*\*\s*$', body, re.MULTILINE)
        if m:
            candidate = m.group(1).strip()
            # Skip generic section headers (all caps, single word, or very short)
            if not re.match(r'^[A-Z\s&]+$', candidate) and len(candidate) > 8:
                return candidate

        # 3. Intro sentence patterns
        #    "Here are the meeting minutes for RetailEdge App — Sprint 6 PO session:"
        m = re.search(
            r'(?:here are the [a-z\s]+ minutes for|minutes for the)\s+([^\n\u2014\u2013:]{4,80}?)(?:\s+[\u2014\u2013]|\s*[:\n])',
            body, re.IGNORECASE
        )
        if m:
            candidate = re.sub(r'^(?:the|a|an)\s+', '', m.group(1).strip(), flags=re.IGNORECASE)
            return candidate.strip('\u2014\u2013- ') or meeting_id

        #    "Here are the concise HealthTrack standup minutes:" — extract the product word
        m = re.search(r'here are the (?:concise |final |)(\w[\w\s&.]{3,40?}) (?:meeting |standup |)minutes', body, re.IGNORECASE)
        if m:
            candidate = m.group(1).strip()
            if candidate.lower() not in ('meeting', 'standup', 'sprint', 'po', 'retro', 'retrospective'):
                return candidate

        # 4. Any standalone bold line that looks like a proper name (Title Case, ≥3 words)
        for m in re.finditer(r'^\*\*([A-Z][A-Za-z0-9 &.,\-]{8,60})\*\*\s*$', body, re.MULTILINE):
            candidate = m.group(1).strip()
            if re.search(r'[A-Z]', candidate) and not re.match(r'^[A-Z\s]+$', candidate):
                return candidate

        return meeting_id

    def extract_meeting_id(self, transcript_data: Dict[str, Any]) -> str:
        meeting_url = transcript_data.get("meeting_url", "")
        match = re.search(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", meeting_url)
        if match:
            return match.group(1)
        bot_id = transcript_data.get("bot_id", "")
        if bot_id:
            return bot_id[:12]
        return "meeting-unknown"

    def run(self, transcript_path: Path, meeting_type: str = MEETING_TYPE_PO, skip_assignment: bool = False) -> PipelineResult:
        # Validate meeting type
        if meeting_type not in VALID_MEETING_TYPES:
            print(f"Unknown meeting type '{meeting_type}', defaulting to product-owner")
            meeting_type = MEETING_TYPE_PO

        # Load transcript
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                transcript_data = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            return PipelineResult(success=False, meeting_id="unknown", meeting_type=meeting_type,
                                  error=f"Failed to load transcript: {e}", error_stage="load")

        meeting_id = self.extract_meeting_id(transcript_data)
        result = PipelineResult(success=False, meeting_id=meeting_id, meeting_type=meeting_type)

        # Stage 1: Chunking
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

        # Stage 2: Embeddings
        print(f"[2/4] Generating embeddings and storing in vector database")
        try:
            added = self.embedding.add_chunks(chunks)
            print(f"      Added {added} chunks to vector database")
        except Exception as e:
            result.error = f"Embedding failed: {e}"
            result.error_stage = "embedding"
            return result

        # Stage 3: Summarization
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

            # Also save a companion JSON: { project_name, meeting_minutes }
            # Prefer the project_name injected by the Node server (from the user's
            # project dropdown) — only fall back to regex extraction if absent.
            project_name = (
                transcript_data.get("project_name")
                or self._extract_project_name(minutes, meeting_id)
            )
            minutes_json_path = SUMMARIES_DIR / f"{meeting_id}_minutes.json"
            with open(minutes_json_path, "w", encoding="utf-8") as f:
                json.dump({"project_name": project_name, "meeting_minutes": minutes}, f, ensure_ascii=False, indent=2)
            print(f"      Minutes JSON saved to {minutes_json_path}")
        except Exception as e:
            result.error = f"Summarization failed: {e}"
            result.error_stage = "summarization"
            return result

        # Stage 4: Type-specific analysis
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
    def _run_po_stages(self, result: PipelineResult, minutes: str, meeting_id: str, skip_assignment: bool) -> PipelineResult:
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

    def _run_standup_stages(self, result: PipelineResult, minutes: str, meeting_id: str) -> PipelineResult:
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

    def _run_retro_stages(self, result: PipelineResult, minutes: str, meeting_id: str) -> PipelineResult:
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
        print("  product-owner  : Chunking -> Embedding -> Minutes -> User Stories -> Assignment -> n8n Trigger")
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