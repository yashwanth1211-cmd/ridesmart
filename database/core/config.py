import os


class Settings:
    APP_NAME: str = "RideSmart API"
    APP_VERSION: str = "1.0.0"
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "sqlite:///./ridesmart.db",
    )


settings = Settings()