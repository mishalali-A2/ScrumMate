import requests
import json
from datetime import date

# ========== CONFIGURATION ==========
N8N_BASE_URL = "http://localhost:5678"          # Change to your n8n instance URL
WEBHOOK_PATH = "/webhook/daily_standup"                  # As defined in your workflow node
API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YTA4ZTkxNi04YWIyLTQ1ZTQtYTQxYy03MWJiMzI0MzgxNTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzY1MjM0NjAzfQ.hJPE1Shr5HgJOyM-9QybTLmWIcq2wUhTMxCYvx3US3o"  # optional for webhook, required for /run

# ========== SAMPLE PAYLOAD ==========
# Based on your "Task Tracker App Development" project and user stories
payload = {
    "project_name": "Task Tracker App Development",
    "meeting_minutes": (
        "**Team updates:**\n"
        "- Alex: Completed US-001 (User signup/login) and US-002 (Create task). "
        "Started US-003 (Dashboard listing). No blockers.\n"
        "- Jamie: Worked on US-004 (Deadline field) but waiting for design approval. "
        "US-005 (Edit task) is 50% done.\n"
        "- Taylor: Finished US-006 (Mark complete) and US-007 (Delete task). "
        "US-008 (Pending/Completed sections) is behind schedule because of API changes.\n\n"
        "**Blockers:**\n"
        "- US-004 blocked by design review\n"
        "- US-008 delayed by backend API refactor"
    ),
    "blockers": [
        "Design review pending for date picker (US-004)",
        "Backend API refactor affecting task status grouping (US-008)"
    ],
    "report_date": date.today().isoformat()
}

# ========== SEND REQUEST ==========
url = f"{N8N_BASE_URL.rstrip('/')}/{WEBHOOK_PATH.lstrip('/')}"
headers = {"Content-Type": "application/json"}
if API_KEY:
    headers["X-N8N-API-KEY"] = API_KEY

print(f"🚀 Triggering daily standup workflow at {url}")
try:
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code in (200, 201, 202):
        print("✅ Workflow triggered successfully!")
        print(f"   Response: {response.text[:200]}")
    else:
        print(f"❌ Failed with status {response.status_code}")
        print(f"   Response: {response.text}")
except Exception as e:
    print(f"❌ Request error: {e}")