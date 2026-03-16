/**
 * GCS helpers for Cloud Run video processor.
 * Uses Application Default Credentials (ADC) when running on GCP.
 */
const { Storage } = require('@google-cloud/storage');

let storage = null;
let bucketName = null;

function getStorage() {
  if (!storage) {
    const projectId = process.env.GCS_PROJECT_ID || process.env.GCP_PROJECT;
    storage = new Storage(projectId ? { projectId } : {});
    bucketName = process.env.GCS_BUCKET || process.env.BUCKET_NAME || 'video-stream-bucket';
  }
  return { storage, bucketName };
}

/**
 * Download a file from GCS to a buffer.
 * @param {string} key - Object path (e.g. uploads/userId/jobId/video.mp4)
 * @param {string} [bucket] - Bucket name (default from env)
 * @returns {Promise<Buffer>}
 */
async function downloadFile(key, bucket) {
  const { storage, bucketName: defaultBucket } = getStorage();
  const b = bucket || defaultBucket;
  const file = storage.bucket(b).file(key);
  const [buffer] = await file.download();
  return buffer;
}

/**
 * Upload a buffer to GCS.
 * @param {string} key - Object path (e.g. processed/userId/jobId/video_720p.mp4)
 * @param {Buffer} body - File content
 * @param {string} contentType - MIME type
 * @param {string} [bucket] - Bucket name (default from env)
 * @returns {Promise<string>} - The key
 */
async function uploadFile(key, body, contentType, bucket) {
  const { storage, bucketName: defaultBucket } = getStorage();
  const b = bucket || defaultBucket;
  const file = storage.bucket(b).file(key);
  await file.save(body, { metadata: { contentType } });
  return key;
}

module.exports = {
  getStorage,
  downloadFile,
  uploadFile,
};
