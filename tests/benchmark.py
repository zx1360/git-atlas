"""Optional real-Git benchmark: python tests/benchmark.py --commits 10000"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def benchmark(count):
    with tempfile.TemporaryDirectory(prefix="git-atlas-benchmark-") as folder:
        base = Path(folder)
        repo_path = base / "repository"
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo_path)], check=True, creationflags=app.CREATE_NO_WINDOW)
        process = subprocess.Popen(["git", "-C", str(repo_path), "fast-import", "--quiet"],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   creationflags=app.CREATE_NO_WINDOW)
        for i in range(count):
            blob = f"line-{i}\n".encode()
            message = f"feat: build iteration {i}"
            stamp = 1704067200 + i * 3600
            record = (f"blob\nmark :{i*2+1}\ndata {len(blob)}\n".encode() + blob + b"\n" +
                      f"commit refs/heads/main\nmark :{i*2+2}\nauthor Builder {i%5} <builder{i%5}@example.test> {stamp} +0800\ncommitter Builder <builder@example.test> {stamp} +0800\ndata {len(message)}\n{message}\n".encode() +
                      (f"from :{i*2}\n".encode() if i else b"") + f"M 100644 :{i*2+1} src/main.py\n\n".encode())
            process.stdin.write(record)
        process.stdin.write(b"done\n")
        process.stdin.close()
        errors = process.stderr.read()
        process.wait()
        if process.returncode:
            raise RuntimeError(errors.decode())
        repo = app.describe_repository(str(repo_path))
        tips = [repo["branches"][0]["sha"]]
        db = base / "history.sqlite3"
        start = time.perf_counter()
        app.import_history(repo, tips, False, db, lambda **kwargs: None)
        scan_seconds = time.perf_counter() - start
        start = time.perf_counter()
        data = app.analytics(db, {})
        analytics_seconds = time.perf_counter() - start
        start = time.perf_counter()
        page = app.commit_page(db, {"offset": str(count//2), "limit": "60"})
        page_seconds = time.perf_counter() - start
        assert data["summary"]["commits"] == count
        assert data["summary"]["net"] == 1
        print(json.dumps({"commits": count, "scanSeconds": round(scan_seconds,3),
                          "analyticsSeconds": round(analytics_seconds,3), "middlePageSeconds": round(page_seconds,3),
                          "databaseMB": round(db.stat().st_size/1024**2,2),
                          "aggregateResponseKB": round(len(json.dumps(data).encode())/1024,2),
                          "pageRows": len(page["commits"])}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--commits", type=int, default=10000)
    args = parser.parse_args()
    if not 1 <= args.commits <= 1000000:
        parser.error("commits must be between 1 and 1000000")
    benchmark(args.commits)
