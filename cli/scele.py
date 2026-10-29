#!/usr/bin/env python3
"""
scele: a terminal companion for SCeLE (Fasilkom UI's Moodle).

Run `scele` with no arguments for today's dashboard, or `scele --help`
to see every command.
"""

import argparse
import getpass
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path

import requests
from rich import box
from rich.console import Console
from rich.table import Table
from rich.tree import Tree

__version__ = "0.1.0"

BASE_URL = os.environ.get("SCELE_URL", "https://scele.cs.ui.ac.id").rstrip("/")
TZ = timezone(timedelta(hours=7))  # Jakarta
CONFIG_DIR = Path(os.environ.get("SCELE_HOME", Path.home() / ".config" / "scele"))
CONFIG_FILE = CONFIG_DIR / "config.json"
CACHE_FILE = CONFIG_DIR / "cache.json"
KEYCHAIN_SERVICE = "scele-cli"
IS_MAC = platform.system() == "Darwin"

console = Console()

TYPE_LABELS = {
    "assign": "assignment",
    "quiz": "quiz",
    "forum": "forum",
    "workshop": "workshop",
    "lesson": "lesson",
    "choice": "choice",
    "feedback": "feedback",
    "attendance": "attendance",
}
MODULE_ICONS = {
    "resource": "📄", "folder": "📁", "url": "🔗", "assign": "📝", "quiz": "❓",
    "forum": "💬", "page": "📃", "book": "📚", "attendance": "✅",
}


class SceleError(Exception):
    """An error we can explain to the user in one line."""


class NeedsMobileApi(SceleError):
    pass


# ---------------------------------------------------------------- storage

def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path, data):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(data, indent=2))
    os.chmod(path, 0o600)  # only you can read your token


def load_cache():
    return load_json(CACHE_FILE, {})


def save_cache(cache):
    save_json(CACHE_FILE, cache)


# ---------------------------------------------------------------- keychain (macOS)

def keychain_set(user, password):
    if not IS_MAC:
        return False
    r = subprocess.run(
        ["security", "add-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE, "-w", password, "-U"],
        capture_output=True,
    )
    return r.returncode == 0


def keychain_get(user):
    if not IS_MAC:
        return None
    r = subprocess.run(
        ["security", "find-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def keychain_delete(user):
    if IS_MAC:
        subprocess.run(["security", "delete-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE],
                       capture_output=True)


# ---------------------------------------------------------------- talking to SCeLE

def new_session():
    s = requests.Session()
    s.headers["User-Agent"] = f"Mozilla/5.0 (scele-cli {__version__})"
    return s


def flatten(obj, prefix=""):
    """Turn {"courseids": [1, 2]} into {"courseids[0]": 1, "courseids[1]": 2} for Moodle's REST API."""
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}[{k}]" if prefix else k))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            out.update(flatten(v, f"{prefix}[{i}]"))
    elif isinstance(obj, bool):
        out[prefix] = int(obj)
    else:
        out[prefix] = obj
    return out


def token_login(session, username, password):
    """Log in the way the Moodle mobile app does. Returns (token, errorcode, message)."""
    r = session.post(f"{BASE_URL}/login/token.php",
                     data={"username": username, "password": password, "service": "moodle_mobile_app"},
                     timeout=30)
    try:
        data = r.json()
    except ValueError:
        return None, "notjson", "SCeLE didn't answer the mobile login"
    if data.get("token"):
        return data["token"], None, None
    return None, data.get("errorcode", "unknown"), data.get("error", "unknown error")


def web_login(session, username, password):
    """Log in like a browser. Returns (sesskey, userid or None)."""
    r = session.get(f"{BASE_URL}/login/index.php", timeout=30)
    r.raise_for_status()
    m = re.search(r'name="logintoken"\s+value="([^"]+)"', r.text)
    r = session.post(f"{BASE_URL}/login/index.php",
                     data={"username": username, "password": password,
                           "logintoken": m.group(1) if m else ""},
                     timeout=30)
    r.raise_for_status()
    m = re.search(r'"sesskey":"([^"]+)"', r.text)
    if not m:
        raise SceleError("Login failed. Double check your username and password.")
    uid = re.search(r"user/profile\.php\?id=(\d+)", r.text)
    return m.group(1), int(uid.group(1)) if uid else None


class Client:
    """Wraps the two ways we can talk to SCeLE.

    token mode: the mobile app API. Everything works.
    web mode:   the API the website itself uses. Deadlines and courses work,
                some other things may not.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.mode = cfg["mode"]
        self.s = new_session()
        for k, v in cfg.get("cookies", {}).items():
            self.s.cookies.set(k, v)

    def call(self, fn, **params):
        if self.mode == "token":
            return self._rest(fn, params)
        return self._ajax(fn, params, retry=True)

    def _rest(self, fn, params):
        data = {"wstoken": self.cfg["token"], "wsfunction": fn, "moodlewsrestformat": "json"}
        data.update(flatten(params))
        r = self.s.post(f"{BASE_URL}/webservice/rest/server.php", data=data, timeout=60)
        r.raise_for_status()
        out = r.json()
        if isinstance(out, dict) and out.get("exception"):
            if out.get("errorcode") == "invalidtoken":
                raise SceleError("Your login expired. Run `scele login` again.")
            raise SceleError(f"SCeLE said: {out.get('message', out.get('errorcode'))}")
        return out

    def _ajax(self, fn, params, retry):
        r = self.s.post(f"{BASE_URL}/lib/ajax/service.php",
                        params={"sesskey": self.cfg["sesskey"], "info": fn},
                        json=[{"index": 0, "methodname": fn, "args": params}],
                        timeout=60)
        r.raise_for_status()
        out = r.json()
        res = out[0] if isinstance(out, list) else out
        if res.get("error"):
            exc = res.get("exception") or {}
            code = exc.get("errorcode", "")
            if code in ("servicerequireslogin", "invalidsesskey", "requireloginerror") and retry:
                self.relogin()
                return self._ajax(fn, params, retry=False)
            if code in ("servicenotavailable", "invalidrecord") or "not available" in exc.get("message", ""):
                raise NeedsMobileApi(fn)
            raise SceleError(f"SCeLE said: {exc.get('message', code or 'unknown error')}")
        return res.get("data")

    def relogin(self):
        user = self.cfg["username"]
        password = keychain_get(user) or os.environ.get("SCELE_PASSWORD")
        if not password:
            raise SceleError("Your SCeLE session expired. Run `scele login` again.")
        self.s.cookies.clear()
        sesskey, uid = web_login(self.s, user, password)
        self.cfg.update(sesskey=sesskey, cookies=self.s.cookies.get_dict())
        if uid:
            self.cfg["userid"] = uid
        save_json(CONFIG_FILE, self.cfg)

    def userid(self):
        if not self.cfg.get("userid"):
            raise NeedsMobileApi("userid")
        return self.cfg["userid"]

    def file_url(self, fileurl):
        if self.mode == "token":
            sep = "&" if "?" in fileurl else "?"
            return f"{fileurl}{sep}token={self.cfg['token']}"
        return fileurl.replace("/webservice/pluginfile.php", "/pluginfile.php")


def get_client():
    cfg = load_json(CONFIG_FILE, {})
    if not cfg.get("mode"):
        raise SceleError("You're not logged in yet. Run `scele login` first.")
    return Client(cfg)


# ---------------------------------------------------------------- data helpers

def get_courses(cli, include_past=False):
    cache = load_cache()
    if not include_past and cache.get("courses_at", 0) > time.time() - 6 * 3600:
        return cache["courses"]
    data = cli.call("core_course_get_enrolled_courses_by_timeline_classification",
                    classification="all" if include_past else "inprogress",
                    limit=0, offset=0, sort="fullname")
    courses = [{"id": c["id"],
                "shortname": unescape(c.get("shortname") or ""),
                "fullname": unescape(c.get("fullname") or "")}
               for c in (data or {}).get("courses", [])]
    if not include_past:
        cache.update(courses=courses, courses_at=time.time())
        save_cache(cache)
    return courses


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def find_course(cli, query):
    courses = get_courses(cli)
    if query.isdigit() and 0 < int(query) <= len(courses):
        return courses[int(query) - 1]
    q = norm(query)
    exact = [c for c in courses if norm(c["shortname"]) == q]
    if exact:
        return exact[0]
    matches = [c for c in courses if q in norm(c["shortname"]) or q in norm(c["fullname"])]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise SceleError(f"No current course matches '{query}'. Run `scele courses` to see them.")
    names = ", ".join(c["shortname"] for c in matches)
    raise SceleError(f"'{query}' matches more than one course ({names}). Be a bit more specific.")


def get_events(cli, days, back_days=7):
    """Things that still need action from you, from a week ago up to `days` ahead."""
    now = int(time.time())
    data = cli.call("core_calendar_get_action_events_by_timesort",
                    timesortfrom=now - back_days * 86400,
                    timesortto=now + days * 86400,
                    limitnum=50)
    return sorted((data or {}).get("events", []), key=lambda e: e["timesort"])


def get_news(cli, days, courses=None, limit=None):
    courses = courses or get_courses(cli)
    if not courses:
        return []
    names = {c["id"]: c["shortname"] for c in courses}
    forums = cli.call("mod_forum_get_forums_by_courses", courseids=[c["id"] for c in courses])
    news_forums = [f for f in forums if f.get("type") == "news"]
    since = time.time() - days * 86400

    def fetch(forum):
        try:
            data = cli.call("mod_forum_get_forum_discussions", forumid=forum["id"], page=0, perpage=10)
        except SceleError:
            data = cli.call("mod_forum_get_forum_discussions_paginated", forumid=forum["id"],
                            sortby="timemodified", sortdirection="DESC", page=0, perpage=10)
        items = []
        for d in data.get("discussions", []):
            created = d.get("created") or d.get("timemodified") or 0
            if created < since:
                continue
            items.append({
                "subject": unescape(d.get("subject") or d.get("name") or "(no title)"),
                "course": names.get(forum["course"], ""),
                "author": d.get("userfullname", ""),
                "time": created,
                "message": d.get("message", ""),
                "url": f"{BASE_URL}/mod/forum/discuss.php?d={d.get('discussion') or d.get('id')}",
            })
        return items

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = [item for chunk in pool.map(fetch, news_forums) for item in chunk]
    results.sort(key=lambda n: n["time"], reverse=True)
    return results[:limit] if limit else results


# ---------------------------------------------------------------- formatting

def rel(ts):
    diff = ts - time.time()
    past, d = diff < 0, abs(diff)
    if d < 3600:
        s = f"{int(d // 60)}m"
    elif d < 86400:
        s = f"{int(d // 3600)}h {int(d % 3600 // 60)}m"
    else:
        s = f"{int(d // 86400)}d {int(d % 86400 // 3600)}h"
    return f"{s} ago" if past else f"in {s}"


def fmt_time(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%a %d %b %H:%M")


def urgency(ts):
    left = ts - time.time()
    if left < 0:
        return "bold red"
    if left < 86400:
        return "red"
    if left < 3 * 86400:
        return "yellow"
    return "green"


def strip_html(s):
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</div>|</h\d>", "\n", s or "")
    s = unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def safe_name(s):
    s = re.sub(r"\s*:\s*", " - ", strip_html(s))
    s = re.sub(r'[\\/*?"<>|\n\r\t]+', "-", s)
    s = re.sub(r"\s+", " ", s).strip(" .-")
    return s[:80] or "untitled"


def event_name(e):
    return unescape(e.get("activityname") or e.get("name") or "")


def event_course(e):
    c = e.get("course") or {}
    return unescape(c.get("shortname") or c.get("fullname") or "")


def events_table(events, start=1):
    t = Table(box=box.SIMPLE_HEAD, show_edge=False, pad_edge=False)
    t.add_column("#", style="dim", justify="right")
    t.add_column("Due")
    t.add_column("Left", justify="right")
    t.add_column("Course", style="cyan", max_width=24, overflow="ellipsis")
    t.add_column("Task")
    for i, e in enumerate(events, start):
        ts = e["timesort"]
        kind = TYPE_LABELS.get(e.get("modulename"), e.get("modulename") or "")
        t.add_row(str(i), fmt_time(ts), f"[{urgency(ts)}]{rel(ts)}[/]",
                  event_course(e), f"{event_name(e)} [dim]{kind}[/]")
    return t


def remember_items(urls):
    cache = load_cache()
    cache["last_items"] = urls
    save_cache(cache)


# ---------------------------------------------------------------- commands

def cmd_login(args):
    username = args.username or console.input("SSO username: ").strip()
    password = os.environ.get("SCELE_PASSWORD") or getpass.getpass("Password: ")
    s = new_session()
    cfg = {"username": username}

    if not args.web:
        with console.status("Logging in..."):
            token, code, msg = token_login(s, username, password)
        if token:
            cfg.update(mode="token", token=token)
            info = Client(cfg).call("core_webservice_get_site_info")
            cfg.update(userid=info.get("userid"), fullname=info.get("fullname"))
            save_json(CONFIG_FILE, cfg)
            console.print(f"[green]Logged in as {cfg['fullname'] or username}.[/] Your password wasn't saved, only a login token.")
            return
        if code == "invalidlogin":
            raise SceleError("Wrong username or password.")
        console.print(f"[yellow]Mobile login didn't work ({msg}), trying the website login instead.[/]")

    with console.status("Logging in through the website..."):
        sesskey, uid = web_login(s, username, password)
    cfg.update(mode="web", sesskey=sesskey, cookies=s.cookies.get_dict(), userid=uid)
    save_json(CONFIG_FILE, cfg)
    console.print(f"[green]Logged in as {username}[/] (website mode).")
    if IS_MAC and console.input("Save your password in the macOS Keychain so you stay logged in? [Y/n] ").strip().lower() in ("", "y", "yes"):
        if keychain_set(username, password):
            console.print("Saved in Keychain.")
    elif not IS_MAC:
        console.print("[dim]Your session will expire after a while. Just run `scele login` again when it does.[/]")


def cmd_logout(args):
    cfg = load_json(CONFIG_FILE, {})
    if cfg.get("username"):
        keychain_delete(cfg["username"])
    for f in (CONFIG_FILE, CACHE_FILE):
        f.unlink(missing_ok=True)
    console.print("Logged out and cleared everything saved.")


def cmd_whoami(cli, args):
    mode = "mobile API (everything works)" if cli.mode == "token" else "website (some commands are limited)"
    console.print(f"{cli.cfg.get('fullname') or cli.cfg['username']} · {mode} · {BASE_URL}")


def cmd_today(cli, args):
    now = time.time()
    end_of_today = datetime.now(TZ).replace(hour=23, minute=59, second=59).timestamp()
    with console.status("Checking SCeLE..."):
        events = get_events(cli, days=14)
        try:
            news = get_news(cli, days=2, limit=3)
        except SceleError:
            news = []

    name = (cli.cfg.get("fullname") or cli.cfg["username"]).split()[0].split(".")[0].title()
    console.print(f"\n[bold]Hi {name}[/] [dim]· {datetime.now(TZ).strftime('%A %d %B')}[/]\n")

    groups = [
        ("Overdue", "bold red", [e for e in events if e["timesort"] < now]),
        ("Due today", "red", [e for e in events if now <= e["timesort"] <= end_of_today]),
        ("This week", "yellow", [e for e in events if end_of_today < e["timesort"] <= now + 7 * 86400]),
        ("Next week", "green", [e for e in events if e["timesort"] > now + 7 * 86400]),
    ]
    urls, n = [], 1
    for title, style, items in groups:
        if not items:
            continue
        console.print(f"[{style}]{title}[/]")
        console.print(events_table(items, start=n))
        console.print()
        n += len(items)
        urls += [e.get("url", "") for e in items]

    if not events:
        console.print("[green]Nothing due in the next two weeks.[/] Go touch grass.\n")

    if news:
        console.print("[bold]New announcements[/]")
        for item in news:
            console.print(f"  [{n}] {item['subject']} [dim]· {item['course']} · {rel(item['time'])}[/]")
            urls.append(item["url"])
            n += 1
        console.print()

    remember_items(urls)
    if urls:
        console.print("[dim]Tip: `scele open <#>` opens an item in your browser.[/]")


def cmd_todo(cli, args):
    with console.status("Fetching deadlines..."):
        events = get_events(cli, days=args.days)
    if not args.all:
        events = [e for e in events if e.get("modulename") == "assign"]
    if args.course:
        cid = find_course(cli, args.course)["id"]
        events = [e for e in events if (e.get("course") or {}).get("id") == cid]
    if not events:
        console.print(f"[green]Nothing to do in the next {args.days} days.[/]")
        return
    console.print(events_table(events))
    remember_items([e.get("url", "") for e in events])


def cmd_courses(cli, args):
    courses = get_courses(cli, include_past=args.all)
    t = Table(box=box.SIMPLE_HEAD, show_edge=False)
    t.add_column("#", style="dim", justify="right")
    t.add_column("Short name", style="cyan")
    t.add_column("Full name")
    for i, c in enumerate(courses, 1):
        t.add_row(str(i), c["shortname"], c["fullname"])
    console.print(t)
    console.print("[dim]You can refer to a course by its number, short name, or part of its name (e.g. `ddp2`).[/]")


def cmd_files(cli, args):
    course = find_course(cli, args.course)
    with console.status("Loading course page..."):
        sections = cli.call("core_course_get_contents", courseid=course["id"])
    tree = Tree(f"[bold cyan]{course['fullname']}[/]")
    for sec in sections:
        mods = [m for m in sec.get("modules", []) if m.get("modname") != "label"]
        if not mods:
            continue
        branch = tree.add(f"[bold]{strip_html(sec.get('name') or 'General')}[/]")
        for m in mods:
            icon = MODULE_ICONS.get(m.get("modname"), "•")
            branch.add(f"{icon} {unescape(m.get('name', ''))} [dim]{m.get('modname')}[/]")
    console.print(tree)


def collect_files(sections):
    for sec in sections:
        secname = safe_name(sec.get("name") or "General")
        for m in sec.get("modules", []):
            if m.get("modname") not in ("resource", "folder"):
                continue
            for f in m.get("contents") or []:
                if f.get("type") != "file":
                    continue
                parts = [secname]
                if m.get("modname") == "folder":
                    parts.append(safe_name(m.get("name", "folder")))
                    parts += [safe_name(p) for p in (f.get("filepath") or "/").strip("/").split("/") if p]
                parts.append(safe_name(f.get("filename", "file")))
                yield Path(*parts), f


def download(cli, f, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with cli.s.get(cli.file_url(f["fileurl"]), stream=True, timeout=120) as r:
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "json" in ctype or ("text/html" in ctype and dest.suffix.lower() not in (".html", ".htm")):
            raise SceleError(f"Couldn't download {dest.name} (SCeLE sent back a page instead of the file).")
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(65536):
                fh.write(chunk)
    tmp.replace(dest)
    if f.get("timemodified"):
        os.utime(dest, (f["timemodified"], f["timemodified"]))


def needs_download(f, dest):
    if not dest.exists():
        return True
    st = dest.stat()
    if f.get("filesize") and st.st_size != f["filesize"]:
        return True
    return f.get("timemodified", 0) > st.st_mtime + 1


def cmd_sync(cli, args):
    root = Path(args.to).expanduser()
    courses = [find_course(cli, args.course)] if args.course else get_courses(cli)
    with console.status("Reading course pages..."):
        with ThreadPoolExecutor(max_workers=4) as pool:
            contents = list(pool.map(lambda c: cli.call("core_course_get_contents", courseid=c["id"]), courses))

    new, same, failed = [], 0, 0
    for course, sections in zip(courses, contents):
        for rel_path, f in collect_files(sections):
            dest = root / safe_name(course["shortname"]) / rel_path
            if not needs_download(f, dest):
                same += 1
                continue
            label = f"{course['shortname']}/{rel_path}"
            if args.dry_run:
                new.append(label)
                continue
            try:
                with console.status(f"Downloading {rel_path.name}..."):
                    download(cli, f, dest)
                new.append(label)
            except (SceleError, requests.RequestException) as e:
                failed += 1
                console.print(f"[red]✗[/] {label}: {e}")

    verb = "Would download" if args.dry_run else "Downloaded"
    for label in new:
        console.print(f"[green]+[/] {label}")
    console.print(f"\n{verb} {len(new)} new file(s), {same} already up to date"
                  + (f", {failed} failed" if failed else "") + f". Files are in {root}")


def cmd_news(cli, args):
    courses = [find_course(cli, args.course)] if args.course else None
    with console.status("Fetching announcements..."):
        news = get_news(cli, days=args.days, courses=courses)
    if not news:
        console.print(f"No announcements in the last {args.days} days.")
        return
    for i, item in enumerate(news, 1):
        console.print(f"[dim]{i:>2}[/] [bold]{item['subject']}[/]")
        console.print(f"   [cyan]{item['course']}[/] [dim]· {item['author']} · {fmt_time(item['time'])} ({rel(item['time'])})[/]")
        if args.full:
            body = strip_html(item["message"])
            console.print("   " + body.replace("\n", "\n   "))
        console.print()
    remember_items([n["url"] for n in news])
    hint = "`scele open <#>` opens one in your browser." if args.full else \
        "Add -f to read the full posts, or `scele open <#>` to open one."
    console.print(f"[dim]{hint}[/]")


def cmd_grades(cli, args):
    if not args.course:
        with console.status("Fetching grades..."):
            data = cli.call("gradereport_overview_get_course_grades")
        names = {c["id"]: c["shortname"] for c in get_courses(cli, include_past=True)}
        t = Table(box=box.SIMPLE_HEAD, show_edge=False)
        t.add_column("Course", style="cyan")
        t.add_column("Grade", justify="right")
        for g in data.get("grades", []):
            if g["courseid"] in names:
                t.add_row(names[g["courseid"]], g.get("grade") or "-")
        console.print(t)
        console.print("[dim]Run `scele grades <course>` for the full breakdown.[/]")
        return

    course = find_course(cli, args.course)
    with console.status("Fetching grades..."):
        data = cli.call("gradereport_user_get_grade_items", courseid=course["id"], userid=cli.userid())
    items = data["usergrades"][0]["gradeitems"] if data.get("usergrades") else []
    t = Table(title=course["fullname"], box=box.SIMPLE_HEAD, show_edge=False)
    t.add_column("Item")
    t.add_column("Grade", justify="right")
    t.add_column("Range", justify="right", style="dim")
    t.add_column("%", justify="right")
    for it in items:
        name = it.get("itemname") or ("Course total" if it.get("itemtype") == "course" else "Category total")
        style = "bold" if it.get("itemtype") in ("course", "category") else ""
        t.add_row(f"[{style}]{unescape(name)}[/]" if style else unescape(name),
                  it.get("gradeformatted") or "-", it.get("rangeformatted") or "",
                  it.get("percentageformatted") or "")
    console.print(t)


def cmd_open(cli, args):
    target = args.target
    if not target:
        url = f"{BASE_URL}/my/"
    elif target.isdigit():
        items = load_cache().get("last_items", [])
        idx = int(target) - 1
        if not 0 <= idx < len(items) or not items[idx]:
            raise SceleError("No item with that number. Run `scele`, `scele todo` or `scele news` first.")
        url = items[idx]
    else:
        url = f"{BASE_URL}/course/view.php?id={find_course(cli, target)['id']}"
    console.print(f"Opening {url}")
    webbrowser.open(url)


def ics_escape(s):
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def cmd_ics(cli, args):
    events = get_events(cli, days=args.days, back_days=0)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//scele-cli//EN",
             "CALSCALE:GREGORIAN", "X-WR-CALNAME:SCeLE deadlines"]
    for e in events:
        when = datetime.fromtimestamp(e["timesort"], timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        summary = f"[{event_course(e)}] {event_name(e)}"
        lines += [
            "BEGIN:VEVENT",
            f"UID:scele-{e.get('id')}@scele-cli",
            f"DTSTAMP:{stamp}", f"DTSTART:{when}", f"DTEND:{when}",
            f"SUMMARY:{ics_escape(summary)}",
            f"DESCRIPTION:{ics_escape(e.get('url', ''))}",
            f"URL:{e.get('url', '')}",
        ]
        for trigger in ("-P1D", "-PT3H"):
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"TRIGGER:{trigger}",
                      f"DESCRIPTION:{ics_escape(summary)}", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    out = Path(args.output).expanduser()
    out.write_text("\r\n".join(lines) + "\r\n")
    console.print(f"Wrote {len(events)} deadline(s) to {out}")
    if args.open and IS_MAC:
        subprocess.run(["open", str(out)])


def as_applescript(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def notify(title, subtitle, message):
    if IS_MAC:
        script = (f"display notification {as_applescript(message)} with title "
                  f"{as_applescript(title)} subtitle {as_applescript(subtitle)} sound name \"default\"")
        subprocess.run(["osascript", "-e", script], capture_output=True)
    else:
        console.print(f"{title} · {subtitle} · {message}")


def cmd_notify(cli, args):
    events = [e for e in get_events(cli, days=max(1, args.hours // 24 + 1), back_days=1)
              if e["timesort"] <= time.time() + args.hours * 3600]
    for e in events[:5]:
        left = rel(e["timesort"])
        title = "SCeLE: overdue!" if "ago" in left else f"SCeLE: due {left}"
        notify(title, event_course(e), event_name(e))
    if len(events) > 5:
        notify("SCeLE", "", f"...and {len(events) - 5} more. Run `scele` to see everything.")
    if not events and args.verbose:
        console.print(f"Nothing due in the next {args.hours} hours.")


PLIST = Path.home() / "Library" / "LaunchAgents" / "id.scele.reminders.plist"


def cmd_schedule(args):
    if not IS_MAC:
        console.print("Automatic reminders use macOS launchd. On Linux, add this to `crontab -e`:")
        console.print(f"  0 8 * * * {sys.executable} {Path(__file__).resolve()} notify --hours 36")
        return
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    if args.remove:
        PLIST.unlink(missing_ok=True)
        console.print("Daily reminders turned off.")
        return

    times = args.time or ["08:00"]
    intervals = ""
    for t in times:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", t)
        if not m:
            raise SceleError(f"'{t}' isn't a time like 08:00")
        intervals += (f"<dict><key>Hour</key><integer>{int(m.group(1))}</integer>"
                      f"<key>Minute</key><integer>{int(m.group(2))}</integer></dict>")
    exe = shutil.which("scele")
    program = [exe] if exe else [sys.executable, str(Path(__file__).resolve())]
    program += ["notify", "--hours", str(args.hours)]
    prog_xml = "".join(f"<string>{p}</string>" for p in program)
    log = CONFIG_DIR / "reminders.log"
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>id.scele.reminders</string>
<key>ProgramArguments</key><array>{prog_xml}</array>
<key>StartCalendarInterval</key><array>{intervals}</array>
<key>StandardOutPath</key><string>{log}</string>
<key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
""")
    subprocess.run(["launchctl", "load", "-w", str(PLIST)], check=False)
    console.print(f"[green]Done.[/] You'll get a notification at {', '.join(times)} every day "
                  f"for anything due within {args.hours} hours.")
    console.print("[dim]Try it now with `scele notify`. Turn it off with `scele schedule --remove`.[/]")


# ---------------------------------------------------------------- entry point

def build_parser():
    p = argparse.ArgumentParser(prog="scele", description="Your SCeLE, in the terminal. Run with no command for today's dashboard.")
    p.add_argument("--version", action="version", version=f"scele {__version__}")
    sub = p.add_subparsers(dest="cmd", metavar="<command>")

    s = sub.add_parser("login", help="log in to SCeLE")
    s.add_argument("-u", "--username")
    s.add_argument("--web", action="store_true", help="skip the mobile API and log in like a browser")
    sub.add_parser("logout", help="log out and delete saved login")
    sub.add_parser("whoami", help="show who you're logged in as")
    sub.add_parser("today", help="dashboard: what's overdue, due today, this week, and new announcements")

    s = sub.add_parser("todo", help="list upcoming deadlines")
    s.add_argument("-d", "--days", type=int, default=30)
    s.add_argument("-a", "--all", action="store_true", help="include quizzes, forums, etc.")
    s.add_argument("-c", "--course")

    s = sub.add_parser("courses", help="list your courses")
    s.add_argument("-a", "--all", action="store_true", help="include past semesters")

    s = sub.add_parser("files", help="show what's on a course page")
    s.add_argument("course")

    s = sub.add_parser("sync", help="download course materials (only new or changed files)")
    s.add_argument("course", nargs="?")
    s.add_argument("--to", default="~/SCeLE", help="where to save (default ~/SCeLE)")
    s.add_argument("-n", "--dry-run", action="store_true", help="show what would be downloaded")

    s = sub.add_parser("news", help="recent course announcements")
    s.add_argument("course", nargs="?")
    s.add_argument("-d", "--days", type=int, default=7)
    s.add_argument("-f", "--full", action="store_true", help="show the full posts")

    s = sub.add_parser("grades", help="grades overview, or one course in detail")
    s.add_argument("course", nargs="?")

    s = sub.add_parser("open", help="open SCeLE, a course, or a numbered item in your browser")
    s.add_argument("target", nargs="?")

    s = sub.add_parser("ics", help="export deadlines to a calendar file")
    s.add_argument("-o", "--output", default="scele-deadlines.ics")
    s.add_argument("-d", "--days", type=int, default=60)
    s.add_argument("--open", action="store_true", help="open it in Calendar right away (macOS)")

    s = sub.add_parser("notify", help="send a notification for anything due soon")
    s.add_argument("--hours", type=int, default=24)
    s.add_argument("-v", "--verbose", action="store_true")

    s = sub.add_parser("schedule", help="get daily reminder notifications (macOS)")
    s.add_argument("-t", "--time", action="append", help="time like 08:00, can be used more than once")
    s.add_argument("--hours", type=int, default=36, help="remind about things due within this many hours")
    s.add_argument("--remove", action="store_true", help="turn reminders off")
    return p


HANDLERS = {
    "whoami": cmd_whoami, "today": cmd_today, "todo": cmd_todo, "courses": cmd_courses,
    "files": cmd_files, "sync": cmd_sync, "news": cmd_news, "grades": cmd_grades,
    "open": cmd_open, "ics": cmd_ics, "notify": cmd_notify,
}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd is None:
        args = parser.parse_args(["today"])
    try:
        if args.cmd == "login":
            cmd_login(args)
        elif args.cmd == "logout":
            cmd_logout(args)
        elif args.cmd == "schedule":
            cmd_schedule(args)
        else:
            HANDLERS[args.cmd](get_client(), args)
    except NeedsMobileApi:
        console.print("[yellow]This command needs the mobile API, and you're logged in through the website.[/]\n"
                      "Try `scele login` again without --web. If SCeLE blocks the mobile login, "
                      "`scele`, `todo`, `courses` and `open` still work.")
        sys.exit(1)
    except SceleError as e:
        console.print(f"[red]{e}[/]")
        sys.exit(1)
    except requests.ConnectionError:
        console.print("[red]Can't reach SCeLE. Check your internet, or SCeLE might be down.[/]")
        sys.exit(1)
    except requests.HTTPError as e:
        console.print(f"[red]SCeLE returned an error: {e}[/]")
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
