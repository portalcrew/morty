"""Enforce reviewed CodeQL results for this exact PR or merge-group revision."""
import json
import os
import subprocess


def pages(endpoint, **parameters):
    command = ["gh", "api", "--method", "GET", "--paginate", "--slurp", endpoint]
    for key, value in parameters.items():
        command.extend(["-f", f"{key}={value}"])
    response = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
    return [item for page in json.loads(response.stdout) for item in page]


repository = os.environ["GITHUB_REPOSITORY"]
reference = os.environ["GITHUB_REF"]
revision = os.environ["GITHUB_SHA"]
category = os.environ["CODEQL_CATEGORY"]
sarif_id = os.environ["CODEQL_SARIF_ID"]
if not sarif_id:
    raise SystemExit("CodeQL did not return an upload ID")

# Bind the gate to the upload that just finished; an old green scan or an empty
# alert list after an upload failure must never satisfy the required check.
analyses = pages(f"repos/{repository}/code-scanning/analyses", sarif_id=sarif_id, per_page="100")
if len(analyses) != 1 or any(
    analysis["commit_sha"] != revision
    or analysis["ref"] != reference
    or analysis["category"] != category
    or analysis["tool"]["name"] != "CodeQL"
    or analysis["error"]
    for analysis in analyses
):
    raise SystemExit("Missing or mismatched CodeQL analysis for this revision")

# GitHub owns alert identity and dismissal reasons. Reading the processed alert
# state preserves reviewed false positives across PRs and merge queue branches.
alerts = pages(
    f"repos/{repository}/code-scanning/alerts",
    ref=reference,
    tool_name="CodeQL",
    state="open",
    per_page="100",
)
blocking = []
for alert in alerts:
    instance = alert["most_recent_instance"]
    if instance["category"] != category or instance["state"] != "open":
        continue
    if instance["commit_sha"] != revision:
        raise SystemExit("CodeQL alert results are stale for this revision")
    if alert["rule"]["security_severity_level"] in ("high", "critical"):
        blocking.append(alert)

for alert in blocking:
    print(f'Blocking {alert["rule"]["security_severity_level"]} alert: {alert["html_url"]}', flush=True)
if blocking:
    raise SystemExit(f"{len(blocking)} unresolved high/critical CodeQL alerts")
print(f"CodeQL high/critical gate passed for {category} at {revision}")
