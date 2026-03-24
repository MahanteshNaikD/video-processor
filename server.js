/**
 * Cloud Run HTTP server for video processing.
 * Triggered by Eventarc (GCS object finalized) or Pub/Sub push.
 * Flow: parse event → download from GCS → FFmpeg process → upload to GCS → optional webhook to Nest.
 */
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { downloadFile, uploadFile, getStorage } = require('./gcs');
const { processVideo } = require('./ffmpeg-processor');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(express.json({ limit: '1mb' }));

/**
 * Parse GCS event to get bucket and object name.
 * Supports:
 * 1) Eventarc / Cloud Events (google.cloud.storage.object.v1.finalized)
 * 2) Pub/Sub push (message.data = base64 JSON from GCS notification)
 */
function parseEventPayload(body) {
  if (!body) return null;

  // Cloud Events (Eventarc)
  if (body.bucket || body.name) {
    return {
      bucket: body.bucket,
      name: body.name,
      contentType: body.contentType,
    };
  }
  // Eventarc wraps in "data" sometimes
  if (body.data && (body.data.bucket || body.data.name)) {
    return {
      bucket: body.data.bucket,
      name: body.data.name,
      contentType: body.data.contentType,
    };
  }
  // Pub/Sub push: { message: { data: "<base64>" } }
  if (body.message && body.message.data) {
    try {
      const data = Buffer.from(body.message.data, 'base64').toString('utf8');
      const decoded = JSON.parse(data);
      return {
        bucket: decoded.bucket,
        name: decoded.name,
        contentType: decoded.contentType,
      };
    } catch (e) {
      console.warn('Pub/Sub data decode error:', e.message);
      return null;
    }
  }
  return null;
}

/**
 * From object name "uploads/userId/jobId/filename.mp4" get userId and jobId.
 */
function parseUploadPath(objectName) {
  if (!objectName || !objectName.startsWith('uploads/')) return null;
  const parts = objectName.replace(/^uploads\//, '').split('/');
  if (parts.length >= 2) {
    return { userId: parts[0], jobId: parts[1], filename: parts[2] || 'input.mp4' };
  }
  return null;
}

/**
 * Notify Nest backend that processing is done (optional).
 */
async function notifyBackend(payload) {
  const url = process.env.NEST_WEBHOOK_URL || process.env.BACKEND_WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!url) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Webhook-Secret'] = secret;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('Webhook failed:', res.status, await res.text());
    }
  } catch (err) {
    console.warn('Webhook error:', err.message);
  }
}

/**
 * Main processing: download → process → upload → webhook
 */
async function runProcessing(bucket, objectName) {
  const pathInfo = parseUploadPath(objectName);
  if (!pathInfo) {
    throw new Error(`Invalid upload path (expected uploads/userId/jobId/file): ${objectName}`);
  }
  const { userId } = pathInfo;
  const { bucketName: defaultBucket } = getStorage();
  const bucketName = bucket || defaultBucket;

  const tmpDir = path.join(os.tmpdir(), `video-${jobId}-${Date.now()}`);
  const outputDir = path.join(tmpDir, 'out');
  const inputPath = path.join(tmpDir, 'input.mp4');
  const jobId = new Date().getTime();

  try {
    await fs.mkdir(path.dirname(inputPath), { recursive: true });
    const buffer = await downloadFile(objectName, bucketName);
    await fs.writeFile(inputPath, buffer);

    const processResult = await processVideo(inputPath, outputDir);

    const prefix = `processed/${userId}/${jobId}`;
    const assets = [];

    for (const variant of processResult.variants) {
      const variantPath = path.join(outputDir, `video_${variant}.mp4`);
      const key = `${prefix}/video_${variant}.mp4`;
      const buf = await fs.readFile(variantPath);
      await uploadFile(key, buf, 'video/mp4', bucketName);
      const stat = await fs.stat(variantPath);
      assets.push({
        type: 'video',
        quality: variant,
        key,
        sizeMb: stat.size / (1024 * 1024),
      });
    }

    if (processResult.thumbnail) {
      const thumbKey = `${prefix}/thumbnail.jpg`;
      const thumbBuf = await fs.readFile(processResult.thumbnail);
      await uploadFile(thumbKey, thumbBuf, 'image/jpeg', bucketName);
      const stat = await fs.stat(processResult.thumbnail);
      assets.push({
        type: 'thumbnail',
        key: thumbKey,
        sizeMb: stat.size / (1024 * 1024),
      });
    }

    await notifyBackend({
      jobId,
      userId,
      status: 'ready',
      bucket: bucketName,
      rawKey: objectName,
      metadata: {
        width: processResult.width,
        height: processResult.height,
        duration: processResult.duration,
        orientation: processResult.orientation,
      },
      assets,
    });

    return {
      jobId,
      userId,
      status: 'ready',
      assets: assets.map((a) => a.key),
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Cleanup warning:', e.message);
    }
  }
}

// Health check for Cloud Run
app.get('/', (req, res) => {
  res.send('Video processor running. POST to / process GCS upload events.');
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// Eventarc or Pub/Sub invokes this
app.post('/', async (req, res) => {
  const body = req.body;
  const payload = parseEventPayload(body);

  if (!payload || !payload.name) {
    console.warn('Invalid or missing event payload');
    return res.status(400).json({ error: 'Missing or invalid event (bucket/name)' });
  }

  const { bucket, name } = payload;
  console.log('Processing:', bucket, name);

  try {
    const result = await runProcessing(bucket, name);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Processing failed:', err);
    const pathInfo = parseUploadPath(name);
    if (pathInfo) {
      await notifyBackend({
        jobId: pathInfo.jobId,
        userId: pathInfo.userId,
        status: 'failed',
        error: err.message,
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

// Optional: explicit trigger with JSON body { bucket, name } (e.g. from Nest)
app.post('/process', async (req, res) => {
  const { bucket, name } = req.body || {};
  const objectName = name || req.body?.key;
  const bucketName = bucket || process.env.GCS_BUCKET;

  if (!objectName) {
    return res.status(400).json({ error: 'Missing name or key' });
  }

  try {
    const result = await runProcessing(bucketName, objectName);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Processing failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video processor listening on port ${PORT}`);
});
