'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * In-process job store backed by a Map.
 *
 * @typedef {object} Job
 * @property {string}   exportId
 * @property {string}   status          - pending | processing | completed | failed | cancelled
 * @property {object}   progress
 * @property {number}   progress.totalRows
 * @property {number}   progress.processedRows
 * @property {number}   progress.percentage
 * @property {string|null} error
 * @property {string}   createdAt       - ISO 8601
 * @property {string|null} completedAt  - ISO 8601
 * @property {string|null} filePath     - absolute path to the generated CSV file
 * @property {string[]} columns         - column names to export
 * @property {string}   delimiter
 * @property {string}   quoteChar
 * @property {object}   filters
 * @property {string|null} filters.countryCode
 * @property {string|null} filters.subscriptionTier
 * @property {number|null} filters.minLtv
 * @property {{ cancelled: boolean }} cancelToken - cooperative cancellation flag
 */

/** @type {Map<string, Job>} */
const store = new Map();

/**
 * Creates and persists a new export job.
 * @param {object} opts
 * @param {string[]}    opts.columns
 * @param {string}      opts.delimiter
 * @param {string}      opts.quoteChar
 * @param {object}      opts.filters
 * @returns {Job}
 */
function createJob({ columns, delimiter, quoteChar, filters }) {
  const job = {
    exportId: uuidv4(),
    status: 'pending',
    progress: { totalRows: 0, processedRows: 0, percentage: 0 },
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    filePath: null,
    columns,
    delimiter,
    quoteChar,
    filters,
    cancelToken: { cancelled: false },
  };
  store.set(job.exportId, job);
  return job;
}

/**
 * Retrieves a job by ID.
 * @param {string} exportId
 * @returns {Job|undefined}
 */
function getJob(exportId) {
  return store.get(exportId);
}

/**
 * Removes a job from the store.
 * @param {string} exportId
 */
function deleteJob(exportId) {
  store.delete(exportId);
}

module.exports = { createJob, getJob, deleteJob };
