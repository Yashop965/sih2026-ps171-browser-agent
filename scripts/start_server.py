# Start Server Script
# Run this from project root: python scripts/start_server.py

import subprocess
import sys
import os

# Add current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Start the server
print("Starting SIH2026 Browser Agent Server...")
print("Server will run at: http://localhost:8000")
print("Press Ctrl+C to stop")
print("=" * 50)

# Run uvicorn directly
subprocess.run([
    sys.executable, "-m", "uvicorn", "server.main:app",
    "--host", "0.0.0.0",
    "--port", "8000",
    "--reload"
], env={**os.environ, "PYTHONPATH": "."})
