"""
A fake SCeLE (Moodle) for developing and testing Sceleton without a real account.

    python3 dev/mock_scele.py            # every API function allowed
    python3 dev/mock_scele.py --limited  # course pages and grades only as HTML,
                                         # like a Moodle that blocks those API calls

Log in at http://127.0.0.1:8765/login/index.php with any username and the
password "pw". Extra endpoints for tests:
    POST /__dev/add-material?course=101   pretend a lecturer uploaded something
    POST /__dev/add-notification          pretend someone posted an announcement
    POST /__dev/logout                    end every session
"""

import html
import json
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
LIMITED = "--limited" in sys.argv
JAKARTA = timezone(timedelta(hours=7))
START = time.time()
SESSIONS = {}  # cookie -> sesskey
USER = {"id": 4242, "name": "Ahmad Hoesin"}


def soon(hours):
    """A timestamp `hours` from now, rounded to 5 minutes. Used for the near
    deadlines so tests behave the same at any time of day."""
    return int((time.time() + hours * 3600) // 300 * 300)


def at(days, clock):
    """A timestamp `days` from today at a Jakarta clock time like '23:55'."""
    h, m = map(int, clock.split(":"))
    d = datetime.now(JAKARTA).replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(days=days)
    return int(d.timestamp())


COURSES = [
    {"id": 101, "shortname": "PBP KI", "fullname": "Platform-Based Programming"},
    {"id": 102, "shortname": "BasDat KI", "fullname": "Databases"},
    {"id": 103, "shortname": "OS KI", "fullname": "Operating Systems"},
    {"id": 104, "shortname": "TBA KI", "fullname": "Theory of Languages and Automata"},
    {"id": 105, "shortname": "StatProb KI", "fullname": "Probability and Statistics"},
    {"id": 106, "shortname": "AlLin KI", "fullname": "Linear Algebra"},
    # enrolled only to look around, like a lot of people do
    {"id": 107, "shortname": "AdPro KI", "fullname": "Advanced Programming"},
    {"id": 108, "shortname": "ML Reg", "fullname": "Machine Learning"},
]
PAST = [
    {"id": 91, "shortname": "DDP2 KI", "fullname": "Programming Foundations 2"},
    {"id": 92, "shortname": "MatDis KI", "fullname": "Discrete Mathematics"},
]

TOPICS = {
    101: ["Web and Django basics", "Models, views and templates", "Forms and data delivery", "Authentication and cookies",
          "CSS and Tailwind", "JavaScript and AJAX", "Flutter basics", "Flutter state and navigation"],
    102: ["ER modelling", "The relational model", "SQL basics", "Joins and subqueries", "Normalization", "Transactions"],
    103: ["What an OS does", "Processes", "Threads", "CPU scheduling", "Synchronization"],
    104: ["Regular languages", "DFA and NFA", "Regular expressions", "Context-free grammars", "Pushdown automata"],
    105: ["Probability", "Random variables", "Common distributions", "Sampling", "Estimation"],
    106: ["Systems of linear equations", "Matrices", "Determinants", "Vector spaces", "Eigenvalues"],
    107: ["Git workflow", "Clean code", "Design patterns"],
    108: ["Linear regression", "Classification"],
}

_next_id = [1000]


def nid():
    _next_id[0] += 1
    return _next_id[0]


def file(name, size, days_ago=20):
    return {"type": "file", "filename": name, "filepath": "/", "filesize": size,
            "timemodified": int(START - days_ago * 86400), "mimetype": "application/pdf"}


def build_contents():
    contents = {}
    for c in COURSES:
        cid = c["id"]
        secs = [{"id": cid * 100, "name": "General", "section": 0, "modules": [
            {"id": nid(), "name": "Announcements", "modname": "forum"},
            {"id": nid(), "name": "Course outline (RPS)", "modname": "resource", "contents": [file(f"RPS {c['shortname']}.pdf", 412_000, 60)]},
            {"id": nid(), "name": "Zoom link for online classes", "modname": "url"},
        ]}]
        for i, topic in enumerate(TOPICS[cid], 1):
            mods = [{"id": nid(), "name": f"Slides week {i}: {topic}", "modname": "resource",
                     "contents": [file(f"W{i:02d} {topic}.pdf", 900_000 + i * 137_000, 60 - i * 7)]}]
            if i % 2 == 0:
                mods.append({"id": nid(), "name": f"Lab {i // 2} starter code", "modname": "folder", "contents": [
                    {**file("README.md", 2_300, 50 - i * 6), "filepath": "/"},
                    {**file("main.py" if cid != 101 else "views.py", 4_100, 50 - i * 6), "filepath": "/src/"},
                    {**file("test_main.py" if cid != 101 else "tests.py", 3_200, 50 - i * 6), "filepath": "/src/"},
                ]})
            if i in (3, 5):
                mods.append({"id": nid(), "name": f"Lecture recording week {i}", "modname": "url"})
            secs.append({"id": cid * 100 + i, "name": f"Week {i}: {topic}", "section": i, "modules": mods})
        contents[cid] = secs
    return contents


CONTENTS = build_contents()


def add_module(cid, sec_index, mod):
    CONTENTS[cid][sec_index]["modules"].append(mod)
    return mod


def ev(cid, name, mod, t, action="Add submission"):
    sec = CONTENTS[cid][-1]
    m = add_module(cid, len(CONTENTS[cid]) - 1, {"id": nid(), "name": name, "modname": mod})
    c = next(x for x in COURSES if x["id"] == cid)
    return {"id": nid(), "name": f"{name} is due", "activityname": name, "modulename": mod,
            "course": {**c, "viewurl": f"{BASE}/course/view.php?id={cid}"}, "timesort": t, "eventtype": "due",
            "url": f"{BASE}/mod/{mod}/view.php?id={m['id']}", "action": {"name": action, "url": f"{BASE}/mod/{mod}/view.php?id={m['id']}", "actionable": True}}


EVENTS = [
    ev(102, "Lab 6: Normalization", "assign", soon(-5)),
    ev(101, "Tugas Individu 7", "assign", soon(3.2)),
    ev(104, "Quiz 3: Pushdown automata", "quiz", soon(37), "Attempt quiz now"),
    ev(103, "Attendance week 9", "attendance", soon(30), "Submit attendance"),
    ev(105, "Problem set 5", "assign", at(2, "23:59")),
    ev(103, "Lab 4: Process scheduling", "assign", at(3, "20:00")),
    ev(101, "Proyek Akhir Tahap 2", "assign", at(6, "23:55")),
    ev(106, "Homework 6", "assign", at(8, "23:59")),
    ev(102, "Tugas Kelompok 2: ERD", "assign", at(10, "23:55")),
    ev(104, "Homework 4", "assign", at(12, "23:59")),
    ev(105, "Quiz 4", "quiz", at(16, "10:00"), "Attempt quiz now"),
    ev(108, "ML assignment 2", "assign", soon(2.1)),
    ev(107, "Tutorial 5: Refactoring", "assign", at(4, "23:55")),
]

NOTIFS = [
    {"id": 9005, "subject": "PBP KI: Deadline Tugas Individu 7 diperpanjang", "smallmessage": "Halo semua, deadline Tugas Individu 7 diperpanjang sampai malam ini jam 23.55. Pastikan sudah push ke GitHub dan deploy ke PWS ya.", "contexturl": f"{BASE}/mod/forum/discuss.php?d=77", "timecreated": int(START - 3 * 3600), "read": False, "component": "mod_forum"},
    {"id": 9004, "subject": "Your submission for Lab 5: SQL joins has been graded", "smallmessage": "Lab 5: SQL joins in BasDat KI has been graded. Grade: 92.00 / 100.00", "contexturl": f"{BASE}/mod/assign/view.php?id=1201", "timecreated": int(START - 26 * 3600), "read": False, "component": "mod_assign"},
    {"id": 9003, "subject": "BasDat KI: Kelas pengganti hari Sabtu", "smallmessage": "Kelas pengganti untuk pertemuan minggu lalu akan diadakan hari Sabtu jam 09.00 di Gedung A 2.2302.", "contexturl": f"{BASE}/mod/forum/discuss.php?d=76", "timecreated": int(START - 2 * 86400), "read": True, "component": "mod_forum"},
    {"id": 9002, "subject": "StatProb KI: Tips for the midterm", "smallmessage": "The midterm covers weeks 1 to 7. Bring a scientific calculator and one A4 cheat sheet.", "contexturl": f"{BASE}/mod/forum/discuss.php?d=75", "timecreated": int(START - 3 * 86400), "read": True, "component": "mod_forum"},
    {"id": 9001, "subject": "Quiz 2 results are available", "smallmessage": "Your attempt on Quiz 2 in TBA KI has been graded.", "contexturl": f"{BASE}/mod/quiz/view.php?id=1301", "timecreated": int(START - 5 * 86400), "read": True, "component": "mod_quiz"},
]

GRADES = {101: "88.40", 102: "91.25", 103: "-", 104: "79.50", 105: "84.00", 106: "-", 91: "A-", 92: "B+"}
GRADE_ITEMS = {
    101: [("Tugas Individu 1", "100.00"), ("Tugas Individu 2", "95.00"), ("Tugas Individu 3", "90.00"), ("Tugas Individu 4", "85.00"), ("Tugas Individu 5", "80.00"), ("Tugas Individu 6", "-"), ("Quiz 1", "78.00")],
    102: [("Lab 1", "95.00"), ("Lab 2", "90.00"), ("Lab 3", "88.00"), ("Lab 4", "93.00"), ("Lab 5: SQL joins", "92.00")],
    104: [("Quiz 1", "82.00"), ("Quiz 2", "77.00"), ("Homework 1", "80.00"), ("Homework 2", "79.00")],
}


def find_module(mid):
    for cid, secs in CONTENTS.items():
        for s in secs:
            for m in s["modules"]:
                if m["id"] == mid:
                    return cid, s, m
    return None, None, None


# ------------------------------------------------------------ web service functions

def ws_contents(cid):
    out = []
    for s in CONTENTS.get(cid, []):
        mods = []
        for m in s["modules"]:
            mm = {"id": m["id"], "name": m["name"], "modname": m["modname"], "url": f"{BASE}/mod/{m['modname']}/view.php?id={m['id']}"}
            if m.get("contents"):
                mm["contents"] = [{**f, "fileurl": f"{BASE}/webservice/pluginfile.php/{m['id']}/mod_{m['modname']}/content/0{f['filepath']}{f['filename']}?forcedownload=1"} for f in m["contents"]]
            mods.append(mm)
        out.append({"id": s["id"], "name": s["name"], "section": s["section"], "summary": "", "modules": mods})
    return out


def ws(fn, a):
    if fn == "core_calendar_get_action_events_by_timesort":
        lo, hi = int(a.get("timesortfrom", 0)), int(a.get("timesortto", 2**31))
        return {"events": [e for e in EVENTS if lo <= e["timesort"] <= hi], "firstid": 0, "lastid": 0}
    if fn == "core_course_get_enrolled_courses_by_timeline_classification":
        return {"courses": [{**c, "viewurl": f"{BASE}/course/view.php?id={c['id']}", "courseimage": "", "progress": None,
                             "coursecategory": "Kelas Internasional"} for c in COURSES], "nextoffset": len(COURSES)}
    if fn == "message_popup_get_popup_notifications":
        items = sorted(NOTIFS, key=lambda n: -n["timecreated"])
        return {"notifications": items, "unreadcount": sum(1 for n in NOTIFS if not n["read"])}
    if fn == "core_message_mark_notification_read":
        for n in NOTIFS:
            if n["id"] == int(a["notificationid"]):
                n["read"] = True
        return {"notificationid": a["notificationid"], "warnings": []}
    if fn == "core_message_mark_all_notifications_as_read":
        for n in NOTIFS:
            n["read"] = True
        return True
    if fn == "core_course_get_contents":
        return ws_contents(int(a["courseid"]))
    if fn == "gradereport_overview_get_course_grades":
        return {"grades": [{"courseid": c["id"], "grade": GRADES.get(c["id"], "-"), "rawgrade": None} for c in COURSES + PAST], "warnings": []}
    if fn == "gradereport_user_get_grade_items":
        cid = int(a["courseid"])
        items = [{"itemname": n, "itemtype": "mod", "gradeformatted": g, "rangeformatted": "0.00–100.00", "percentageformatted": f"{g} %" if g != "-" else "-"} for n, g in GRADE_ITEMS.get(cid, [])]
        items.append({"itemname": None, "itemtype": "course", "gradeformatted": GRADES.get(cid, "-"), "rangeformatted": "0.00–100.00", "percentageformatted": f"{GRADES.get(cid)} %"})
        return {"usergrades": [{"courseid": cid, "userid": USER["id"], "gradeitems": items}], "warnings": []}
    return None


ALWAYS_AJAX = {
    "core_calendar_get_action_events_by_timesort", "core_course_get_enrolled_courses_by_timeline_classification",
    "message_popup_get_popup_notifications", "core_message_mark_notification_read", "core_message_mark_all_notifications_as_read",
}


# ------------------------------------------------------------ HTML pages

def layout(title, body, sesskey=None):
    cfg = json.dumps({"wwwroot": BASE, "sesskey": sesskey or "", "themerev": "1"} if sesskey else {"wwwroot": BASE}, separators=(",", ":"))
    user = f"""<div class="popover-region" data-userid="{USER['id']}"></div>
      <div class="usermenu"><span class="userbutton"><span class="usertext mr-1">{USER['name']}</span>
      <a href="{BASE}/user/profile.php?id={USER['id']}">Profile</a></span></div>""" if sesskey else '<a href="/login/index.php">Log in</a>'
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<script>M = {{}}; M.cfg = {cfg};</script>
<style>body{{font:15px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;background:#fff;color:#1d2125}}
header{{background:#fff;border-bottom:1px solid #dee2e6;padding:10px 24px;display:flex;justify-content:space-between;align-items:center}}
header b{{color:#0f6cbf;font-size:20px}} main{{max-width:960px;margin:0 auto;padding:24px}}
.section{{list-style:none;border-bottom:1px solid #dee2e6;padding:12px 0}} .activity{{list-style:none;padding:6px 0}}
.btn{{background:#0f6cbf;color:#fff;border:0;padding:8px 16px;border-radius:6px}} table{{border-collapse:collapse}} td,th{{border:1px solid #dee2e6;padding:6px 10px}}
.card{{border:1px solid #dee2e6;border-radius:8px;padding:16px;margin:12px 0}} img{{border-radius:8px}}</style></head>
<body><header><b>SCeLE</b><span>Fakultas Ilmu Komputer UI (test server)</span>{user}</header><main>{body}</main></body></html>"""


def page_course(cid):
    c = next((x for x in COURSES + PAST if x["id"] == cid), None)
    secs = ""
    for s in CONTENTS.get(cid, []):
        acts = ""
        for m in s["modules"]:
            mod = m["modname"]
            acts += f"""<li class="activity activity-wrapper {mod} modtype_{mod}" id="module-{m['id']}" data-for="cmitem" data-id="{m['id']}">
              <div class="activity-item"><div class="activityname">
                <a href="{BASE}/mod/{mod}/view.php?id={m['id']}" class="aalink stretched-link"><span class="instancename">{html.escape(m['name'])}<span class="accesshide "> {mod.title()}</span></span></a>
              </div></div></li>"""
        secs += f"""<li id="section-{s['section']}" class="section course-section main clearfix" data-sectionid="{s['section']}" data-for="section">
          <div class="course-section-header"><h3 class="sectionname"><a href="#">{html.escape(s['name'])}</a></h3></div>
          <ul class="section m-0 p-0 img-text" data-for="cmlist">{acts}</ul></li>"""
    return f"<h1>{html.escape(c['fullname'] if c else 'Course')}</h1><ul class='topics'>{secs}</ul>"


def page_grade_overview():
    rows = "".join(f"<tr><td class='cell c0'><a href='{BASE}/grade/report/user/index.php?id={c['id']}'>{html.escape(c['fullname'])}</a></td><td class='cell c1'>{GRADES.get(c['id'], '-')}</td></tr>" for c in COURSES + PAST)
    return f"<h1>Grades overview</h1><table id='overview-grade' class='generaltable'><thead><tr><th>Course name</th><th>Grade</th></tr></thead><tbody>{rows}</tbody></table>"


def page_user_report(cid):
    rows = "".join(f"<tr><th class='level2 column-itemname'><a href='#'>{html.escape(n)}</a></th><td class='column-grade'>{g}</td><td class='column-range'>0–100</td><td class='column-percentage'>{g + ' %' if g != '-' else '-'}</td><td class='column-feedback'></td></tr>" for n, g in GRADE_ITEMS.get(cid, []))
    rows += f"<tr><th class='level1 column-itemname category'>Course total<span class='accesshide'>Natural</span></th><td class='column-grade'>{GRADES.get(cid, '-')}</td><td class='column-range'>0–100</td><td class='column-percentage'>{GRADES.get(cid, '-')} %</td><td class='column-feedback'></td></tr>"
    return f"<h1>User report</h1><table class='generaltable user-grade'><tbody>{rows}</tbody></table>"


def page_activity(mod, mid):
    cid, s, m = find_module(mid)
    if not m:
        return "<h1>Not found</h1>"
    e = next((x for x in EVENTS if x["url"].endswith(f"id={mid}")), None)
    due = datetime.fromtimestamp(e["timesort"], JAKARTA).strftime("%A, %d %B %Y, %H:%M") if e else "No due date"
    return f"""<h1>{html.escape(m['name'])}</h1>
      <div class="card"><b>Opened:</b> Monday, 20 October 2026, 00:00<br><b>Due:</b> {due}</div>
      <div class="card"><h3>Submission status</h3><table><tr><th>Submission status</th><td>No submissions have been made yet</td></tr>
      <tr><th>Grading status</th><td>Not graded</td></tr><tr><th>Time remaining</th><td>See the due date above</td></tr></table>
      <p><button class="btn">Add submission</button></p></div>
      <p>Read the instructions in the attached PDF and submit a single zip file. Late submissions get a 10% penalty per day.</p>
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='120'%3E%3Crect width='320' height='120' fill='%23ffd200'/%3E%3Ctext x='20' y='70' font-size='28' font-family='sans-serif'%3EUniversitas Indonesia%3C/text%3E%3C/svg%3E" alt="Banner">"""


def page_my(sesskey):
    items = "".join(f"<li><a href='{BASE}/course/view.php?id={c['id']}'>{html.escape(c['fullname'])}</a></li>" for c in COURSES)
    return f"<h1>Dashboard</h1><div class='card'><h3>My courses</h3><ul>{items}</ul></div>"


LOGIN_FORM = """<h1>Log in to SCeLE</h1><form method="post" action="/login/index.php" class="card" style="max-width:360px">
<input type="hidden" name="logintoken" value="tok-{token}">
<p><label>Username<br><input name="username" id="username"></label></p>
<p><label>Password<br><input name="password" id="password" type="password"></label></p>
<p><button class="btn" id="loginbtn" type="submit">Log in</button></p></form><p>Test server: any username, password <code>pw</code>.</p>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    def session(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "MoodleSession" and v in SESSIONS:
                return v, SESSIONS[v]
        return None, None

    def send(self, body, ctype="text/html; charset=utf-8", status=200, headers=None):
        data = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, to, headers=None):
        self.send_response(303)
        self.send_header("Location", to)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        cookie, sesskey = self.session()
        if u.path in ("/", "/index.php"):
            return self.redirect("/my/")
        if u.path == "/login/index.php":
            return self.send(layout("Log in", LOGIN_FORM.format(token=secrets.token_hex(4))))
        if not sesskey:
            if u.path.startswith("/pluginfile.php"):
                return self.send(layout("Log in", LOGIN_FORM.format(token="x")), status=200)
            return self.redirect("/login/index.php")
        if u.path == "/my/":
            return self.send(layout("Dashboard", page_my(sesskey), sesskey))
        if u.path == "/course/view.php":
            return self.send(layout("Course", page_course(int(q.get("id", 0))), sesskey))
        if u.path == "/grade/report/overview/index.php":
            return self.send(layout("Grades", page_grade_overview(), sesskey))
        if u.path == "/grade/report/user/index.php":
            return self.send(layout("User report", page_user_report(int(q.get("id", 0))), sesskey))
        if u.path == "/mod/resource/view.php" and q.get("redirect"):
            cid, s, m = find_module(int(q["id"]))
            f = (m or {}).get("contents", [{}])[0]
            return self.redirect(f"/pluginfile.php/{m['id']}/mod_resource/content/0/{f.get('filename', 'file.pdf')}")
        if u.path.startswith("/mod/") and u.path.endswith("/view.php"):
            mod = u.path.split("/")[2]
            return self.send(layout("Activity", page_activity(mod, int(q.get("id", 0))), sesskey))
        if u.path.startswith("/pluginfile.php/"):
            name = u.path.rsplit("/", 1)[-1]
            return self.send(f"fake contents of {name}\n".encode(), "application/octet-stream",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
        if u.path.startswith("/message/") or u.path.startswith("/user/"):
            return self.send(layout("Page", "<h1>Page</h1>", sesskey))
        return self.send(layout("Not found", "<h1>Not found</h1>", sesskey), status=404)

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        if u.path == "/login/index.php":
            form = {k: v[0] for k, v in parse_qs(raw).items()}
            if form.get("password") != "pw" or not form.get("logintoken"):
                return self.send(layout("Log in", "<p style='color:#c00'>Invalid login, please try again</p>" + LOGIN_FORM.format(token="x")))
            cookie = secrets.token_hex(12)
            SESSIONS[cookie] = secrets.token_hex(5)
            return self.redirect("/my/", {"Set-Cookie": f"MoodleSession={cookie}; Path=/; HttpOnly"})
        if u.path == "/lib/ajax/service.php":
            cookie, sesskey = self.session()
            call = json.loads(raw)[0]
            fn = call["methodname"]
            if not sesskey or q.get("sesskey") != sesskey:
                return self.send([{"error": True, "exception": {"message": "Course or activity not accessible. (You are not logged in)", "errorcode": "servicerequireslogin"}}], "application/json")
            if LIMITED and fn not in ALWAYS_AJAX:
                return self.send([{"error": True, "exception": {"message": "Web service is not available. (It doesn't exist or might not be enabled.)", "errorcode": "servicenotavailable"}}], "application/json")
            res = ws(fn, call.get("args", {}))
            if res is None:
                return self.send([{"error": True, "exception": {"message": "Unknown function", "errorcode": "invalidrecord"}}], "application/json")
            return self.send([{"error": False, "data": res}], "application/json")
        if u.path == "/__dev/add-material":
            cid = int(q.get("course", 101))
            n = sum(1 for s in CONTENTS[cid] for m in s["modules"] if m["modname"] == "resource")
            m = add_module(cid, len(CONTENTS[cid]) - 1, {"id": nid(), "name": q.get("name", f"Slides: Midterm review part {n}"), "modname": "resource",
                                                          "contents": [file(q.get("file", "Midterm review.pdf"), 2_400_000, 0)]})
            return self.send({"added": m["id"]}, "application/json")
        if u.path == "/__dev/add-notification":
            n = {"id": max(x["id"] for x in NOTIFS) + 1, "subject": q.get("subject", "OS KI: Lab 4 clarification"),
                 "smallmessage": "Untuk Lab 4, gunakan algoritma Round Robin dengan quantum 4ms.", "contexturl": f"{BASE}/mod/forum/discuss.php?d=78",
                 "timecreated": int(time.time()), "read": False, "component": "mod_forum"}
            NOTIFS.append(n)
            return self.send(n, "application/json")
        if u.path == "/__dev/logout":
            SESSIONS.clear()
            return self.send({"ok": True}, "application/json")
        return self.send({"error": "not found"}, "application/json", status=404)


if __name__ == "__main__":
    print(f"Fake SCeLE on {BASE} ({'limited API' if LIMITED else 'full API'})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
