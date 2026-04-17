"""
Centralized configuration for the ScrumMate agentic pipeline.
"""

import os
from pathlib import Path

# Base paths
BASE_DIR = Path(__file__).parent
CHUNKS_DIR = BASE_DIR / "chunks"
SUMMARIES_DIR = BASE_DIR / "summaries"
USER_STORIES_DIR = BASE_DIR / "user_stories"
STANDUPS_DIR = BASE_DIR / "standups"
RETROSPECTIVES_DIR = BASE_DIR / "retrospectives"
MEETINGS_DIR = BASE_DIR / "meetings"
CHROMA_DB_PATH = BASE_DIR / "chroma_db"
PROFILES_PATH = BASE_DIR / "sprintmembers" / "profile.json"
PROMPTS_DIR = BASE_DIR / "prompts"

# Ensure directories exist
for dir_path in [CHUNKS_DIR, SUMMARIES_DIR, USER_STORIES_DIR, STANDUPS_DIR, RETROSPECTIVES_DIR, MEETINGS_DIR]:
    dir_path.mkdir(exist_ok=True)

# Meeting types
MEETING_TYPE_PO = "product-owner"
MEETING_TYPE_STANDUP = "daily-standup"
MEETING_TYPE_RETRO = "retrospective"
VALID_MEETING_TYPES = {MEETING_TYPE_PO, MEETING_TYPE_STANDUP, MEETING_TYPE_RETRO}

# Map frontend radio values to prompt folder names
MEETING_TYPE_PROMPT_FOLDER = {
    MEETING_TYPE_PO: "po_meeting",
    MEETING_TYPE_STANDUP: "daily_standup",
    MEETING_TYPE_RETRO: "retrospective",
}

# API Configuration
GENAI_API_KEY = os.environ.get("GENAI_API_KEY")
if not GENAI_API_KEY:
    # Try loading from .env file in the same directory
    env_file = BASE_DIR / ".env"
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                if line.startswith("GENAI_API_KEY="):
                    GENAI_API_KEY = line.strip().split("=", 1)[1]
                    break

# Model Configuration
GEMINI_MODEL = "gemini-2.5-flash"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
CHROMA_COLLECTION_NAME = "meeting_chunks"

# Chunking Configuration
CHUNK_MIN_TOKENS = 20
CHUNK_MAX_TOKENS = 700
CHUNK_MERGE_GAP_SECONDS = 5.0
CHUNK_MAX_SECONDS = 180

# Summarization Configuration
SUMMARY_BATCH_SIZE = 5

# Assignment Configuration
ASSIGNMENT_BATCH_SIZE = 10

# RAG Configuration
RAG_MAX_CHUNKS = 5

# ========== n8n Integration ==========
N8N_BASE_URL = "http://localhost:5678"           # Change to your n8n instance
N8N_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YTA4ZTkxNi04YWIyLTQ1ZTQtYTQxYy03MWJiMzI0MzgxNTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzY1MjM0NjAzfQ.hJPE1Shr5HgJOyM-9QybTLmWIcq2wUhTMxCYvx3US3o"
N8N_WORKFLOW_ID = "JgL4ipoMjAxDsZMJ"
N8N_ENABLED = True                               # Set False to disable triggering