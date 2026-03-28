#!/usr/bin/env python3
"""
Deploy the updated Google Apps Script via OAuth + Apps Script API.

Usage:
  python3 scripts/deploy-apps-script.py

Opens a browser-based OAuth flow, then pushes the script content.
"""

import http.server
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

SCRIPT_ID = "1GEs4XrQSocdU046GpSaLrbeFYQmRE8jG1cyvFIFeEo1cbj-9XCfJH1rQ"
CLIENT_ID = "1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com"
CLIENT_SECRET = "v6V3fKV_zWU7iw1DrpO1rknX"
REDIRECT_PORT = 8085
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}"
SCOPES = "https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/drive.file"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEPLOYED_GS = os.path.join(SCRIPT_DIR, "google-apps-script-task-push.deployed.gs")

auth_code_result = {"code": None}


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        code = params.get("code", [None])[0]
        if code:
            auth_code_result["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Authorization successful!</h2><p>You can close this tab.</p>")
        else:
            error = params.get("error", ["unknown"])[0]
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(f"<h2>Authorization failed: {error}</h2>".encode())
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, format, *args):
        pass  # Suppress request logging


def get_access_token(code: str) -> str:
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI,
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    resp = urllib.request.urlopen(req)
    token_data = json.loads(resp.read())
    return token_data["access_token"]


def get_current_content(token: str) -> dict:
    req = urllib.request.Request(
        f"https://script.googleapis.com/v1/projects/{SCRIPT_ID}/content",
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def push_content(token: str, content: dict) -> dict:
    body = json.dumps(content).encode()
    req = urllib.request.Request(
        f"https://script.googleapis.com/v1/projects/{SCRIPT_ID}/content",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def main():
    # Read the new script source
    with open(DEPLOYED_GS) as f:
        new_source = f.read()
    print(f"Read {len(new_source)} chars from {os.path.basename(DEPLOYED_GS)}")

    # Start local callback server
    server = http.server.HTTPServer(("localhost", REDIRECT_PORT), CallbackHandler)

    # Build OAuth URL
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
    })

    print(f"\nOpen this URL in your browser to authorize:\n\n{auth_url}\n")
    print("Waiting for authorization callback...")

    # Try opening browser (works on local machines)
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    server.serve_forever()

    code = auth_code_result["code"]
    if not code:
        print("ERROR: No authorization code received.")
        sys.exit(1)

    print("Authorization received. Exchanging for access token...")
    token = get_access_token(code)

    print("Fetching current script content...")
    project = get_current_content(token)
    file_names = [f["name"] for f in project.get("files", [])]
    print(f"  Files: {', '.join(file_names)}")

    # Update the Code file
    updated = False
    for f in project["files"]:
        if f["name"] == "Code":
            old_len = len(f["source"])
            f["source"] = new_source
            print(f"  Updated Code: {old_len} -> {len(new_source)} chars")
            updated = True

    if not updated:
        # Add new Code file if none exists
        project["files"].append({
            "name": "Code",
            "type": "SERVER_JS",
            "source": new_source,
        })
        print(f"  Added new Code file: {len(new_source)} chars")

    # Remove scriptId from payload (API doesn't want it in the body)
    project.pop("scriptId", None)

    print("Pushing updated script...")
    result = push_content(token, project)
    result_files = [f["name"] for f in result.get("files", [])]
    print(f"  Pushed successfully! Files: {', '.join(result_files)}")
    print("\nDone! The Apps Script project has been updated.")


if __name__ == "__main__":
    main()
