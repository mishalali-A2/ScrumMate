import requests
import sys

def close_project(project_identifier, n8n_url="http://localhost:5678"):
    """
    Trigger the close-project workflow.
    project_identifier can be an integer (project_id) or string (project_name).
    """
    webhook_url = f"{n8n_url.rstrip('/')}/webhook/close_project"
    
    if isinstance(project_identifier, int):
        payload = {"project_id": project_identifier}
    else:
        payload = {"project_name": project_identifier}
    
    headers = {"Content-Type": "application/json"}
    
    print(f"🚀 Closing project: {project_identifier}")
    try:
        resp = requests.post(webhook_url, json=payload, headers=headers, timeout=60)
        if resp.status_code in (200, 201, 202):
            print("✅ Workflow executed successfully!")
            print("Response:", resp.json())
        else:
            print(f"❌ Failed with status {resp.status_code}")
            print(resp.text)
    except Exception as e:
        print(f"❌ Request error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python trigger_close_project.py <project_id_or_name>")
        print("Example: python trigger_close_project.py 'Task Tracker App Development'")
        print("Example: python trigger_close_project.py 2")
        sys.exit(1)
    
    identifier = sys.argv[1]
    # Try to convert to int if possible
    try:
        identifier = int(identifier)
    except ValueError:
        pass  # keep as string
    
    close_project(identifier)