from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
from contextlib import asynccontextmanager
from utils.config_loader import load_config
from utils.logger import get_logger
from services.image_service import image_service

logger = get_logger(__name__)

# Load config
try:
    config = load_config()
    logger.info("Configuration loaded successfully.")
except Exception as e:
    logger.error(f"Failed to load configuration: {e}")
    config = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing AI service model startup sequence...")
    try:
        loaded = image_service.load_model()
        if loaded:
            logger.info("MobileNetV2 Waste Classifier model READY.")
        else:
            logger.warn("MobileNetV2 Waste Classifier model UNAVAILABLE on startup.")
    except Exception as e:
        logger.error(f"Error during startup model initialization: {e}")
    yield

app = FastAPI(
    title="EcoIntellect AI Backend",
    description="AI/ML Backend for Waste Management System",
    version="1.0.0",
    lifespan=lifespan
)

# CORS Middleware
cors_origins = os.getenv("AIML_ALLOWED_ORIGINS", "*")
allow_origins = [origin.strip() for origin in cors_origins.split(",") if origin.strip()] or ["*"]
allow_credentials = "*" not in allow_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"message": "Welcome to EcoIntellect AI Backend"}

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "classifier_ready": image_service.is_ready,
        "device": str(image_service.device)
    }

@app.get("/ready")
async def readiness_check():
    return {
        "ready": image_service.is_ready,
        "classifier_status": "READY" if image_service.is_ready else "UNAVAILABLE",
        "model_version": image_service.model_version
    }

from api.routes import router as api_router
app.include_router(api_router, prefix="/api/v1")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

