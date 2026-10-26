# Build the issues corpus: the 26 pinned repos of data/c1_original.json plus every owned repo with an issue.
# Output holds private-repo text, so it goes to the cache (0600), never to git. No repo names in this file.
import base64, datetime, hashlib, json, os, subprocess
from common import ISSUES as OUT

OWNER = "ryoshin0830"


def gh(*args):
    return subprocess.run(["gh", "api", *args], check=True, capture_output=True, text=True).stdout


def gh_json(path):
    return json.loads(gh(path))


def pages(path):
    out = gh("--paginate", "--slurp", path)
    return [x for page in json.loads(out) for x in (page["items"] if isinstance(page, dict) else page)]


def readme(repo):
    try:
        r = gh_json(f"repos/{OWNER}/{repo}/readme")
    except subprocess.CalledProcessError:
        return "", None
    return base64.b64decode(r["content"]).decode(errors="replace"), f"blob:{r['sha']}"


pinned = {d["id"]: d for d in json.load(open("data/c1_original.json"))}
with_issues = {i["repository_url"].rsplit("/", 1)[1]
               for i in pages(f"search/issues?q=user:{OWNER}+is:issue&per_page=100")}
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
docs = []
for repo in sorted(set(pinned) | with_issues):
    meta = gh_json(f"repos/{OWNER}/{repo}")
    if repo in pinned:
        desc, text, rev = pinned[repo]["description"], pinned[repo]["readme"], pinned[repo]["readme_revision"]
    else:
        desc = meta["description"] or ""
        text, rev = readme(repo)
    issues = [dict(number=i["number"], state=i["state"], title=i["title"], body=i["body"] or "")
              for i in pages(f"repos/{OWNER}/{repo}/issues?state=all&per_page=100") if "pull_request" not in i]
    docs.append(dict(id=repo, private=meta["private"], description=desc, readme=text, readme_revision=rev,
                     issues=issues, collected_at=now))

OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(OUT, 0o700)
p = OUT / "corpus.json"
p.write_text(json.dumps(docs, ensure_ascii=False, indent=1))
os.chmod(p, 0o600)
(OUT / "manifest.json").write_text(json.dumps({"corpus.json": hashlib.sha256(p.read_bytes()).hexdigest()}))
print(json.dumps(dict(repos=len(docs), private=sum(d["private"] for d in docs),
                      with_issues=sum(bool(d["issues"]) for d in docs),
                      issues=sum(len(d["issues"]) for d in docs))))
