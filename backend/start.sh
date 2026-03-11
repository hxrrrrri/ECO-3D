#!/bin/bash
# Activate venv if it exists, otherwise use system Python
if [ -f /app/.venv/bin/activate ]; then
  echo "=== Activating venv ==="
  source /app/.venv/bin/activate
  uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
else
  echo "=== Using mise Python directly ==="
  /mise/installs/python/3.13.12/bin/pip install -r requirements.prod.txt --quiet
  /mise/installs/python/3.13.12/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
fi
