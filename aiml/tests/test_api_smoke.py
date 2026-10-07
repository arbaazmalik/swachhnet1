import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from main import app  # noqa: E402


class TestAIMLAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_endpoint(self):
        resp = self.client.get('/health')
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body['status'], 'ok')
        self.assertIn('classifier_ready', body)

    def test_predict_waste_rejects_non_image(self):
        resp = self.client.post(
            '/api/v1/predict-waste',
            files={'file': ('bad.txt', b'hello', 'text/plain')},
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()['detail'], 'File must be an image.')

    def test_predict_waste_rejects_empty_image(self):
        resp = self.client.post(
            '/api/v1/predict-waste',
            files={'file': ('empty.png', b'', 'image/png')},
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()['detail'], 'Empty image file.')

    @patch('api.routes.image_service.predict')
    def test_predict_waste_success_shape(self, mock_predict):
        mock_predict.return_value = {
            'waste_type': 'plastic',
            'class': 'plastic',
            'confidence': 0.91,
            'is_confident': True,
            'probabilities': {
                'wet': 0.01,
                'dry': 0.05,
                'plastic': 0.91,
                'hazardous': 0.03,
            },
        }

        resp = self.client.post(
            '/api/v1/predict-waste',
            files={'file': ('ok.png', b'fake-image-bytes', 'image/png')},
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body['waste_type'], 'plastic')
        self.assertEqual(body['class'], 'plastic')
        self.assertIn('confidence', body)
        self.assertIn('probabilities', body)
        mock_predict.assert_called_once()

    @patch('api.routes.geo_service.detect_hotspots')
    def test_detect_hotspot_success(self, mock_detect):
        mock_detect.return_value = {
            'clusters': [
                {
                    'center': {'lat': 12.9717, 'long': 77.5947},
                    'points': [
                        {'lat': 12.9716, 'long': 77.5946},
                        {'lat': 12.9718, 'long': 77.5948},
                    ],
                    'count': 2,
                }
            ],
            'total_clusters': 1,
            'noise_points': [],
            'total_noise': 0,
        }

        resp = self.client.post(
            '/api/v1/detect-hotspot',
            json={
                'coordinates': [
                    {'lat': 12.9716, 'long': 77.5946},
                    {'lat': 12.9718, 'long': 77.5948},
                ]
            },
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body['total_clusters'], 1)
        self.assertEqual(body['total_noise'], 0)
        mock_detect.assert_called_once()

    @patch('api.routes.prediction_service.predict_trend')
    def test_predict_trend_success(self, mock_predict_trend):
        mock_predict_trend.return_value = [
            {
                'date': '2026-03-28',
                'predicted_value': 11.2,
                'lower_bound': 9.7,
                'upper_bound': 12.8,
            },
            {
                'date': '2026-03-29',
                'predicted_value': 11.5,
                'lower_bound': 10.0,
                'upper_bound': 13.0,
            },
        ]

        resp = self.client.post(
            '/api/v1/predict-trend',
            json={
                'historical_data': [
                    {'date': '2026-03-20', 'value': 10.0, 'location': 'zone-a'},
                    {'date': '2026-03-21', 'value': 10.5, 'location': 'zone-a'},
                ],
                'forecast_days': 2,
            },
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn('forecast', body)
        self.assertEqual(len(body['forecast']), 2)
        mock_predict_trend.assert_called_once()


if __name__ == '__main__':
    unittest.main()
