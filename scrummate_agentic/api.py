"""
FastAPI server for the ScrumMate agentic pipeline.

Provides REST endpoints for:
- Running the pipeline on a transcript
- RAG queries over meeting history
- Health checks and statistics
"""

import json
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import MEETINGS_DIR, USER_STORIES_DIR, SUMMARIES_DIR
from pipeline import MeetingPipeline, PipelineResult
from services import RAGService, EmbeddingService


# Track pipeline status for async operations
pipeline_status = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize services on startup."""
    # Pre-load singleton services
    print("Initializing ScrumMate Agentic API...")
    try:
        _ = EmbeddingService()
        print("  - Embedding service initialized")
    except Exception as e:
        print(f"  - Warning: Could not initialize embedding service: {e}")
    yield
    print("Shutting down ScrumMate Agentic API...")


app = FastAPI(
    title="ScrumMate Agentic API",
    description="API for processing meeting transcripts into actionable items",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response models
class TranscriptRequest(BaseModel):
    """Request to process a transcript."""
    transcript_path: Optional[str] = None
    transcript_data: Optional[dict] = None
    skip_assignment: bool = False


class RAGQueryRequest(BaseModel):
    """Request to query meeting history."""
    question: str
    meeting_id: Optional[str] = None


class RAGQueryResponse(BaseModel):
    """Response from RAG query."""
    answer: str
    sources: list
    found_results: bool


class PipelineStatusResponse(BaseModel):
    """Response for pipeline status."""
    meeting_id: str
    status: str
    progress: Optional[str] = None
    error: Optional[str] = None
    result: Optional[dict] = None


# Health check
@app.get("/health")
async def health_check():
    """Check API health and service status."""
    try:
        embedding_service = EmbeddingService()
        stats = embedding_service.get_collection_stats()
        return {
            "status": "healthy",
            "services": {
                "embedding": "ready",
                "vector_db_count": stats["count"],
            }
        }
    except Exception as e:
        return {
            "status": "degraded",
            "error": str(e)
        }


# Pipeline endpoints
@app.post("/pipeline/run")
async def run_pipeline(request: TranscriptRequest, background_tasks: BackgroundTasks):
    """
    Run the full pipeline on a transcript.
    
    Can accept either a file path or raw transcript data.
    Returns immediately with a job ID for async processing.
    """
    # Determine transcript source
    if request.transcript_data:
        # Save transcript data to a temp file
        meeting_id = request.transcript_data.get("bot_id", "temp")[:12]
        transcript_path = MEETINGS_DIR / f"{meeting_id}_transcript.json"
        with open(transcript_path, "w", encoding="utf-8") as f:
            json.dump(request.transcript_data, f)
    elif request.transcript_path:
        transcript_path = Path(request.transcript_path)
        if not transcript_path.exists():
            raise HTTPException(status_code=404, detail=f"Transcript file not found: {request.transcript_path}")
        meeting_id = transcript_path.stem
    else:
        raise HTTPException(status_code=400, detail="Must provide either transcript_path or transcript_data")
    
    # Initialize status
    pipeline_status[meeting_id] = {
        "status": "running",
        "progress": "Starting pipeline...",
    }
    
    # Run in background
    background_tasks.add_task(
        _run_pipeline_async,
        transcript_path,
        meeting_id,
        request.skip_assignment
    )
    
    return {
        "meeting_id": meeting_id,
        "status": "started",
        "message": "Pipeline started. Use /pipeline/status/{meeting_id} to check progress."
    }


async def _run_pipeline_async(transcript_path: Path, meeting_id: str, skip_assignment: bool):
    """Background task to run the pipeline."""
    try:
        pipeline = MeetingPipeline()
        result = pipeline.run(transcript_path, skip_assignment=skip_assignment)
        
        if result.success:
            pipeline_status[meeting_id] = {
                "status": "completed",
                "result": {
                    "chunks_count": result.chunks_count,
                    "stories_count": result.stories_count,
                    "minutes_path": str(result.minutes_path) if result.minutes_path else None,
                    "stories_path": str(result.stories_path) if result.stories_path else None,
                    "assignments_path": str(result.assignments_path) if result.assignments_path else None,
                }
            }
        else:
            pipeline_status[meeting_id] = {
                "status": "failed",
                "error": result.error,
                "error_stage": result.error_stage,
            }
    except Exception as e:
        pipeline_status[meeting_id] = {
            "status": "failed",
            "error": str(e),
        }


@app.get("/pipeline/status/{meeting_id}")
async def get_pipeline_status(meeting_id: str):
    """Get the status of a pipeline run."""
    if meeting_id not in pipeline_status:
        raise HTTPException(status_code=404, detail=f"No pipeline found for meeting: {meeting_id}")
    
    return PipelineStatusResponse(
        meeting_id=meeting_id,
        **pipeline_status[meeting_id]
    )


@app.get("/pipeline/results/{meeting_id}")
async def get_pipeline_results(meeting_id: str):
    """Get the results of a completed pipeline run."""
    results = {}
    
    # Check for minutes
    minutes_path = SUMMARIES_DIR / f"{meeting_id}_final.txt"
    if minutes_path.exists():
        with open(minutes_path, "r", encoding="utf-8") as f:
            results["minutes"] = f.read()
    
    # Check for user stories
    stories_path = USER_STORIES_DIR / f"{meeting_id}_stories.json"
    if stories_path.exists():
        with open(stories_path, "r", encoding="utf-8") as f:
            results["user_stories"] = json.load(f)
    
    # Check for assignments
    assignments_path = USER_STORIES_DIR / f"{meeting_id}_assignments.json"
    if assignments_path.exists():
        with open(assignments_path, "r", encoding="utf-8") as f:
            results["assignments"] = json.load(f)
    
    if not results:
        raise HTTPException(status_code=404, detail=f"No results found for meeting: {meeting_id}")
    
    return {
        "meeting_id": meeting_id,
        **results
    }


# RAG endpoints
@app.post("/rag/query", response_model=RAGQueryResponse)
async def rag_query(request: RAGQueryRequest):
    """
    Query meeting history using RAG.
    
    Retrieves relevant chunks from past meetings and generates an answer.
    """
    try:
        rag_service = RAGService()
        result = rag_service.ask(request.question, meeting_id=request.meeting_id)
        return RAGQueryResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG query failed: {e}")


@app.get("/rag/stats")
async def rag_stats():
    """Get statistics about the RAG database."""
    try:
        rag_service = RAGService()
        return rag_service.get_stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get stats: {e}")


# Run with: uvicorn api:app --reload --port 8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
