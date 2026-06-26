"""Drive a lucarne session from Python (stdlib client + Playwright for CDP).

Run a daemon first:  npx lucarne serve
then:  pip install playwright && python examples/python_drive.py

The stdlib client (clients/python/lucarne.py) speaks the control API; the cdpUrl
it returns is driven with any CDP client — here, Playwright for Python.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "clients", "python"))
from lucarne import LucarneClient  # noqa: E402

lucarne = LucarneClient(
    base_url=os.environ.get("LUCARNE_URL", "http://127.0.0.1:7800"),
    token=os.environ.get("LUCARNE_TOKEN"),
)

session = lucarne.create(profile="demo-py", backend="native")
print("session:", session["id"], "watch:", session["viewUrl"])

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(session["cdpUrl"])
    page = browser.contexts[0].pages[0]
    page.goto("https://example.com", wait_until="domcontentloaded")
    print("title:", page.title())
    browser.close()  # detaches; the session keeps running
