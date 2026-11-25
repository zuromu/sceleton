"""Tests for the command line tool, run against the fake SCeLE in mock_scele.py.

    python3 mock_scele.py &
    python3 -m unittest test_cli
"""

import os
import sys
import tempfile
import unittest
import urllib.request
from argparse import Namespace
from pathlib import Path

MOCK = "http://127.0.0.1:8765"
os.environ["SCELE_URL"] = MOCK
os.environ["SCELE_HOME"] = tempfile.mkdtemp(prefix="scele-cli-home-")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "cli"))
import scele  # noqa: E402


def dev(path):
    urllib.request.urlopen(urllib.request.Request(f"{MOCK}/__dev/{path}", method="POST")).read()


def login():
    session = scele.new_session()
    sesskey, uid = scele.web_login(session, "ahmad.hoesin", "pw")
    return scele.Client({"mode": "web", "username": "ahmad.hoesin", "sesskey": sesskey,
                         "cookies": session.cookies.get_dict(), "userid": uid})


class NamesTest(unittest.TestCase):
    def test_a_long_name_keeps_its_extension(self):
        name = scele.safe_name("Lecture notes " * 7 + "final.pdf")
        self.assertLessEqual(len(name), 80)
        self.assertTrue(name.endswith(".pdf"))


class TokenTest(unittest.TestCase):
    def test_a_failed_download_does_not_print_the_token(self):
        cli = login()
        cli.mode, cli.cfg["token"] = "token", "SECRET-TOKEN"
        cli.call = lambda fn, **p: [{"name": "Week 1", "modules": [{"modname": "resource", "name": "Slides", "contents": [
            {"type": "file", "filename": "missing.pdf", "filesize": 10, "timemodified": 1,
             "fileurl": f"{MOCK}/webservice/pluginfile.php/1/mod_resource/content/0/missing.pdf"}]}]}]
        cli.s.get = lambda url, **kw: (_ for _ in ()).throw(scele.requests.HTTPError(f"404 for url: {url}", response=scele.requests.Response()))
        with scele.console.capture() as out:
            scele.cmd_sync(cli, Namespace(to=tempfile.mkdtemp(), course="PBP", dry_run=False))
        self.assertIn("failed", out.get())
        self.assertNotIn("SECRET-TOKEN", out.get())


class LoginTest(unittest.TestCase):
    def test_a_wrong_password_is_refused(self):
        with self.assertRaises(scele.SceleError):
            scele.web_login(scele.new_session(), "ahmad.hoesin", "wrong")


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.cli = login()
        self.root = Path(tempfile.mkdtemp(prefix="scele-cli-files-"))

    def sync(self):
        with scele.console.capture() as out:
            scele.cmd_sync(self.cli, Namespace(to=str(self.root), course="PBP", dry_run=False))
        return out.get()

    def slides(self):
        return self.root / "PBP KI" / "Week 1 - Web and Django basics" / "W01 Web and Django basics.pdf"

    def test_a_file_you_edited_is_not_replaced(self):
        self.sync()
        self.slides().write_text("my highlights")
        self.sync()
        self.assertEqual(self.slides().read_text(), "my highlights")

    def test_a_copy_of_unknown_origin_is_never_replaced(self):
        self.sync()
        (self.root / scele.SYNC_RECORD).unlink()
        self.slides().write_text("my highlights")
        self.sync()
        self.assertEqual(self.slides().read_text(), "my highlights")
        self.assertTrue(self.slides().with_name("W01 Web and Django basics (new).pdf").exists())

    def test_same_name_in_one_section_keeps_both(self):
        dev("add-material?course=101&name=Part%20A&file=Same%20name.pdf")
        dev("add-material?course=101&name=Part%20B&file=Same%20name.pdf")
        self.sync()
        section = next(self.root.glob("PBP KI/Week 8*"))
        self.assertTrue((section / "Same name.pdf").exists())
        self.assertTrue((section / "Same name (2).pdf").exists())
        self.assertIn("Downloaded 0 new", self.sync())


if __name__ == "__main__":
    unittest.main()
