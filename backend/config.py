from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # Default to SQLite so the app starts without any setup.
    # Override via DATABASE_URL env var or .env file for PostgreSQL.
    DATABASE_URL: str = "sqlite+aiosqlite:///./eco3d.db"
    WEIGHTS_DIR: str = str(Path(__file__).parent.parent / "training" / "weights")
    SATELLITE_TILE_SIZE: int = 512
    MAX_TILES_PER_REQUEST: int = 4
    OPENWEATHER_API_KEY: str = ""
    MAPBOX_TOKEN: str = ""
    ENVIRONMENT: str = "development"

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
