const { Schema, model } = require('mongoose');

const ISSUE_TYPES = [
  'full_dustbin','illegal_dumping','burning_waste',
  'missed_collection','overflowing_bin','stray_animal_waste','other',
];

const complaintSchema = new Schema({
  userId:    { type: Schema.Types.ObjectId, ref: 'User' },
  wardId:    { type: Schema.Types.ObjectId, ref: 'Ward' },
  issueType: { type: String, required: true, enum: ISSUE_TYPES },
  status:    { type: String, enum: ['pending','assigned','in_progress','resolved','rejected'], default: 'pending' },
  priority:  { type: Number, min: 1, max: 3, default: 1 },
  imageUrl:  { type: String },
  location: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  address:       { type: String },
  description:   { type: String },
  rejectionNote: { type: String },
  upvotes:       { type: Number, default: 0 },
  resolvedAt:    { type: Date },

  classificationStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },

  // Embedded AI result (denormalized for speed)
  aiResult: {
    status:       { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
    wasteType:    String,
    confidence:   Number,
    modelVersion: String,
    allScores:    Schema.Types.Mixed,
    processedAt:  Date,
  },

  // Embedded assignment history
  assignments: [{
    workerId:    { type: Schema.Types.ObjectId, ref: 'Worker' },
    assignedBy:  { type: Schema.Types.ObjectId, ref: 'User' },
    status:      { type: String, enum: ['assigned','accepted','in_progress','completed','reassigned'], default: 'assigned' },
    notes:       String,
    assignedAt:  { type: Date, default: Date.now },
    acceptedAt:  Date,
    completedAt: Date,
  }],
}, { timestamps: true });

complaintSchema.index({ wardId: 1 });
complaintSchema.index({ status: 1 });
complaintSchema.index({ priority: -1 });
complaintSchema.index({ createdAt: -1 });
complaintSchema.index({ location: '2dsphere' });
complaintSchema.index({ userId: 1, createdAt: -1 });

module.exports = model('Complaint', complaintSchema);
