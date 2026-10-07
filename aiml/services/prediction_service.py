from datetime import datetime, timedelta

import numpy as np

from utils.config_loader import load_config
from utils.logger import get_logger

logger = get_logger(__name__)

try:
    config = load_config()
except Exception as e:
    logger.error(f"Failed to load configuration: {e}")
    config = {}


class PredictionService:
    def __init__(self):
        pred_config = config.get("prediction", {})
        self.forecast_days = pred_config.get("forecast_days", 30)

    def _prepare_series(self, historical_data: list) -> np.ndarray:
        values = [float(item.get("value", 0.0)) for item in historical_data]
        if not values or len(values) < 7:
            raise ValueError("Not enough historical data for a reliable forecast.")
        return np.array(values, dtype=float)

    def _forecast_values(self, series: np.ndarray, days: int) -> list[dict]:
        # Exponentially weighted baseline + linear recent trend.
        n = len(series)
        weights = np.exp(np.linspace(-1.0, 0.0, n))
        weights = weights / weights.sum()
        baseline = float(np.dot(series, weights))

        recent = series[-min(7, n):]
        x = np.arange(len(recent))
        slope = float(np.polyfit(x, recent, 1)[0]) if len(recent) > 1 else 0.0

        vol = float(np.std(recent)) if len(recent) > 1 else max(1.0, baseline * 0.05)
        start_date = datetime.utcnow().date() + timedelta(days=1)

        forecast = []
        for day in range(days):
            yhat = max(0.0, baseline + slope * (day + 1))
            margin = max(1.0, vol * 1.5)
            forecast.append({
                "date": (start_date + timedelta(days=day)).strftime("%Y-%m-%d"),
                "predicted_value": round(yhat, 2),
                "lower_bound": round(max(0.0, yhat - margin), 2),
                "upper_bound": round(yhat + margin, 2),
            })
        return forecast

    def predict_trend(self, historical_data: list = None, forecast_days: int = None):
        days = int(forecast_days or self.forecast_days)
        if days < 1 or days > 365:
            raise ValueError("forecast_days must be between 1 and 365")

        series = self._prepare_series(historical_data or [])
        result = self._forecast_values(series, days)
        logger.info(f"Generated lightweight trend forecast for {days} days.")
        return result


prediction_service = PredictionService()
