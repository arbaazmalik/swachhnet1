import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN
import pickle
import os
from utils.config_loader import load_config
from utils.logger import get_logger

logger = get_logger(__name__)

try:
    config = load_config()
except Exception as e:
    logger.error(f"Failed to load configuration: {e}")
    config = {}

class GeoHotspotService:
    def __init__(self):
        hotspot_config = config.get('hotspot', {})
        self.eps = hotspot_config.get('eps', 0.005) # approx 500m in lat/long depending on region
        self.min_samples = hotspot_config.get('min_samples', 5)
        self.metric = hotspot_config.get('metric', 'haversine')
        
    def _convert_to_radians(self, coordinates):
        """Converts lat/long to radians for haversine metric."""
        return np.radians(coordinates)
        
    def detect_hotspots(self, coordinates_list):
        """
        Takes a list of dicts [{'lat': float, 'long': float}] and returns cluster assignments.
        """
        if not coordinates_list:
            logger.warning("Empty coordinates list provided for hotspot detection.")
            return {"clusters": [], "noise": []}
            
        try:
            # Extract coordinates into numpy array
            coords_array = np.array([[point['lat'], point['long']] for point in coordinates_list])
            
            # For haversine metric, sklearn expects coordinates in radians [lat, lon]
            # and eps in radians (distance in km / Earth's radius 6371.0 km).
            if self.metric == 'haversine':
                # Convert eps from degrees (~111km per deg) to radians
                eps_km = self.eps * 111.0 if self.eps < 0.1 else self.eps
                eps_rad = eps_km / 6371.0
                coords_input = self._convert_to_radians(coords_array)
                metric_to_use = 'haversine'
                effective_eps = eps_rad
            else:
                coords_input = coords_array
                metric_to_use = 'euclidean'
                effective_eps = self.eps

            clustering = DBSCAN(
                eps=effective_eps, 
                min_samples=self.min_samples, 
                metric=metric_to_use
            ).fit(coords_input)
            
            labels = clustering.labels_
            
            clusters = {}
            noise = []
            
            for i, label in enumerate(labels):
                point = coordinates_list[i]
                if label == -1:
                    noise.append(point)
                else:
                    cluster_id = str(label)
                    if cluster_id not in clusters:
                        clusters[cluster_id] = {
                            "center": {"lat": 0.0, "long": 0.0},
                            "points": [],
                            "count": 0
                        }
                    
                    clusters[cluster_id]["points"].append(point)
                    clusters[cluster_id]["count"] += 1
                    
            # Calculate centers for clusters
            for cluster_id, data in clusters.items():
                pts = np.array([[p['lat'], p['long']] for p in data['points']])
                center = np.mean(pts, axis=0)
                data['center'] = {"lat": round(center[0], 6), "long": round(center[1], 6)}
                
            logger.info(f"Hotspot detection complete. Found {len(clusters)} clusters and {len(noise)} noise points.")
            
            return {
                "clusters": list(clusters.values()),
                "total_clusters": len(clusters),
                "noise_points": noise,
                "total_noise": len(noise)
            }
            
        except Exception as e:
            logger.error(f"Error during hotspot detection: {e}")
            raise

geo_service = GeoHotspotService()
