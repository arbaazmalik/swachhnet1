import os
import torch
from pathlib import Path
from torchvision import transforms
from PIL import Image
import io
from utils.config_loader import load_config, resolve_from_base
from utils.logger import get_logger
from torchvision import models
import torch.nn as nn

logger = get_logger(__name__)

try:
    config = load_config()
except Exception as e:
    logger.error(f"Failed to load configuration: {e}")
    config = {}

class ImageClassificationService:
    def __init__(self):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        
        classifier_config = config.get('classifier', {})
        self.classes = classifier_config.get('classes', ["wet", "dry", "plastic", "hazardous"])
        self.image_size = tuple(classifier_config.get('image_size', [224, 224]))
        self.norm_mean = classifier_config.get('norm_mean', [0.485, 0.456, 0.406])
        self.norm_std = classifier_config.get('norm_std', [0.229, 0.224, 0.225])
        self.confidence_threshold = classifier_config.get('confidence_threshold', 0.60)
        
        # Define image transforms
        self.transform = transforms.Compose([
            transforms.Resize(self.image_size),
            transforms.ToTensor(),
            transforms.Normalize(mean=self.norm_mean, std=self.norm_std),
        ])
        
        # Load model lazily
        self.model = None

    def _build_model(self, num_classes: int):
        model = models.mobilenet_v2(weights=None)
        in_features = model.classifier[1].in_features
        model.classifier[1] = nn.Linear(in_features, num_classes)
        return model

    def _resolve_model_path(self) -> str | None:
        env_path = os.getenv('WASTE_MODEL_PATH')
        if env_path and Path(env_path).exists():
            return env_path

        configured = resolve_from_base(config.get('model_paths', {}).get('waste_classifier'))
        if configured and Path(configured).exists():
            return configured

        candidates = [
            resolve_from_base("models/waste_classifier/best_model.pth"),
            resolve_from_base("models/waste_classifier/model.pth"),
        ]
        for candidate in candidates:
            if candidate and Path(candidate).exists():
                return candidate
        return None

    def is_ready(self) -> bool:
        if self.model is not None:
            return True
        try:
            self._load_model()
            return self.model is not None
        except Exception:
            return False

    def get_status(self) -> dict:
        ready = self.is_ready()
        return {
            "ready": ready,
            "classes": self.classes if ready else [],
            "device": str(self.device),
            "model_architecture": config.get('classifier', {}).get('model_architecture', 'mobilenet_v2'),
            "model_version": "swachhanet-ai-v1"
        }

    def _load_model(self):
        if self.model is None:
            model_path = self._resolve_model_path()
            if not model_path or not Path(model_path).exists():
                raise FileNotFoundError(
                    "Waste classifier weights not found. Train the model or place weights at "
                    "aiml/models/waste_classifier/model.pth"
                )
            try:
                checkpoint = torch.load(model_path, map_location=self.device)
                if isinstance(checkpoint, dict) and checkpoint.get("model_state_dict"):
                    if checkpoint.get("class_names"):
                        self.classes = checkpoint["class_names"]
                    if checkpoint.get("image_size"):
                        self.image_size = tuple(checkpoint["image_size"])
                    if checkpoint.get("norm_mean"):
                        self.norm_mean = checkpoint["norm_mean"]
                    if checkpoint.get("norm_std"):
                        self.norm_std = checkpoint["norm_std"]
                    self.transform = transforms.Compose([
                        transforms.Resize(self.image_size),
                        transforms.ToTensor(),
                        transforms.Normalize(mean=self.norm_mean, std=self.norm_std),
                    ])
                    self.model = self._build_model(num_classes=len(self.classes))
                    self.model.load_state_dict(checkpoint["model_state_dict"])
                else:
                    # Backward compatibility for plain state_dict format.
                    self.model = self._build_model(num_classes=len(self.classes))
                    self.model.load_state_dict(checkpoint)
                self.model.to(self.device)
                self.model.eval()
                logger.info("Waste classifier model loaded for inference.")
            except Exception as e:
                logger.error(f"Failed to load model from {model_path}: {e}")
                raise RuntimeError(f"Failed to load waste classifier model: {e}") from e

    def process_image(self, image_bytes: bytes):
        """Preprocesses the image bytes for the model."""
        if not image_bytes:
            raise ValueError("Image bytes are empty.")
        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            return self.transform(image).unsqueeze(0).to(self.device)
        except Exception as e:
            logger.error(f"Error in image preprocessing: {e}")
            raise ValueError("Invalid image format.")

    def predict(self, image_bytes: bytes) -> dict:
        """Runs inference on the provided image bytes."""
        self._load_model()
        try:
            input_tensor = self.process_image(image_bytes)
            with torch.no_grad():
                outputs = self.model(input_tensor)
                probabilities = torch.nn.functional.softmax(outputs[0], dim=0)
                top_prob, top_class_idx = torch.max(probabilities, 0)

                confidence = top_prob.item()
                predicted_class = self.classes[top_class_idx.item()]
                result = {
                    "waste_type": predicted_class,
                    "class": predicted_class,
                    "confidence": round(confidence, 4),
                    "is_confident": confidence >= self.confidence_threshold,
                    "probabilities": {cls: round(prob.item(), 4) for cls, prob in zip(self.classes, probabilities)},
                }
                logger.info(f"Inference complete: {result['class']} ({result['confidence']*100:.2f}%)")
                return result
        except Exception as e:
            logger.error(f"Inference failure: {e}")
            raise RuntimeError(f"Inference failed: {e}") from e

# Singleton instance
image_service = ImageClassificationService()
