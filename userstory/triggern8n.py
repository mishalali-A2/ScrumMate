import requests
import json

class N8NWorkflowManager:
    def __init__(self, n8n_base_url, api_key=None):
        self.base_url = n8n_base_url.rstrip('/')
        self.headers = {'Content-Type': 'application/json'}
        if api_key:
            self.headers['X-N8N-API-KEY'] = api_key

    def get_workflow_info(self, workflow_id):
        url = f"{self.base_url}/api/v1/workflows/{workflow_id}"
        try:
            r = requests.get(url, headers=self.headers, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print("❌ Failed to fetch workflow info:", e)
            return None

    def _normalize_webhook_path_and_method(self, node):
        """
        Return (webhook_url_path, http_method)
        - node: the webhook node object from workflow['nodes'][...]['parameters']
        """
        params = node.get("parameters", {}) or {}
        # possible keys where the path may be stored in different versions
        raw_path = params.get("path") or params.get("webhookPath") or params.get("pathValue") or ""
        raw_path = str(raw_path).strip()

        # Determine method
        method = params.get("httpMethod") or params.get("method") or params.get("http_method") or ""
        # some node configs store method as list or dict - normalize
        if isinstance(method, (list, tuple)) and method:
            method = method[0]
        method = str(method).upper() if method else "POST"

        # Build normalized path:
        # If path already starts with '/', keep it.
        # If it already contains 'webhook' (like 'webhook-test/...'), just add leading slash.
        # Otherwise, prepend '/webhook/'.
        if not raw_path:
            # fallback: sometimes the path is under node['webhookId'] or node['name']; fallback to '/'
            norm = "/webhook"
        elif raw_path.startswith("/"):
            norm = raw_path
        elif "webhook" in raw_path.lower():
            norm = "/" + raw_path
        else:
            norm = "/webhook/" + raw_path

        return norm, method

    def trigger_workflow_auto(self, workflow_id, data=None):
        """
        Auto-detect webhook path or fallback to /run
        """
        info = self.get_workflow_info(workflow_id)
        if not info:
            print("💥 Cannot detect workflow type.")
            return False

        nodes = info.get("nodes") or info.get("workflow", {}).get("nodes", []) or []
        # find webhook node by type (robust)
        webhook_node = None
        for n in nodes:
            t = n.get("type", "") or ""
            if "webhook" in t.lower() or n.get("typeName", "").lower() == "webhook":
                webhook_node = n
                break

        if webhook_node:
            path, method = self._normalize_webhook_path_and_method(webhook_node)
            full_url = self.base_url + path
            print(f"ℹ Workflow uses webhook. Calling {method} {full_url}")
            try:
                if method == "GET":
                    # send as query param; small payloads only
                    resp = requests.get(full_url, params=data or {}, timeout=30)
                else:  # POST/PUT/etc -> use POST for webhook
                    resp = requests.post(full_url, json=data or {}, timeout=30)
                if 200 <= resp.status_code < 300:
                    print("✅ Workflow executed via webhook!")
                    return True
                else:
                    print(f"❌ Webhook call failed: {resp.status_code} - {resp.text}")
                    return False
            except Exception as e:
                print("❌ Error calling webhook:", e)
                return False
        else:
            # No webhook node found -> attempt /run using API key header (must be provided)
            print("ℹ No webhook node found; attempting /run API (requires API key).")
            run_url = f"{self.base_url}/api/v1/workflows/{workflow_id}/run"
            payload = {"inputData": data or []}
            try:
                resp = requests.post(run_url, headers=self.headers, json=payload, timeout=30)
                if 200 <= resp.status_code < 300:
                    print("✅ Workflow executed via /run API!")
                    return True
                else:
                    print(f"❌ /run call failed: {resp.status_code} - {resp.text}")
                    return False
            except Exception as e:
                print("❌ Error calling /run:", e)
                return False


# Example usage
if __name__ == "__main__":
    N8N_BASE_URL = "http://localhost:5678"
    API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YTA4ZTkxNi04YWIyLTQ1ZTQtYTQxYy03MWJiMzI0MzgxNTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzY1MjM0NjAzfQ.hJPE1Shr5HgJOyM-9QybTLmWIcq2wUhTMxCYvx3US3o"  # optional for webhook, required for /run
    WORKFLOW_ID = "JgL4ipoMjAxDsZMJ"

        # Read user stories from stories.txt
    file_path = "stories.txt"
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            user_stories = f.read().strip()  # reads entire file as a single string
        if not user_stories:
            print(f"❌ {file_path} is empty")
            user_stories = ""
    except FileNotFoundError:
        print(f"❌ {file_path} not found")
        user_stories = ""
    except Exception as e:
        print(f"❌ Error reading {file_path}: {e}")
        user_stories = ""

    # Your payload now contains the entire file as a string
    payload = {
        "userStories": user_stories
    }

    manager = N8NWorkflowManager(N8N_BASE_URL, API_KEY)
    success = manager.trigger_workflow_auto(WORKFLOW_ID, data=payload)

    if success:
        print("\n🎉 Workflow executed successfully!")
    else:
        print("\n💥 Workflow execution failed.")
