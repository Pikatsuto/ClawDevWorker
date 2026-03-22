"""
browserless/server.py — HTTP server for fetching pages via nodriver (Chrome undetected)

Endpoint:
  GET /content?url=<url>&timeout=<ms>
  → Returns the text content of the page (HTML stripped of scripts/styles)

  GET /health
  → {"status": "ok"}
"""

import asyncio
import re
from urllib.parse import unquote

import nodriver as uc
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import PlainTextResponse

app = FastAPI(title="browserless-nodriver", version="1.0.0")

# Browser pool (one is enough, tabs are isolated)
_browser = None
_browser_lock = asyncio.Lock()


async def get_browser():
    global _browser
    async with _browser_lock:
        if _browser is None:
            _browser = await uc.start(
                headless=True,
                browser_args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--window-size=1280,720",
                ]
            )
    return _browser


def strip_html(html: str) -> str:
    """Strip scripts, styles and HTML tags — returns plain text."""
    html = re.sub(r'<script[^>]*>[\s\S]*?</script>', ' ', html, flags=re.IGNORECASE)
    html = re.sub(r'<style[^>]*>[\s\S]*?</style>', ' ', html, flags=re.IGNORECASE)
    html = re.sub(r'<[^>]+>', ' ', html)
    html = re.sub(r'\s+', ' ', html)
    return html.strip()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/content", response_class=PlainTextResponse)
async def fetch_content(
    url: str = Query(..., description="URL to fetch"),
    timeout: int = Query(8000, description="Timeout in ms")
):
    url = unquote(url)
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL")

    try:
        browser = await get_browser()
        tab = await browser.get(url)

        # Wait for the page to load (max timeout/1000 seconds)
        await asyncio.sleep(min(timeout / 1000, 5))

        html = await tab.get_content()
        await tab.close()

        text = strip_html(html)
        # Truncate to 50k chars max
        return text[:50000]

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
