# Rebuild corpus C1 from the exact README blobs pinned by the earlier experiment.
import base64, json, subprocess, sys, datetime
OWNER = "ryoshin0830"
src = json.load(open(sys.argv[1]))["corpus_sources"]
def gh(path):
    return json.loads(subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout)
docs = []
for s in src:
    repo, sha = s["repo"], s["readme_blob_sha"]
    meta = gh(f"repos/{OWNER}/{repo}")
    assert meta["private"] is False, repo
    if sha and sha.startswith("local README at commit "):
        commit = sha.rsplit(" ", 1)[1]
        readme = subprocess.run(["git", "show", f"{commit}:README.md"], check=True, capture_output=True, text=True).stdout
        rev = f"commit:{commit}"
    elif sha:
        readme = base64.b64decode(gh(f"repos/{OWNER}/{repo}/git/blobs/{sha}")["content"]).decode()
        rev = f"blob:{sha}"
    else:
        readme, rev = "", None
    docs.append(dict(id=repo, description=meta["description"] or "", readme=readme, readme_revision=rev,
                     source_url=s["url"], visibility="public",
                     collected_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")))
    print(repo, len(readme), repr((meta["description"] or "")[:60]), file=sys.stderr)
json.dump(docs, open("data/c1_original.json", "w"), ensure_ascii=False, indent=1)
