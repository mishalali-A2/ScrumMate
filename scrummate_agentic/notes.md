# Transcript Chunking Script - How It Works

## Overview

This script transforms raw meeting transcripts into semantically meaningful chunks optimized for RAG (Retrieval-Augmented Generation) applications. The goal is to create chunks that are coherent, contextually complete, and properly sized for LLM processing while maintaining chronological flow and conversational integrity.

## High-Level Methodology

### Phase 1: Preprocessing & Turn Building

**Goal:** Consolidate fragmented speech into coherent turns while respecting speaker boundaries.

The transcript arrives as a sequence of small segments—often just single sentences or phrases—each with a speaker, text, and timestamp. The first step merges consecutive segments from the same speaker if they occur within a short time window (5 seconds by default). This handles natural speech patterns where someone might pause briefly but is still continuing their thought.

**Result:** A sequence of "turns" where speakers alternate cleanly: A → B → A → B, with no repeated speaker turns in sequence. Each turn contains all the text that person spoke during that continuous speaking period.

**Implementation:** The `build_turns()` function processes segments chronologically, calculating relative timestamps from the meeting start and merging same-speaker segments within `MERGE_GAP_SECONDS`.

### Phase 2: Intelligent Chunking

**Goal:** Create chunks that balance semantic completeness with token constraints.

Once we have clean turns, we apply a three-tier decision process for each turn:

#### 1. **Too Long (> MAX_TOKENS)**
If a single turn exceeds our token limit (~700 tokens), we split it into multiple sub-chunks. This ensures we never send oversized text to the LLM. Each sub-chunk gets a unique ID with a `-part1`, `-part2` suffix and maintains references to the original segment indexes.

**Why:** Even a single speaker's monologue needs to respect the model's processing limits.

#### 2. **Too Short (< MIN_TOKENS)**
If a turn is very short (< 50 tokens)—like "Yeah", "Got it", "Okay"—we merge it into the *previous* chunk, even if it's from a different speaker. This creates multi-speaker chunks that preserve conversational context rather than fragmenting interjections into meaningless micro-chunks.

**Why:** Chronological coherence matters more than strict speaker separation. A response like "okay" only makes sense in context of what came before.

#### 3. **Just Right (MIN_TOKENS to MAX_TOKENS)**
If a turn is substantial enough to stand alone but not too large, we create a new chunk from it. This represents a complete thought or statement that provides meaningful context on its own.

**Why:** These are the ideal semantic units—self-contained enough to be useful but not so large they lose focus.

### Safety Constraints

Throughout the chunking process, we also enforce:

- **Maximum duration** (180 seconds): Even if tokens allow, don't create chunks spanning more than 3 minutes
- **Token limits on merges**: When merging short turns, we verify the combined text won't exceed MAX_TOKENS
- **Duration limits on merges**: Check that adding a short turn won't push the chunk over MAX_SECONDS

**Implementation:** The `build_chunks_from_turns()` function implements this three-tier logic, with `close_cur()` handling the finalization and potential sub-chunking of oversized text.

## Metadata Preservation

Every chunk carries rich metadata:

- **Temporal info**: Both relative (`start_time`, `end_time` in seconds from meeting start) and absolute timestamps (`abs_start`, `abs_end` as ISO strings)
- **Speaker tracking**: Ordered list of unique speakers in the chunk, preserving who spoke first
- **Provenance**: Original segment indexes and count, allowing reconstruction of source material
- **Content metrics**: Token count (using tiktoken when available) and character count for downstream processing decisions
- **Meeting context**: Full meeting metadata (bot_id, meeting_url, statistics) attached to each chunk

## Token Counting Strategy

We use `tiktoken` (OpenAI's tokenizer) when available for accurate token counting, falling back to a word-based estimation (`words * 1.3`) if unavailable. This ensures chunks stay within LLM context windows regardless of the model being used downstream.

**Implementation:** The `count_tokens()` function with try/except fallback, and `split_text_by_tokens()` for word-level splitting when needed.

## Key Design Principles

1. **Chronology over speaker purity**: A conversation fragment with mixed speakers is more useful than isolated interjections
2. **Context completeness**: Chunks should contain enough information to be independently meaningful
3. **No data loss**: Every segment appears exactly once across all chunks
4. **Flexible boundaries**: Token limits are targets, not rigid walls—semantic coherence can justify slightly larger/smaller chunks
5. **Metadata richness**: Downstream systems need temporal, speaker, and provenance information for intelligent retrieval

## Why This Approach Works for RAG

When an LLM needs to answer questions about a meeting, it retrieves relevant chunks. Our chunking strategy ensures:

- **Short interjections stay contextual**: "Yes" merged with the previous question makes sense; "Yes" alone is meaningless
- **No artificial splits**: A speaker's complete thought stays together unless it's genuinely too long
- **Temporal queries work**: Rich timestamp metadata enables "what happened around 2:30pm?" queries
- **Speaker attribution is accurate**: Multi-speaker chunks correctly list all participants
- **Token budgets are respected**: Chunks fit reliably into LLM context windows without truncation

The result is a set of chunks that balance the competing needs of semantic coherence, speaker attribution, temporal accuracy, and computational constraints—all critical for effective retrieval and generation in conversational AI systems.