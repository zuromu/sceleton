#!/usr/bin/python3
"""Sceleton's optional helper for notes apps.

The browser starts this when Sceleton has a markdown file to save, hands it the
file over a pipe, and it writes the file into one folder you chose when you ran
install.sh. That is all it does: it cannot read anything, and it refuses any
path that is not a .md file inside that folder.
"""
import json
import os
import struct
import sys
import tempfile

CONFIG = os.path.expanduser("~/.config/sceleton/vault.json")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    size = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def reply(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def save(root, rel, text):
    parts = [p for p in rel.replace("\\", "/").split("/") if p]
    if not parts or not rel.endswith(".md") or any(p in (".", "..") or p.startswith(".") for p in parts):
        raise ValueError("only .md files inside the folder are allowed")
    root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root, *parts))
    if not target.startswith(root + os.sep):
        raise ValueError("path leaves the folder")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".sceleton-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)  # the old file is swapped out in one step
    except Exception:
        os.unlink(tmp)
        raise


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        with open(CONFIG, encoding="utf-8") as f:
            root = json.load(f)["dir"]
        save(root, str(msg.get("path", "")), str(msg.get("text", "")))
        reply({"ok": True})
    except Exception as e:  # tell Sceleton, which then falls back to a normal download
        reply({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
