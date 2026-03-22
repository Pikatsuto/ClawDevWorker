# docker-exec

Executes code in an isolated ephemeral Docker container.

## Behavior

- The container is launched with `docker run --rm` — automatically destroyed after execution
- Network: `none` by default — no internet access, no access to internal services
- Code is passed via stdin or a temporary file mounted as a volume
- stdout and stderr are returned to the agent
- If the container exceeds the timeout, it is killed (`docker kill`)

## Available images (pre-pulled)

- `python:3.12-slim` — Python 3.12
- `node:22-slim` — Node.js 22
- `ubuntu:24.04` — Bash, standard GNU tools
- `bash:5` — Ultra-lightweight Bash

## Usage

```
Write and execute a Python script:
1. Create the file /tmp/script.py with the desired content
2. Call docker-exec with image=python:3.12-slim, file=/tmp/script.py

Execute a Bash command:
1. Call docker-exec with image=bash:5, command="echo hello"
```

## Security

- `--network none` — no network access
- `--read-only` — read-only filesystem except /tmp
- `--memory ${EPHEMERAL_MEMORY}` — RAM limit
- `--cpus ${EPHEMERAL_CPUS}` — CPU limit
- Timeout: `${EPHEMERAL_TIMEOUT}s`
- No access to the host's Docker socket (internal rootless DinD)
