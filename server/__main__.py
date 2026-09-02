import sys
from pathlib import Path

# Add the server directory to the Python path so relative imports work
server_dir = Path(__file__).parent.resolve()
if str(server_dir) not in sys.path:
    sys.path.insert(0, str(server_dir))

from main import app
from uvicorn import run

if __name__ == "__main__":
    run(app, host="0.0.0.0", port=8000, log_level="info")
