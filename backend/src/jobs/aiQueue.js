const Bull      = require('bull');
const Complaint = require('../models/Complaint');
const logger    = require('../utils/logger');
const aiService = require('../services/aiService');

const aiQueue = new Bull('ai-classification', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379',
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
});

const { emitRealtimeEvent } = require('../services/socketService');

aiQueue.process('classify_waste', 5, async (job) => {
  const { complaintId, imageUrl } = job.data;
  logger.info(`Processing AI classification for complaint ${complaintId}`);

  await Complaint.findByIdAndUpdate(complaintId, {
    'aiResult.status': 'processing',
  });

  const prediction = await aiService.classifyFromUrl(imageUrl);
  const { class: label, confidence, probabilities, model_version } = prediction;

  const complaint = await Complaint.findByIdAndUpdate(
    complaintId,
    {
      aiResult: {
        status:       'completed',
        wasteType:    label,
        confidence,
        modelVersion: model_version || 'mobilenet_v2-v1',
        allScores:    probabilities,
        processedAt:  new Date(),
      },
    },
    { new: true }
  );

  if (complaint) {
    emitRealtimeEvent({
      event: 'complaint.updated',
      data: complaint,
      wardId: complaint.wardId,
      userId: complaint.userId,
    });
  }

  logger.info(`AI result saved: ${label} (${confidence}) for complaint ${complaintId}`);
});

aiQueue.on('failed', async (job, err) => {
  logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);
  if (job.data?.complaintId) {
    try {
      const complaint = await Complaint.findByIdAndUpdate(
        job.data.complaintId,
        {
          'aiResult.status': 'failed',
          'aiResult.processedAt': new Date(),
        },
        { new: true }
      );
      if (complaint) {
        emitRealtimeEvent({
          event: 'complaint.updated',
          data: complaint,
          wardId: complaint.wardId,
          userId: complaint.userId,
        });
      }
    } catch (e) {
      logger.error('Failed to update complaint AI failure state:', e.message);
    }
  }
});

async function queueAIClassification(data) {
  return aiQueue.add('classify_waste', data);
}

module.exports = { aiQueue, queueAIClassification };
