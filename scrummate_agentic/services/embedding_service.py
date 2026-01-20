"""
Embedding service for vector storage and retrieval.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from typing import List, Dict, Any, Optional
import chromadb
from sentence_transformers import SentenceTransformer

from config import (
    CHROMA_DB_PATH,
    CHROMA_COLLECTION_NAME,
    EMBEDDING_MODEL,
)


class EmbeddingService:
    """Handles embedding generation and ChromaDB operations."""
    
    _instance = None
    _model = None
    _client = None
    _collection = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._model = SentenceTransformer(EMBEDDING_MODEL)
            cls._client = chromadb.PersistentClient(path=str(CHROMA_DB_PATH))
            cls._collection = cls._client.get_or_create_collection(
                name=CHROMA_COLLECTION_NAME
            )
        return cls._instance
    
    def add_chunks(self, chunks: List[Dict[str, Any]]) -> int:
        """
        Add chunks to the vector database.
        
        Args:
            chunks: List of chunk dictionaries with 'chunk_id', 'text', and metadata
            
        Returns:
            Number of chunks added
        """
        if not chunks:
            return 0
            
        texts = [c["text"] for c in chunks]
        metadatas = [
            {
                "meeting_id": c.get("meeting_id", "unknown"),
                "start_time": c.get("start_time", 0),
                "end_time": c.get("end_time", 0),
                "speakers": ", ".join(c.get("speakers", [])),
            }
            for c in chunks
        ]
        ids = [c["chunk_id"] for c in chunks]
        
        embeddings = self._model.encode(texts, show_progress_bar=True)
        
        self._collection.add(
            documents=texts,
            embeddings=embeddings.tolist(),
            metadatas=metadatas,
            ids=ids
        )
        
        return len(chunks)
    
    def query(
        self, 
        question: str, 
        n_results: int = 5,
        meeting_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Query the vector database for relevant chunks.
        
        Args:
            question: The query text
            n_results: Number of results to return
            meeting_id: Optional filter by meeting ID
            
        Returns:
            List of result dictionaries with 'document', 'metadata', 'distance'
        """
        query_embedding = self._model.encode([question])[0].tolist()
        
        where_filter = None
        if meeting_id:
            where_filter = {"meeting_id": meeting_id}
        
        results = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            include=["documents", "metadatas", "distances"],
            where=where_filter
        )
        
        if not results["documents"][0]:
            return []
        
        return [
            {
                "document": doc,
                "metadata": meta,
                "distance": dist
            }
            for doc, meta, dist in zip(
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0]
            )
        ]
    
    def get_collection_stats(self) -> Dict[str, Any]:
        """Get statistics about the collection."""
        return {
            "count": self._collection.count(),
            "name": CHROMA_COLLECTION_NAME,
        }
