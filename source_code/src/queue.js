'use strict';

const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const redisOptions = {
  maxRetriesPerRequest: null,
};

const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOptions);

// ── Export Queue ──────────────────────────────────────────────────────────────
const exportQueue = new Queue('export-jobs', { connection });

/**
 * Adds a new export job to the queue.
 * @param {object} jobData
 * @returns {Promise<string>} exportId
 */
async function addExportJob(jobData) {
  const exportId = uuidv4();
  
  // Set default state values for the client to poll immediately
  jobData.exportId = exportId;
  jobData.status = 'pending';
  jobData.progress = { totalRows: 0, processedRows: 0, percentage: 0 };
  jobData.createdAt = new Date().toISOString();
  jobData.completedAt = null;
  jobData.error = null;

  // Enqueue job with the exportId as the Job ID for easy lookup
  await exportQueue.add('export-csv', jobData, { jobId: exportId });
  return exportId;
}

/**
 * Gets the current status of a job from Redis/BullMQ.
 * @param {string} exportId
 * @returns {Promise<object|null>}
 */
async function getJobStatus(exportId) {
  const job = await exportQueue.getJob(exportId);
  if (!job) return null;

  const state = await job.getState();
  const data = job.data;
  
  // Map BullMQ states to our API contract
  let status = 'pending';
  if (state === 'active') status = 'processing';
  if (state === 'completed') status = 'completed';
  if (state === 'failed') status = 'failed';
  // BullMQ has delayed/waiting as well, which map neatly to pending.
  
  // If the job was cancelled, update status
  if (data.cancelled) {
    status = 'cancelled';
  }

  return {
    exportId: data.exportId,
    status,
    progress: job.progress || data.progress || { totalRows: 0, processedRows: 0, percentage: 0 },
    error: job.failedReason || data.error || null,
    createdAt: data.createdAt,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : data.completedAt,
    filePath: job.returnvalue ? job.returnvalue.filePath : data.filePath
  };
}

/**
 * Cancels a job by setting a flag in its data and attempting to remove it.
 * @param {string} exportId
 */
async function cancelExportJob(exportId) {
  const job = await exportQueue.getJob(exportId);
  if (!job) return;

  // Update data so the worker knows to abort if it's currently active
  await job.updateData({ ...job.data, cancelled: true });
}

module.exports = {
  connection,
  exportQueue,
  addExportJob,
  getJobStatus,
  cancelExportJob
};
