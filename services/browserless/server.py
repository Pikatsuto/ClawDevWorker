"""
browserless/server.py — Serveur HTTP de fetch de pages via nodriver (Chrome undetected)

Endpoint :
  GET /content?url=<url>&timeout=<ms>
  → Retourne le contenu texte de la page (HTML strippé des scripts/styles)

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

# Pool de browsers (un seul suffit, les tabs sont isolés)
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
    """Strip scripts, styles et balises HTML — retourne du texte brut."""
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
    url: str = Query(..., description="URL à fetcher"),
    timeout: int = Query(8000, description="Timeout en ms")
):
    url = unquote(url)
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL invalide")

    try:
        browser = await get_browser()
        tab = await browser.get(url)

        # Attendre que la page soit chargée (max timeout/1000 secondes)
        await asyncio.sleep(min(timeout / 1000, 5))

        html = await tab.get_content()
        await tab.close()

        text = strip_html(html)
        # Tronquer à 50k chars max
        return text[:50000]

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
