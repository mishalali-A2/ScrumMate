# Meeting Types - Pipeline Design

## Overview

The pipeline runs different analysis stages depending on the meeting type selected in the frontend. The meeting type is captured when "Join Meeting" is clicked and passed through when "Run Pipeline" is triggered after the meeting ends.

---

## Meeting Types

### 1. Product Owner Meeting (`product-owner`)

**Purpose:** Backlog refinement, feature discussion, requirement gathering.

**Pipeline Stages:**
1. Chunking
2. Embedding (ChromaDB)
3. Minutes generation
4. User Story extraction
5. Task assignment

**Output Files:**
| File | Location | Description |
|------|----------|-------------|
| `{id}_final.txt` | `summaries/` | Full meeting minutes |
| `{id}_stories.json` | `user_stories/` | User stories in JSON |
| `{id}_assignments.json` | `user_stories/` | Stories assigned to team members |

**Prompts Used:**
- `prompts/po_meeting/batch_summary.txt` — summarizes each transcript chunk, focusing on features, requirements, and decisions
- `prompts/po_meeting/final_minutes.txt` — combines batch summaries into structured MoM with backlog updates, decisions, and action items
- `prompts/po_meeting/user_stories.txt` — converts minutes into a clean JSON array of user stories with acceptance criteria, urgency, skill, and effort points

**User Story Schema:**
```json
{
  "id": "US-001",
  "user_story": "As a <role>, I want <feature> so that <benefit>.",
  "acceptance_criteria": ["..."],
  "urgency": "High | Medium | Low",
  "skill_required": "Frontend | Backend | Full-stack | ML | DevOps | Database | UX/UI",
  "effort_points": 1
}
```

---

### 2. Daily Standup (`daily-standup`)

**Purpose:** Quick team sync — what was done, what's being done, what's blocked.

**Pipeline Stages:**
1. Chunking
2. Embedding (ChromaDB)
3. Minutes generation
4. Blockers report extraction

**No user stories or assignments are generated for standups.**

**Output Files:**
| File | Location | Description |
|------|----------|-------------|
| `{id}_final.txt` | `summaries/` | Standup minutes (concise) |
| `{id}_blockers.json` | `standups/` | Structured team updates and blockers |

**Prompts Used:**
- `prompts/daily_standup/batch_summary.txt` — extracts per-member updates (yesterday / today / blockers) and dependencies from each transcript chunk
- `prompts/daily_standup/final_minutes.txt` — produces concise standup minutes with team updates, blockers, dependencies, and escalations
- `prompts/daily_standup/blockers_report.txt` — generates a structured JSON report from the standup minutes

**Blockers Report Schema:**
```json
{
  "total_blockers": 2,
  "team_updates": [
    {
      "member": "Alice",
      "yesterday": "Completed login API",
      "today": "Working on token refresh",
      "has_blocker": false
    }
  ],
  "blockers": [
    {
      "id": "B-001",
      "owner": "Bob",
      "description": "Waiting on DB schema approval from DBA team",
      "impact": "High",
      "blocked_task": "User profile migration",
      "dependencies": ["DBA team"],
      "suggested_resolution": "Schedule call with DBA team today",
      "status": "Open"
    }
  ],
  "action_items": [
    {
      "id": "AI-001",
      "owner": "Scrum Master",
      "action": "Escalate DB schema blocker to DBA team",
      "relates_to_blocker": "B-001"
    }
  ]
}
```

---

### 3. Retrospective (`retrospective`)

**Purpose:** Sprint retrospective — what went well, what didn't, what to improve.

**Pipeline Stages:**
1. Chunking
2. Embedding (ChromaDB)
3. Minutes generation
4. Retrospective analysis extraction

**No user stories or assignments are generated for retrospectives.**

**Output Files:**
| File | Location | Description |
|------|----------|-------------|
| `{id}_final.txt` | `summaries/` | Full retrospective minutes |
| `{id}_retro.json` | `retrospectives/` | Structured retro analysis |

**Prompts Used:**
- `prompts/retrospective/batch_summary.txt` — extracts went-well / didn't-go-well / suggestions / morale / kudos / metrics from each transcript chunk
- `prompts/retrospective/final_minutes.txt` — combines batch summaries into comprehensive retro minutes with root causes, improvement items, team health, and commitments
- `prompts/retrospective/retro_analysis.txt` — converts the minutes into a structured JSON retro analysis

**Retro Analysis Schema:**
```json
{
  "sprint": "Sprint 12",
  "went_well": [
    {
      "id": "W-001",
      "category": "Delivery",
      "description": "Shipped all planned features on time"
    }
  ],
  "didnt_go_well": [
    {
      "id": "D-001",
      "category": "Communication",
      "description": "Requirements changed late in the sprint",
      "root_cause": "PO meetings not happening early enough"
    }
  ],
  "action_items": [
    {
      "id": "RI-001",
      "description": "Schedule PO sync at sprint start",
      "owner": "Scrum Master",
      "priority": "High",
      "category": "Process",
      "timeline": "Next Sprint"
    }
  ],
  "team_health": {
    "overall_sentiment": "Mixed",
    "morale_notes": "Team feels proud of delivery but frustrated by late changes",
    "kudos": ["Alice for staying late to fix the release bug"]
  },
  "metrics_discussed": {
    "velocity": "34 points (down from 40)",
    "other": ["3 production bugs", "2 hotfixes deployed"]
  }
}
```

---

## Folder Structure

```
prompts/
├── po_meeting/
│   ├── batch_summary.txt       Feature/requirement-focused chunk summarizer
│   ├── final_minutes.txt       Full MoM with backlog, decisions, action items
│   └── user_stories.txt        JSON user story extractor
├── daily_standup/
│   ├── batch_summary.txt       Per-member update extractor
│   ├── final_minutes.txt       Concise standup minutes
│   └── blockers_report.txt     JSON blockers and action items extractor
└── retrospective/
    ├── batch_summary.txt       Went-well / didn't-go-well / sentiment extractor
    ├── final_minutes.txt       Full retro minutes with root causes
    └── retro_analysis.txt      JSON structured retro analysis extractor

summaries/          All meeting minutes (all types)
user_stories/       User stories + assignments (PO only)
standups/           Blockers reports (standup only)
retrospectives/     Retro analyses (retro only)
```

---

## Editing Prompts

All prompts are plain text files with `{placeholder}` variables:

| Placeholder | Used in | Replaced with |
|-------------|---------|---------------|
| `{transcript}` | `batch_summary.txt` | Raw formatted transcript text |
| `{combined}` | `final_minutes.txt` | All batch summaries joined |
| `{minutes}` | `user_stories.txt`, `blockers_report.txt`, `retro_analysis.txt` | Final minutes text |

To change how something is extracted or formatted, just edit the relevant `.txt` file. No code changes needed.
