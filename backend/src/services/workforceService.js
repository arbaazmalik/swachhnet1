const Worker = require('../models/Worker');

/**
 * Calculates the Haversine distance between two points in km.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Finds the best worker for a given complaint based on:
 * 1. Status (must be 'available')
 * 2. Ward (must match complaint ward if set)
 * 3. Distance (nearer is better via Haversine formula)
 * 4. Load (fewer assigned tasks is better)
 */
async function findBestWorker(complaint) {
  if (!complaint?.location?.coordinates) return null;
  const [lng, lat] = complaint.location.coordinates;
  const wardId = complaint.wardId;

  const filter = { status: 'available' };
  if (wardId) filter.wardId = wardId;

  const availableWorkers = await Worker.find(filter).lean();
  if (!availableWorkers.length) return null;

  const candidates = availableWorkers.map(worker => {
    const [wLng, wLat] = worker.currentLocation?.coordinates || [0, 0];
    const distance = calculateDistance(lat, lng, wLat, wLng);
    const currentLoad = (worker.assignedTasks || []).length;
    
    // Transparent scoring formula: (Distance in KM * 10) + (Assigned tasks * 5)
    // Lower score indicates higher assignment priority.
    const score = Number(((distance * 10) + (currentLoad * 5)).toFixed(2));
    const reason = `Available worker with low load (${currentLoad} tasks, ${distance.toFixed(2)}km away)`;

    return { ...worker, distance, score, reason };
  });

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

module.exports = {
  calculateDistance,
  findBestWorker,
};
