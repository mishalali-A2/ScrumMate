"""
RAG (Retrieval-Augmented Generation) service for querying meeting history.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from typing import Optional, List, Dict, Any

from config import RAG_MAX_CHUNKS
from .gemini_client import GeminiClient
from .embedding_service import EmbeddingService


class RAGService:
    """Provides RAG-based question answering over meeting transcripts."""
    
    def __init__(self, max_chunks: int = RAG_MAX_CHUNKS):
        self.max_chunks = max_chunks
        self.gemini = GeminiClient()
        self.embedding_service = EmbeddingService()
    
    def ask(
        self,
        question: str,
        meeting_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Answer a question using RAG over meeting transcripts.
        
        Args:
            question: The question to answer
            meeting_id: Optional filter to a specific meeting
            
        Returns:
            Dictionary with 'answer', 'sources', and 'found_results'
        """
        # Retrieve relevant chunks
        results = self.embedding_service.query(
            question,
            n_results=self.max_chunks,
            meeting_id=meeting_id
        )
        
        if not results:
            return {
                "answer": "No relevant information found in the meeting transcripts.",
                "sources": [],
                "found_results": False
            }
        
        # Build context from retrieved chunks
        context_parts = []
        sources = []
        
        for i, result in enumerate(results, 1):
            doc = result["document"]
            meta = result["metadata"]
            speaker = meta.get("speakers", "unknown")
            time = meta.get("start_time", 0)
            
            context_parts.append(
                f"[Excerpt {i}] Speaker: {speaker} | Time: {time:.0f}s\n{doc}"
            )
            
            sources.append({
                "excerpt_num": i,
                "speaker": speaker,
                "start_time": time,
                "meeting_id": meta.get("meeting_id"),
                "text_preview": doc[:200] + "..." if len(doc) > 200 else doc
            })
        
        context = "\n\n".join(context_parts)
        
        # Build prompt
        prompt = f"""You are a helpful assistant answering questions about a meeting, mentioning speaker names and relevant context. Only use the following excerpts and no other information:

{context}

Question: {question}

Answer:"""
        
        answer = self.gemini.generate(prompt)
        
        return {
            "answer": answer,
            "sources": sources,
            "found_results": True
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about the RAG database."""
        return self.embedding_service.get_collection_stats()
