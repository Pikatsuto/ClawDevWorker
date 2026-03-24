#!/bin/sh

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &

sleep 1
uvicorn server:app --host 0.0.0.0 --port 3000