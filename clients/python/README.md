# lucarne (Python client)

Python client for **[lucarne](https://github.com/volter-ai/lucarne)** — self-hostable
browser sessions you can drive (CDP/Playwright), watch + control (porthole), and record,
on your own machine and your own IP.

This package is the **client**. The engine is a Node daemon — install and run it
separately (`npm install -g lucarne && lucarne serve`); you talk to it over HTTP, and
drive the browser over CDP with Playwright.

```sh
pip install lucarne playwright
```

```python
from lucarne import LucarneClient
from playwright.sync_api import sync_playwright

luc = LucarneClient("http://127.0.0.1:7800")          # token="..." if the daemon needs one
s = luc.create(profile="demo", backend="native")
print("watch:", s["viewUrl"])

with sync_playwright() as p:
    page = p.chromium.connect_over_cdp(s["cdpUrl"]).contexts[0].pages[0]
    page.goto("https://example.com", wait_until="domcontentloaded")
    print(page.title())
```

The client is stdlib-only (no dependencies) and covers
`health / create / list / get / destroy / act / content`. For the rest of the API, call
the HTTP endpoints directly — see the [OpenAPI spec](https://github.com/volter-ai/lucarne)
at `/openapi.json`. MIT © Aaron Volter.
