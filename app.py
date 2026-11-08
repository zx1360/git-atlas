#!/usr/bin/env python3
"""Git Atlas: a dependency-free, read-only, local Git history explorer."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import random
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from contextlib import closing
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE_VERSION = "6"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LANGUAGES = {
    ".py": "Python", ".pyw": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".html": "HTML", ".vue": "Vue",
    ".svelte": "Svelte", ".css": "CSS", ".scss": "CSS", ".sass": "CSS", ".less": "CSS", ".rs": "Rust",
    ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".c": "C / C++", ".cpp": "C / C++",
    ".h": "C / C++", ".hpp": "C / C++", ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".dart": "Dart",
    ".md": "Markdown", ".mdx": "Markdown", ".rst": "Documentation", ".txt": "Text", ".json": "JSON",
    ".yml": "YAML", ".yaml": "YAML", ".toml": "Configuration", ".ini": "Configuration", ".xml": "XML",
    ".sh": "Shell", ".ps1": "Shell", ".bat": "Shell", ".sql": "SQL", ".ipynb": "Jupyter", ".svg": "SVG",
    ".lock": "Lockfile", ".sum": "Lockfile", ".mod": "Configuration", ".ex": "Elixir", ".exs": "Elixir",
    ".r": "R", ".jl": "Julia", ".lua": "Lua", ".zig": "Zig", ".scala": "Scala", ".clj": "Clojure",
}


class AppError(Exception):
    pass


def git_env():
    # Ignore inherited repository selection, optional write locks, pagers and lazy network fetches.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", LC_ALL="C.UTF-8")
    return env


def git_command(git_dir, args):
    return ["git", "--no-pager", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false",
            "-c", "color.ui=false", "-c", "protocol.allow=never", "-c", "i18n.logOutputEncoding=utf-8", f"--git-dir={git_dir}", *args]


def run_git(git_dir, args, *, input_data=None, timeout=60, check=True):
    try:
        result = subprocess.run(git_command(git_dir, args), input=input_data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=git_env(), timeout=timeout,
                                creationflags=CREATE_NO_WINDOW)
    except FileNotFoundError as exc:
        raise AppError("未找到 Git。请先安装 Git，并确认 git 在 PATH 中。") from exc
    except subprocess.TimeoutExpired as exc:
        raise AppError("Git 操作超时，请稍后重试。") from exc
    if check and result.returncode:
        reason = result.stderr.decode("utf-8", "replace").strip()[:1200]
        raise AppError(f"Git 无法读取该仓库：{reason}")
    return result


def describe_repository(path):
    path = Path(str(path).strip().strip('"')).expanduser()
    if not path.exists():
        raise AppError("路径不存在。请选择仓库根目录、.git 目录或 worktree 的 .git 文件。")
    candidate = path / ".git" if path.is_dir() and (path / ".git").exists() else path
    try:
        result = subprocess.run(["git", "rev-parse", "--resolve-git-dir", str(candidate.resolve())],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_env(),
                                timeout=20, creationflags=CREATE_NO_WINDOW)
    except FileNotFoundError as exc:
        raise AppError("未找到 Git，请安装 Git 并加入 PATH。") from exc
    if result.returncode:
        raise AppError("这个路径不是有效的 Git 仓库。请选择仓库根目录、.git 目录或 .git 文件。")
    git_dir = str(Path(result.stdout.decode("utf-8", "replace").strip()).resolve())
    bare = run_git(git_dir, ["rev-parse", "--is-bare-repository"]).stdout.strip() == b"true"
    shallow = run_git(git_dir, ["rev-parse", "--is-shallow-repository"]).stdout.strip() == b"true"
    shallow_fingerprint = ""
    if shallow:
        shallow_path = run_git(git_dir, ["rev-parse", "--git-path", "shallow"]).stdout.decode("utf-8", "replace").strip()
        shallow_fingerprint = hashlib.sha256(Path(shallow_path).read_bytes()).hexdigest()
    head_result = run_git(git_dir, ["rev-parse", "--verify", "HEAD"], check=False)
    head = head_result.stdout.decode().strip() if head_result.returncode == 0 else ""
    current_result = run_git(git_dir, ["symbolic-ref", "--quiet", "HEAD"], check=False)
    current = current_result.stdout.decode("utf-8", "replace").strip()
    refs = run_git(git_dir, ["for-each-ref", "--sort=refname",
                           "--format=%(refname)%09%(objectname)%09%(symref)", "refs/heads/", "refs/remotes/"]).stdout
    branches = []
    for line in refs.decode("utf-8", "replace").splitlines():
        ref, sha, symref = line.split("\t")
        if symref:
            continue
        remote = ref.startswith("refs/remotes/")
        branches.append({"ref": ref, "name": ref.removeprefix("refs/remotes/" if remote else "refs/heads/"),
                         "sha": sha, "remote": remote, "current": ref == current})
    if not current and head:
        branches.insert(0, {"ref": "HEAD", "name": "HEAD · 游离", "sha": head, "remote": False, "current": True})
    if not branches:
        branches = [{"ref": "HEAD", "name": current.removeprefix("refs/heads/") or "main", "sha": head,
                     "remote": False, "current": True}]
    name = path.name
    if path.name == ".git":
        name = path.parent.name
    return {"id": hashlib.sha256(git_dir.encode()).hexdigest()[:20], "name": name or "repository",
            "path": str(path.resolve()), "gitDir": git_dir, "branches": branches,
            "defaultBranch": current if any(b["ref"] == current for b in branches) else branches[0]["ref"],
            "head": head, "bare": bare, "shallow": shallow, "shallowFingerprint": shallow_fingerprint, "demo": False}


SCHEMA = """
CREATE TABLE commits (
 hash TEXT PRIMARY KEY, parents TEXT, author TEXT, email TEXT, timestamp INTEGER,
 date TEXT, day TEXT, hour INTEGER, weekday INTEGER, subject TEXT,
 additions INTEGER, deletions INTEGER, files INTEGER, binary INTEGER, is_merge INTEGER
);
CREATE TABLE languages (hash TEXT, language TEXT, additions INTEGER, deletions INTEGER, files INTEGER);
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
"""
INDEXES = """
CREATE INDEX idx_commits_day ON commits(day, timestamp);
CREATE INDEX idx_commits_time ON commits(timestamp DESC, hash);
CREATE INDEX idx_commits_author ON commits(email, day);
CREATE INDEX idx_languages_hash ON languages(hash);
"""


def connect_db(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA mmap_size=268435456")
    conn.execute("PRAGMA cache_size=-8192")
    return conn


def prepare_db(path):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.executescript(SCHEMA)
    return conn


def tokens_from_stream(stream):
    pending = b""
    while block := stream.read(128 * 1024):
        parts = (pending + block).split(b"\0")
        pending = parts.pop()
        yield from parts
    if pending:
        yield pending


def parse_history(stream):
    """NUL-framed metadata and numstat; no-renames makes paths a single opaque token."""
    fields = None
    current = None
    for token in tokens_from_stream(stream):
        if token == b"GIT_ATLAS_COMMIT" and fields is None:
            if current:
                yield current
            fields, current = [], None
        elif fields is not None:
            fields.append(token.decode("utf-8", "replace"))
            if len(fields) == 7:
                sha, parents, author, email, timestamp, iso_date, subject = fields
                day = iso_date[:10]
                try:
                    parsed_day = date.fromisoformat(day)
                    hour = int(iso_date[11:13])
                except (ValueError, IndexError):
                    parsed_day, hour = date(1970, 1, 1), 0
                    day = parsed_day.isoformat()
                current = {"hash": sha, "parents": parents, "author": author, "email": email,
                           "timestamp": int(timestamp), "date": iso_date, "day": day, "hour": hour,
                           "weekday": parsed_day.weekday(), "subject": subject[:2000], "additions": 0,
                           "deletions": 0, "files": 0, "binary": 0, "is_merge": int(" " in parents), "languages": {}}
                fields = None
        elif current:
            record = token.lstrip(b"\r\n").split(b"\t", 2)
            if len(record) != 3:
                continue
            added, removed, filename = record
            if not (added.isdigit() or added == b"-") or not (removed.isdigit() or removed == b"-"):
                continue
            binary = added == b"-"
            a, d = (0, 0) if binary else (int(added), int(removed))
            current["additions"] += a
            current["deletions"] += d
            current["files"] += 1
            current["binary"] += int(binary)
            decoded = filename.decode("utf-8", "replace")
            suffix = Path(decoded).suffix.lower()
            language = LANGUAGES.get(suffix, "Other")
            if Path(decoded).name in {"Dockerfile", "Containerfile"}:
                language = "Docker"
            values = current["languages"].setdefault(language, [0, 0, 0])
            values[0] += a
            values[1] += d
            values[2] += 1
    if current:
        yield current


def insert_commit(conn, commit):
    keys = ("hash", "parents", "author", "email", "timestamp", "date", "day", "hour", "weekday", "subject",
            "additions", "deletions", "files", "binary", "is_merge")
    conn.execute("INSERT INTO commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", tuple(commit[k] for k in keys))
    conn.executemany("INSERT INTO languages VALUES (?,?,?,?,?)",
                     [(commit["hash"], language, *values) for language, values in commit["languages"].items()])


def import_history(repo, tips, mainline, db_path, progress):
    conn = prepare_db(db_path)
    process = None
    try:
        if tips:
            revisions = ("\n".join(tips) + "\n").encode()
            count_args = ["rev-list", "--count", *(["--first-parent"] if mainline else []), "--stdin"]
            total = int(run_git(repo["gitDir"], count_args, input_data=revisions, timeout=180).stdout.strip() or b"0")
            progress(total=total, stage="正在读取提交与文件变更")
            args = ["log", "--stdin", "--topo-order", "--root", "--numstat", "-z", "--no-renames",
                    "--no-ext-diff", "--no-textconv", "--encoding=UTF-8",
                    "--format=%x00GIT_ATLAS_COMMIT%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%aI%x00%s%x00"]
            args += ["--first-parent", "--diff-merges=first-parent"] if mainline else ["--no-diff-merges"]
            # A temporary file prevents stderr pipe deadlocks even on damaged repositories.
            import tempfile
            with tempfile.TemporaryFile() as errors:
                process = subprocess.Popen(git_command(repo["gitDir"], args), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=errors, env=git_env(),
                                           creationflags=CREATE_NO_WINDOW)
                process.stdin.write(revisions)
                process.stdin.close()
                for count, commit in enumerate(parse_history(process.stdout), 1):
                    insert_commit(conn, commit)
                    if count % 250 == 0:
                        conn.commit()
                        progress(processed=count)
                process.stdout.close()
                code = process.wait()
                if code:
                    errors.seek(0)
                    raise AppError("读取历史失败：" + errors.read(2000).decode("utf-8", "replace"))
        progress(stage="正在建立索引", processed=conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0])
        conn.executescript(INDEXES)
        conn.execute("ANALYZE")
        conn.execute("INSERT INTO metadata VALUES ('version', ?)", (CACHE_VERSION,))
        conn.commit()
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        conn.close()


DEMO_AUTHORS = [("Lin", "lin@example.test"), ("小雨", "xiaoyu@example.test"),
                ("Alex Chen", "alex@example.test"), ("Mia", "mia@example.test")]
DEMO_MESSAGES = ["feat: 让画布拥有无限可能", "fix: 修复时间轴边界计算", "refactor: 简化数据流与状态管理",
                 "feat: 新增项目工作台", "perf: 优化大数据渲染性能", "style: 调整卡片间距与视觉层次",
                 "docs: 记录设计思路与使用方式", "feat: 添加快捷搜索与命令菜单", "test: 覆盖核心交互场景",
                 "fix: 改善窗口缩放时的布局", "feat: 完成第一个可用版本", "chore: 更新项目配置",
                 "feat: 把想法变成可以触摸的界面", "perf: 缓存计算结果，减少重复请求"]


def demo_repository():
    return {"id": "demo", "name": "orbit-workspace", "path": "一个关于想法逐渐成形的演示仓库",
            "gitDir": "", "head": "demo", "demo": True, "bare": False, "shallow": False,
            "defaultBranch": "refs/heads/main", "branches": [
                {"ref": "refs/heads/main", "name": "main", "sha": "demo-main", "current": True, "remote": False},
                {"ref": "refs/heads/develop", "name": "develop", "sha": "demo-develop", "current": False, "remote": False},
                {"ref": "refs/heads/feat/canvas", "name": "feat/canvas", "sha": "demo-canvas", "current": False, "remote": False}]}


def import_demo(branch, mainline, db_path, progress):
    rng = random.Random(81)
    conn = prepare_db(db_path)
    today = date.today()
    start = today - timedelta(days=540)
    previous = ""
    count = 0
    try:
        for i in range(541):
            day = start + timedelta(days=i)
            if rng.random() < (0.55 if day.weekday() >= 5 else 0.16) or 185 < i < 204:
                continue
            for j in range(rng.randint(1, 9) + (2 if 370 < i < 445 else 0)):
                is_side = rng.random() < 0.19
                if branch == "refs/heads/main" and is_side:
                    continue
                if branch == "refs/heads/feat/canvas" and i > 430:
                    continue
                if mainline and is_side:
                    continue
                author, email = rng.choices(DEMO_AUTHORS, weights=[65, 19, 10, 6])[0]
                hour = rng.choices(list(range(24)), weights=[1, 1, 0, 0, 0, 1, 1, 2, 4, 10, 15, 13, 4, 9, 12, 14, 17, 12, 6, 7, 11, 12, 9, 4])[0]
                iso = f"{day.isoformat()}T{hour:02}:{rng.randrange(60):02}:00+08:00"
                a = int(rng.expovariate(1 / (230 if i < 200 else 125))) + 2
                d = int(a * rng.uniform(0.04, 0.92))
                if rng.random() < 0.08:
                    a, d = d // 2, a + d
                sha = hashlib.sha1(f"atlas-demo-{i}-{j}".encode()).hexdigest()
                language = rng.choices(["TypeScript", "CSS", "Markdown", "JSON", "JavaScript", "HTML"], [62, 16, 9, 5, 6, 2])[0]
                files = rng.randint(1, 9)
                commit = {"hash": sha, "parents": previous, "author": author, "email": email,
                          "timestamp": int(datetime.fromisoformat(iso).timestamp()), "date": iso, "day": day.isoformat(),
                          "hour": hour, "weekday": day.weekday(), "subject": rng.choice(DEMO_MESSAGES),
                          "additions": a, "deletions": d, "files": files, "binary": 0, "is_merge": 0,
                          "languages": {language: [a, d, files]}}
                insert_commit(conn, commit)
                previous, count = sha, count + 1
        conn.executescript(INDEXES)
        conn.execute("ANALYZE")
        conn.execute("INSERT INTO metadata VALUES ('version', ?)", (CACHE_VERSION,))
        conn.commit()
        progress(total=count, processed=count)
    finally:
        conn.close()


def where_clause(query):
    clauses, params = [], []
    for key, comparison in (("from", ">="), ("to", "<=")):
        value = query.get(key, "")
        if value:
            try:
                date.fromisoformat(value)
            except ValueError as exc:
                raise AppError("日期格式应为 YYYY-MM-DD。") from exc
            clauses.append(f"c.day {comparison} ?")
            params.append(value)
    if query.get("from") and query.get("to") and query["from"] > query["to"]:
        raise AppError("开始日期不能晚于结束日期。")
    if query.get("author"):
        clauses.append("c.email = ?")
        params.append(query["author"])
    if query.get("q"):
        search = query["q"][:300].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        clauses.append("(c.subject LIKE ? ESCAPE '\\' OR c.author LIKE ? ESCAPE '\\' OR c.hash LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')")
        params.extend([f"%{search}%"] * 4)
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), params


def analytics(db_path, query):
    where, params = where_clause(query)
    with closing(connect_db(db_path)) as conn:
        summary = dict(conn.execute("""SELECT COUNT(*) AS commits, COALESCE(SUM(additions),0) AS additions,
            COALESCE(SUM(deletions),0) AS deletions, COUNT(DISTINCT email) AS authors, COUNT(DISTINCT day) AS activeDays,
            MIN(day) AS first, MAX(day) AS last, COALESCE(SUM(binary),0) AS binary,
            COALESCE(SUM(is_merge),0) AS merges, COALESCE(SUM(files),0) AS fileTouches FROM commits c""" + where, params).fetchone())
        scope = dict(conn.execute("SELECT MIN(day) first, MAX(day) last, COUNT(*) commits FROM commits").fetchone())
        daily = [dict(r) for r in conn.execute("""SELECT day, COUNT(*) commits, SUM(additions) additions,
            SUM(deletions) deletions FROM commits c""" + where + " GROUP BY day ORDER BY day", params)]
        hours = [dict(r) for r in conn.execute("SELECT weekday, hour, COUNT(*) commits FROM commits c" + where + " GROUP BY weekday,hour", params)]
        authors = [dict(r) for r in conn.execute("""SELECT author name, email, COUNT(*) commits,
            SUM(additions) additions, SUM(deletions) deletions FROM commits c""" + where +
            " GROUP BY email ORDER BY commits DESC LIMIT 30", params)]
        language_source = "languages l JOIN commits c ON c.hash=l.hash" if where else "languages l"
        languages = [dict(r) for r in conn.execute("""SELECT l.language name, SUM(l.additions) additions,
            SUM(l.deletions) deletions, SUM(l.files) files FROM """ + language_source + where +
            " GROUP BY l.language ORDER BY SUM(l.additions+l.deletions) DESC", params)]
        recent = [dict(r) for r in conn.execute("SELECT * FROM commits c" + where + " ORDER BY timestamp DESC, hash LIMIT 5", params)]
        first_commit = conn.execute("SELECT * FROM commits c" + where + " ORDER BY timestamp, hash LIMIT 1", params).fetchone()
        largest_commit = conn.execute("SELECT * FROM commits c" + where + " ORDER BY additions+deletions DESC LIMIT 1", params).fetchone()
        author_options = [dict(r) for r in conn.execute("SELECT author name,email FROM commits GROUP BY email ORDER BY COUNT(*) DESC")]
    summary["net"] = summary["additions"] - summary["deletions"]
    summary["spanDays"] = (date.fromisoformat(summary["last"]) - date.fromisoformat(summary["first"])).days + 1 if daily else 0
    streak, longest, previous, max_gap = 0, 0, None, 0
    for item in daily:
        day = date.fromisoformat(item["day"])
        gap = (day - previous).days if previous else 0
        streak = streak + 1 if previous and gap == 1 else 1
        longest, max_gap, previous = max(longest, streak), max(max_gap, gap - 1), day
    summary["longestStreak"], summary["longestBreak"] = longest, max_gap
    summary["peakDay"] = max(daily, key=lambda r: r["commits"]) if daily else None
    return {"summary": summary, "scope": scope, "daily": daily, "hours": hours, "authors": authors,
            "languages": languages, "recent": recent, "firstCommit": dict(first_commit) if first_commit else None,
            "largestCommit": dict(largest_commit) if largest_commit else None, "authorOptions": author_options}


def commit_page(db_path, query):
    where, params = where_clause(query)
    try:
        offset = max(0, int(query.get("offset", 0)))
        limit = max(1, min(100, int(query.get("limit", 60))))
    except ValueError as exc:
        raise AppError("分页参数无效。") from exc
    order = "ASC" if query.get("order") == "asc" else "DESC"
    with closing(connect_db(db_path)) as conn:
        total = conn.execute("SELECT COUNT(*) FROM commits c" + where, params).fetchone()[0]
        rows = [dict(r) for r in conn.execute("SELECT * FROM commits c" + where + f" ORDER BY timestamp {order}, hash LIMIT ? OFFSET ?", [*params, limit, offset])]
    return {"commits": rows, "total": total, "offset": offset, "limit": limit}


def commit_detail(repo, sha, db_path, mainline):
    if not re.fullmatch(r"[a-f0-9]{40,64}", sha):
        raise AppError("提交 ID 无效。")
    with closing(connect_db(db_path)) as conn:
        row = conn.execute("SELECT * FROM commits WHERE hash=?", (sha,)).fetchone()
    if row is None:
        raise AppError("当前历史中找不到这条提交。")
    result = dict(row)
    if repo["demo"]:
        count = result["files"]
        names = ["src/workspace/canvas.tsx", "src/components/toolbar.tsx", "src/hooks/useWorkspace.ts",
                 "src/styles/workspace.css", "src/lib/layout.ts", "README.md", "src/routes/index.tsx",
                 "src/components/timeline.tsx", "src/state/workspace.ts"]
        result.update(message=result["subject"] + "\n\n这是一条演示提交。打开本地仓库即可查看真实的提交信息与文件变更。",
                      changedFiles=[{"path": names[i], "additions": result["additions"] // count + int(i < result["additions"] % count),
                                     "deletions": result["deletions"] // count + int(i < result["deletions"] % count),
                                     "binary": False} for i in range(count)])
        return result
    result["message"] = run_git(repo["gitDir"], ["show", "-s", "--format=%B", sha]).stdout.decode("utf-8", "replace").strip()
    args = ["show", "--format=", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
            "--diff-merges=first-parent" if mainline else "--no-diff-merges", sha, "--"]
    raw = run_git(repo["gitDir"], args, timeout=120).stdout
    files = []
    for token in raw.split(b"\0"):
        parts = token.lstrip(b"\n\r").split(b"\t", 2)
        if len(parts) == 3:
            a, d, path = parts
            binary = a == b"-"
            files.append({"path": path.decode("utf-8", "replace"), "additions": 0 if binary else int(a),
                          "deletions": 0 if binary else int(d), "binary": binary})
    result["changedFiles"] = files[:3000]
    result["filesTruncated"] = len(files) > 3000
    return result


class Application:
    def __init__(self, cache_dir):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(24)
        self.repos, self.jobs = {}, {}
        self.analytics_cache = OrderedDict()
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="git-scan")
        self.recent_path = self.cache_dir / "recent.json"
        self.startup_repo = None

    def recent(self):
        try:
            data = json.loads(self.recent_path.read_text("utf-8"))
            return data[:8] if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def open(self, path=None, demo=False):
        repo = demo_repository() if demo else describe_repository(path or "")
        with self.lock:
            self.repos[repo["id"]] = repo
            if not demo:
                recent = [{"path": repo["path"], "name": repo["name"]}, *[r for r in self.recent() if r.get("path") != repo["path"]]][:8]
                temp = self.recent_path.with_suffix(".tmp")
                temp.write_text(json.dumps(recent, ensure_ascii=False), "utf-8")
                temp.replace(self.recent_path)
        return repo

    def scan(self, repo_id, branch, mainline=False, refresh=False):
        with self.lock:
            repo = self.repos.get(repo_id)
        if not repo:
            raise AppError("请先打开一个仓库。")
        if not repo["demo"]:
            repo = describe_repository(repo["path"])
            with self.lock:
                self.repos[repo_id] = repo
        if branch == "__all__":
            mainline = False
            tips = sorted({b["sha"] for b in repo["branches"] if b["sha"]} | ({repo["head"]} if repo["head"] else set()))
        else:
            selected = next((b for b in repo["branches"] if b["ref"] == branch), None)
            if not selected:
                raise AppError("该分支已不存在，请刷新仓库后重新选择。")
            tips = [selected["sha"]] if selected["sha"] else []
        identity = [CACHE_VERSION, repo["gitDir"] or "demo", branch, mainline, tips,
                    repo.get("shallowFingerprint", ""),
                    date.today().isoformat() if repo["demo"] else ""]
        key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        db_path = self.cache_dir / f"{key}.sqlite3"
        pointer_path = self.cache_dir / f"{key}.current"
        try:
            filename = pointer_path.read_text("utf-8").strip()
            if re.fullmatch(key + r"\.[a-f0-9]{32}\.sqlite3", filename):
                db_path = self.cache_dir / filename
        except OSError:
            pass
        with self.lock:
            matches = [j for j in self.jobs.values() if j["key"] == key and j["status"] != "error"]
            existing = next((j for j in matches if j["status"] == "loading"), matches[-1] if matches else None)
            if existing and not (refresh and existing["status"] == "ready"):
                result = self.public_job(existing)
                if existing["status"] == "ready":
                    result.update(cached=True, elapsed=0)
                return result
            if len([j for j in self.jobs.values() if j["status"] == "loading"]) >= 4:
                raise AppError("已有多个解析任务，请等待它们完成后再打开新的历史。")
            job_id = uuid.uuid4().hex
            use_cache = db_path.exists() and not refresh
            if not use_cache:
                # Immutable snapshots let other tabs keep reading while a refresh is built.
                db_path = self.cache_dir / f"{key}.{job_id}.sqlite3"
            job = {"id": job_id, "key": key, "repo": repo, "branch": branch, "mainline": mainline,
                   "status": "loading", "processed": 0, "total": 0, "stage": "正在准备历史",
                   "started": time.monotonic(), "elapsed": 0, "cached": False, "db": str(db_path)}
            self.jobs[job_id] = job
            # Keep active jobs and a bounded set of completed handles. Cache files remain reusable.
            stale = [j["id"] for j in self.jobs.values() if j["status"] != "loading"][:-24]
            for old_id in stale:
                self.jobs.pop(old_id, None)
        if use_cache:
            job.update(status="ready", cached=True, stage="已读取本地缓存")
        else:
            def work():
                temp = db_path.with_name(f"{key}.{job_id}.building")
                def progress(**updates):
                    with self.lock:
                        job.update(updates)
                try:
                    if repo["demo"]:
                        import_demo(branch, mainline, temp, progress)
                    else:
                        import_history(repo, tips, mainline, temp, progress)
                    temp.replace(db_path)
                    pointer_temp = self.cache_dir / f"{key}.{job_id}.current.tmp"
                    pointer_temp.write_text(db_path.name, "utf-8")
                    pointer_temp.replace(pointer_path)
                    progress(status="ready", stage="历史已就绪", elapsed=round(time.monotonic() - job["started"], 2))
                except Exception as exc:
                    progress(status="error", error=str(exc), stage="解析失败")
                finally:
                    temp.unlink(missing_ok=True)
            self.pool.submit(work)
        return self.public_job(job)

    @staticmethod
    def public_job(job):
        return {k: v for k, v in job.items() if k not in {"key", "db", "started"}}

    def get_job(self, job_id, ready=False):
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            raise AppError("此解析会话已失效，请重新打开仓库。")
        if ready and job["status"] != "ready":
            raise AppError("历史还未解析完成。")
        return job

    def analyze(self, job, query):
        key = (job["id"], *(query.get(k, "") for k in ("from", "to", "author", "q")))
        with self.lock:
            if key in self.analytics_cache:
                self.analytics_cache.move_to_end(key)
                return self.analytics_cache[key]
        result = analytics(job["db"], query)
        with self.lock:
            self.analytics_cache[key] = result
            while len(self.analytics_cache) > 24:
                self.analytics_cache.popitem(last=False)
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "GitAtlas/1.0"

    @property
    def app(self):
        return self.server.application

    def log_message(self, fmt, *args):
        if args and "/api/jobs/" in str(args[0]):
            return
        super().log_message(fmt, *args)

    def reply(self, payload, status=200, content_type="application/json; charset=utf-8", extra=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if content_type.startswith("application/json") else payload
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if content_type.startswith("application/json") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if content_type.startswith("text/html"):
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def authorized(self, api=False):
        parsed = urlparse("http://" + self.headers.get("Host", ""))
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            self.reply({"error": "仅允许本机访问。"}, 403)
            return False
        if api and self.headers.get("X-Git-Atlas") != self.app.token:
            self.reply({"error": "会话已失效，请刷新页面。"}, 403)
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(path.query).items()}
        if not self.authorized(api=path.path.startswith("/api/")):
            return
        try:
            if path.path == "/api/session":
                return self.reply({"recent": self.app.recent(), "startupRepo": self.app.startup_repo, "version": "1.0.0"})
            if path.path.startswith("/api/jobs/"):
                return self.reply(self.app.public_job(self.app.get_job(path.path.rsplit("/", 1)[-1])))
            if path.path in {"/api/analytics", "/api/commits", "/api/commit", "/api/export"}:
                job = self.app.get_job(query.get("job", ""), ready=True)
                if path.path == "/api/analytics":
                    return self.reply(self.app.analyze(job, query))
                if path.path == "/api/commits":
                    return self.reply(commit_page(job["db"], query))
                if path.path == "/api/commit":
                    return self.reply(commit_detail(job["repo"], query.get("hash", ""), job["db"], job["mainline"]))
                return self.export_csv(job, query)
            if path.path.startswith("/api/"):
                return self.reply({"error": "接口不存在。"}, 404)
            resources = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                         "/style.css": ("style.css", "text/css; charset=utf-8"), "/favicon.svg": ("favicon.svg", "image/svg+xml")}
            if path.path not in resources:
                return self.reply(b"Not found", 404, "text/plain")
            filename, content_type = resources[path.path]
            body = (STATIC / filename).read_bytes()
            if filename == "index.html":
                body = body.replace(b"__SESSION_TOKEN__", self.app.token.encode())
            return self.reply(body, content_type=content_type)
        except AppError as exc:
            return self.reply({"error": str(exc)}, 400)
        except Exception as exc:
            print(f"Request failed: {exc}", file=sys.stderr)
            return self.reply({"error": "读取数据时发生错误。请刷新仓库后重试。"}, 500)

    def do_POST(self):
        if not self.authorized(api=True):
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 32768:
                raise AppError("请求过大。")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise AppError("请求格式无效。")
            if self.path == "/api/open":
                return self.reply(self.app.open(body.get("path"), bool(body.get("demo"))))
            if self.path == "/api/scan":
                return self.reply(self.app.scan(body.get("repo"), body.get("branch"), bool(body.get("mainline")), bool(body.get("refresh"))))
            if self.path == "/api/browse":
                try:
                    result = subprocess.run([sys.executable, str(ROOT / "picker.py")], stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, timeout=300, creationflags=CREATE_NO_WINDOW)
                    if result.returncode:
                        raise AppError("系统文件夹选择器不可用，请直接粘贴仓库路径。")
                    return self.reply({"path": result.stdout.decode("utf-8", "replace").strip()})
                except subprocess.TimeoutExpired:
                    raise AppError("文件夹选择已超时，请重新选择或粘贴路径。")
            return self.reply({"error": "接口不存在。"}, 404)
        except (ValueError, TypeError):
            return self.reply({"error": "请求格式无效。"}, 400)
        except AppError as exc:
            return self.reply({"error": str(exc)}, 400)
        except Exception as exc:
            print(f"Request failed: {exc}", file=sys.stderr)
            return self.reply({"error": "操作失败，请检查路径后重试。"}, 500)

    def export_csv(self, job, query):
        where, params = where_clause(query)
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="git-atlas-history.csv"')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        def safe_cell(value):
            text = str(value)
            return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer)
        self.wfile.write(b"\xef\xbb\xbf")
        writer.writerow(["hash", "author", "email", "author_date", "subject", "additions", "deletions", "net", "files", "merge"])
        with closing(connect_db(job["db"])) as conn:
            cursor = conn.execute("SELECT * FROM commits c" + where + " ORDER BY timestamp, hash", params)
            for index, row in enumerate(cursor):
                writer.writerow([safe_cell(row[k]) for k in ("hash", "author", "email", "date", "subject")] +
                                [row["additions"], row["deletions"], row["additions"] - row["deletions"], row["files"], row["is_merge"]])
                if index % 500 == 0:
                    self.wfile.write(buffer.getvalue().encode("utf-8"))
                    buffer.seek(0)
                    buffer.truncate(0)
            self.wfile.write(buffer.getvalue().encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Git Atlas · 本地 Git 历史可视化")
    parser.add_argument("--repo", help="仓库根目录、.git 目录或 .git 文件")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--cache-dir", default=str(ROOT / ".cache"))
    args = parser.parse_args()
    if not shutil.which("git"):
        parser.exit(1, "未找到 Git。请先安装 Git，并将其添加到 PATH。\n")
    version = subprocess.run(["git", "--version"], stdout=subprocess.PIPE, creationflags=CREATE_NO_WINDOW)
    match = re.search(rb"(\d+)\.(\d+)", version.stdout)
    if not match or tuple(map(int, match.groups())) < (2,45):
        parser.exit(1, "需要 Git 2.45 或更新版本，以支持纯本地的历史读取。请更新 Git。\n")
    app = Application(args.cache_dir)
    if args.repo:
        try:
            app.startup_repo = app.open(args.repo)
        except AppError as exc:
            parser.exit(1, f"{exc}\n")
    port = args.port
    for attempt in range(20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            if port == 0:
                raise
            port += 1
    else:
        parser.exit(1, "端口不可用，请使用 --port 指定其他端口。\n")
    server.application = app
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"\n  Git Atlas · 每一行，都有来处。\n\n  {url}\n  只读本地仓库 · Ctrl+C 退出\n", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\nGit Atlas 已退出。")
    finally:
        server.server_close()
        app.pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
