# services/n8n_trigger.py
import requests
from typing import Dict, Any, Optional

class N8nTriggerService:
    def __init__(self, base_url: str, api_key: str, workflow_id: str):
        self.base_url = base_url.rstrip('/')
        self.workflow_id = workflow_id
        self.headers = {'Content-Type': 'application/json'}
        if api_key:
            self.headers['X-N8N-API-KEY'] = api_key

    def trigger_workflow(self, stories_data: Dict[str, Any]) -> bool:
        """
        Trigger n8n workflow with user stories.
        stories_data: the JSON object from {meeting_id}_stories.json
        Returns True if successful, False otherwise.
        """
        # Convert the stories dict to a JSON string (matching your triggern8n.py)
        stories_json_str = json.dumps(stories_data, ensure_ascii=False, indent=2)
        payload = {"userStories": stories_json_str}

        # Try webhook first (auto-detection), then fallback to /run API
        return self._trigger_webhook_or_run(payload)

    def _trigger_webhook_or_run(self, payload: dict) -> bool:
        # First, try to get workflow info to detect webhook node
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

        # Fallback to /run API
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
            else:
                print(f"⚠️ n8n webhook returned {resp.status_code}")
                return False
        except Exception as e:
            print(f"⚠️ n8n webhook call failed: {e}")
            return False

    def _call_run_api(self, payload: dict) -> bool:
        url = f"{self.base_url}/api/v1/workflows/{self.workflow_id}/run"
        run_payload = {"inputData": payload.get("userStories", "")}  # adjust as needed
        try:
            resp = requests.post(url, headers=self.headers, json=run_payload, timeout=30)
            if 200 <= resp.status_code < 300:
                print("✅ n8n workflow triggered via /run API")
                return True
            else:
                print(f"⚠️ n8n /run returned {resp.status_code}")
                return False
        except Exception as e:
            print(f"⚠️ n8n /run failed: {e}")
            return False