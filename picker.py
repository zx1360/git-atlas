"""Native, user-triggered folder picker; kept separate from the HTTP server."""
import sys
import tkinter as tk
from tkinter import filedialog

sys.stdout.reconfigure(encoding="utf-8")
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askdirectory(parent=root, title="选择 Git 仓库根目录或 .git 目录", mustexist=True)
root.destroy()
print(path or "")
