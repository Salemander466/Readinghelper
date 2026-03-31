import uvicorn

from backend.app import app
from backend.config import settings


if __name__ == '__main__':
    uvicorn.run(app, host=settings.app_host, port=settings.app_port)
