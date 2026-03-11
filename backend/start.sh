#!/bin/bash
echo "=== Finding Python ==="
which python || echo "python not in PATH"
which python3 || echo "python3 not in PATH"
which uvicorn || echo "uvicorn not in PATH"

echo "=== Searching for uvicorn ==="
find / -name "uvicorn" -type f 2>/dev/null | head -5

echo "=== Searching for python ==="
find / -name "python*" -type f 2>/dev/null | grep -v "__pycache__" | head -10

echo "=== PATH ==="
echo $PATH

echo "=== Starting app ==="
python3 -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
