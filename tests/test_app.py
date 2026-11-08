"""Integration checks against real Git repositories. Run: python -m unittest discover -s tests -v"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="git-atlas-test-")
        self.base = Path(self.temp.name)
        self.repo = self.base / "中文 repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "测试作者")
        self.git("config", "user.email", "author@example.test")
        self.counter = 0

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, env=None):
        result = subprocess.run(["git", "-C", str(self.repo), *args], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, creationflags=app.CREATE_NO_WINDOW)
        if result.returncode:
            self.fail(result.stderr.decode("utf-8", "replace"))
        return result.stdout.decode("utf-8", "replace").strip()

    def commit(self, message):
        self.counter += 1
        env = app.git_env()
        env.update(GIT_AUTHOR_DATE=f"2025-01-{self.counter:02}T23:30:00+0800",
                   GIT_COMMITTER_DATE=f"2025-01-{self.counter:02}T23:30:00+0800")
        self.git("add", "--all")
        self.git("commit", "-m", message, env=env)
        return self.git("rev-parse", "HEAD")

    def history(self):
        (self.repo / "你好.py").write_text("one\ntwo\nthree\n", "utf-8")
        self.initial = self.commit("feat: 第一行 <script>alert(1)</script>")
        self.git("checkout", "-b", "feature/中文")
        (self.repo / "side.ts").write_text("a\nb\n", "utf-8")
        self.side = self.commit("feat: side branch")
        self.git("checkout", "main")
        (self.repo / "你好.py").write_text("one\nthree\n", "utf-8")
        (self.repo / "image.bin").write_bytes(b"\x00binary\xff\x00")
        self.edit = self.commit("fix: remove a line")
        self.counter += 1
        env = app.git_env()
        env.update(GIT_AUTHOR_DATE="2025-01-04T23:30:00+0800", GIT_COMMITTER_DATE="2025-01-04T23:30:00+0800")
        self.git("merge", "--no-ff", "feature/中文", "-m", "merge feature", env=env)
        self.merge = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "unmerged")
        (self.repo / "未合并.md").write_text("another\n", "utf-8")
        self.unmerged = self.commit("unmerged branch")
        self.git("checkout", "main")
        self.git("tag", "tag-only", self.unmerged)
        self.git("branch", "-D", "unmerged")
        self.git("branch", "unmerged", self.unmerged)

    def import_branch(self, branch="refs/heads/main", mainline=False):
        repo = app.describe_repository(str(self.repo))
        tips = [b["sha"] for b in repo["branches"]] if branch == "__all__" else [b["sha"] for b in repo["branches"] if b["ref"] == branch and b["sha"]]
        db = self.base / f"{hashlib.sha1((branch+str(mainline)).encode()).hexdigest()}.sqlite3"
        progress = []
        app.import_history(repo, tips, mainline, db, lambda **kw: progress.append(kw))
        return repo, db

    def test_branch_merge_statistics_and_all_branch_dedup(self):
        self.history()
        repo, db = self.import_branch()
        data = app.analytics(db, {})
        self.assertEqual(data["summary"]["commits"], 4)
        self.assertEqual(data["summary"]["additions"], 5)
        self.assertEqual(data["summary"]["deletions"], 1)
        self.assertEqual(data["summary"]["net"], 4)
        self.assertEqual(data["summary"]["merges"], 1)
        self.assertEqual(data["summary"]["binary"], 1)
        self.assertEqual(data["summary"]["longestStreak"], 4)
        self.assertEqual(data["recent"][0]["date"], "2025-01-04T23:30:00+08:00")
        _, all_db = self.import_branch("__all__")
        all_data = app.analytics(all_db, {})
        self.assertEqual(all_data["summary"]["commits"], 5)
        self.assertEqual(all_data["summary"]["additions"], 6)
        _, first_db = self.import_branch(mainline=True)
        first = app.analytics(first_db, {})
        self.assertEqual(first["summary"]["commits"], 3)
        self.assertEqual(first["summary"]["additions"], 5)
        self.assertEqual(first["summary"]["deletions"], 1)
        detail = app.commit_detail(repo, self.merge, first_db, True)
        self.assertEqual(detail["changedFiles"][0]["path"], "side.ts")

    def test_filters_paging_and_commit_details(self):
        self.history()
        repo, db = self.import_branch()
        result = app.analytics(db, {"from":"2025-01-02", "to":"2025-01-03"})
        self.assertEqual(result["summary"]["commits"], 2)
        self.assertEqual(result["summary"]["net"], 1)
        self.assertEqual(app.analytics(db, {"q":"<script>"})["summary"]["commits"], 1)
        self.assertEqual(app.analytics(db, {"q":"%"})["summary"]["commits"], 0)
        self.assertEqual(app.analytics(db, {"author":"missing@example.test"})["summary"]["commits"], 0)
        page = app.commit_page(db, {"order":"asc", "offset":"1", "limit":"1"})
        self.assertEqual(page["total"], 4)
        self.assertEqual(page["commits"][0]["hash"], self.side)
        detail = app.commit_detail(repo, self.edit, db, False)
        self.assertEqual(len(detail["changedFiles"]), 2)
        self.assertEqual(sum(f["binary"] for f in detail["changedFiles"]), 1)
        self.assertIn("你好.py", [f["path"] for f in detail["changedFiles"]])
        self.assertEqual(app.commit_detail(repo, self.merge, db, False)["changedFiles"], [])
        with self.assertRaises(app.AppError):
            app.analytics(db, {"from":"2025-02-03", "to":"2025-01-01"})

    def test_paths_worktree_bare_and_empty(self):
        root = app.describe_repository(str(self.repo))
        directory = app.describe_repository(str(self.repo / ".git"))
        self.assertEqual(root["gitDir"], directory["gitDir"])
        _, empty = self.import_branch()
        self.assertEqual(app.analytics(empty, {})["summary"]["commits"], 0)
        (self.repo / "a.py").write_text("a\n")
        self.commit("initial")
        worktree = self.base / "linked tree"
        self.git("worktree", "add", "-b", "linked", str(worktree))
        linked = app.describe_repository(str(worktree / ".git"))
        self.assertTrue(linked["defaultBranch"].endswith("/linked"))
        bare = self.base / "bare.git"
        self.git("clone", "--bare", str(self.repo), str(bare))
        self.assertTrue(app.describe_repository(str(bare))["bare"])
        with self.assertRaises(app.AppError):
            app.describe_repository(str(self.base))

    def test_rename_and_tab_filename(self):
        # Tabs/newlines are valid on POSIX; Windows fixture covers Unicode and rename.
        filename = "含空格 name.py" if os.name == "nt" else "含\t制表\n符.py"
        (self.repo / filename).write_text("a\nb\n", "utf-8")
        self.commit("initial")
        self.git("mv", filename, "renamed.py")
        sha = self.commit("rename")
        repo, db = self.import_branch()
        summary = app.analytics(db, {})["summary"]
        self.assertEqual((summary["additions"], summary["deletions"]), (4,2))
        self.assertEqual(len(app.commit_detail(repo, sha, db, False)["changedFiles"]), 2)

    def test_nul_parser_handles_control_characters(self):
        data = b"\0GIT_ATLAS_COMMIT\0" + b"a"*40 + b"\0\0Person\0p@x\0" + b"1735745400" + b"\0" + b"2025-01-01T23:30:00+08:00\0subject\0\0\n2\t1\ta\tb\nc.py\0"
        rows = list(app.parse_history(io.BytesIO(data)))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["languages"], {"Python":[2,1,1]})
        self.assertEqual(rows[0]["hour"], 23)
        sentinel_subject = data.replace(b"Person", b"GIT_ATLAS_COMMIT").replace(b"subject", b"GIT_ATLAS_COMMIT")
        class TinyChunks(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size,3))
        parsed = list(app.parse_history(TinyChunks(sentinel_subject)))
        self.assertEqual(parsed[0]["subject"], "GIT_ATLAS_COMMIT")
        self.assertEqual(parsed[0]["author"], "GIT_ATLAS_COMMIT")

    def test_cache_path_with_reserved_uri_characters(self):
        (self.repo / "a.py").write_text("a\n")
        self.commit("initial")
        _, db = self.import_branch()
        renamed = self.base / "缓存 # percent%.sqlite3"
        db.rename(renamed)
        self.assertEqual(app.analytics(renamed, {})["summary"]["commits"],1)

    def test_cache_invalidation_and_no_repository_changes(self):
        self.history()
        before = self.git("status", "--porcelain=v1")
        head_before = self.git("rev-parse", "HEAD")
        application = app.Application(self.base / "cache")
        try:
            repo = application.open(str(self.repo / ".git"))
            job = application.scan(repo["id"], "refs/heads/main")
            for _ in range(200):
                job = application.get_job(job["id"])
                if job["status"] != "loading": break
                time.sleep(.02)
            self.assertEqual(job["status"], "ready", job.get("error"))
            repeat = application.scan(repo["id"], "refs/heads/main")
            self.assertEqual(repeat["id"],job["id"])
            self.assertTrue(repeat["cached"])
            old_path = job["db"]
            refreshed = application.scan(repo["id"], "refs/heads/main", refresh=True)
            for _ in range(200):
                refreshed_job = application.get_job(refreshed["id"])
                if refreshed_job["status"] != "loading": break
                time.sleep(.02)
            self.assertEqual(refreshed_job["status"], "ready", refreshed_job.get("error"))
            self.assertNotEqual(old_path, refreshed_job["db"])
            self.assertTrue(Path(old_path).exists())
            reopened = app.Application(self.base / "cache")
            reopened_repo = reopened.open(str(self.repo))
            from_disk = reopened.scan(reopened_repo["id"], "refs/heads/main")
            self.assertEqual(from_disk["status"], "ready")
            self.assertTrue(from_disk["cached"])
            reopened.pool.shutdown(wait=True)
            self.assertEqual(self.git("status", "--porcelain=v1"), before)
            self.assertEqual(self.git("rev-parse", "HEAD"),head_before)
            (self.repo / "new.txt").write_text("new\n")
            self.commit("after cache")
            fresh = application.scan(repo["id"], "refs/heads/main")
            self.assertNotEqual(fresh["id"],job["id"])
        finally:
            application.pool.shutdown(wait=True)

    def test_http_session_boundaries_and_export(self):
        (self.repo / "a.py").write_text("a\n")
        self.commit("=malicious formula")
        application = app.Application(self.base / "cache")
        server = app.ThreadingHTTPServer(("127.0.0.1",0),app.Handler)
        server.application = application
        thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        def request(path, body=None, headers=None):
            return urlopen(Request(url+path,data=json.dumps(body).encode() if body is not None else None,
                                   headers={"X-Git-Atlas":application.token,**(headers or {})}),timeout=10)
        try:
            html = urlopen(url).read().decode()
            self.assertIn(application.token,html)
            with self.assertRaises(HTTPError) as missing_token:
                urlopen(url+"/api/session")
            self.assertEqual(missing_token.exception.code,403)
            missing_token.exception.close()
            with self.assertRaises(HTTPError) as bad_host:
                request("/api/session",headers={"Host":"attacker.example"})
            self.assertEqual(bad_host.exception.code,403)
            bad_host.exception.close()
            repo = json.load(request("/api/open",{"path":str(self.repo)}))
            job = json.load(request("/api/scan",{"repo":repo["id"],"branch":"refs/heads/main"}))
            for _ in range(100):
                job = json.load(request("/api/jobs/"+job["id"]))
                if job["status"] != "loading": break
                time.sleep(.02)
            csv = request("/api/export?job="+job["id"]).read().decode("utf-8-sig")
            self.assertIn("'=malicious formula",csv)
            self.assertIn("author@example.test",csv)
        finally:
            server.shutdown();server.server_close();thread.join();application.pool.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
