# Video Processor (Cloud Run)

Standalone Cloud Run service that runs FFmpeg video processing when a file is uploaded to GCS. Mirrors the logic from the Backend media module (`FfmpegService` + `ProcessVideoUsecase`).

## Flow

1. **Upload** → File lands in GCS at `uploads/{userId}/{jobId}/{filename}`.
2. **Trigger** → Eventarc (GCS “Object finalized”) or Pub/Sub pushes an event to this service.
3. **Process** → Service downloads the file, runs FFmpeg (metadata, 360p/720p/1080p, thumbnail), uploads to `processed/{userId}/{jobId}/`.
4. **Notify** → Optional: POST to Nest backend webhook so it can update DB (media status, assets).

## Endpoints

- `GET /` – Simple “running” message.
- `GET /health` – Health check (200 JSON `{ ok: true }`).
- `POST /` – **Event handler.** Body = Eventarc/Pub/Sub payload (bucket + object name). Parses `uploads/userId/jobId/file` and runs the pipeline.
- `POST /process` – **Explicit trigger.** Body: `{ "bucket": "my-bucket", "name": "uploads/userId/jobId/video.mp4" }`. Use from Nest or scripts.

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `8080`). Cloud Run sets this. |
| `GCS_BUCKET` or `BUCKET_NAME` | Default GCS bucket name. |
| `GCS_PROJECT_ID` or `GCP_PROJECT` | GCP project for Storage client. |
| `NEST_WEBHOOK_URL` or `BACKEND_WEBHOOK_URL` | Optional. Nest endpoint to call when processing finishes (e.g. `POST /media/processing-complete`). |
| `WEBHOOK_SECRET` | Optional. Sent as `X-Webhook-Secret` when calling the Nest webhook. |

On Cloud Run, the service account needs **Storage Object Viewer** and **Storage Object Creator** on the bucket. No extra env for credentials if using the default Cloud Run service account.

## Local run

```bash
cd video-processor
npm install
# Set GOOGLE_APPLICATION_CREDENTIALS or gcloud auth application-default login
export GCS_BUCKET=your-bucket
export GCS_PROJECT_ID=your-project
npm start
```

Test with a JSON body (e.g. `POST /process`):

```json
{ "bucket": "your-bucket", "name": "uploads/user123/job456/video.mp4" }
```

## Build and deploy (Cloud Run)

```bash
cd video-processor
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/video-processor
gcloud run deploy video-processor \
  --image gcr.io/YOUR_PROJECT_ID/video-processor \
  --platform managed \
  --region us-central1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --set-env-vars "GCS_BUCKET=your-bucket,GCS_PROJECT_ID=YOUR_PROJECT_ID" \
  --allow-unauthenticated
```

For Eventarc (GCS → Cloud Run), create a trigger that fires on “Object finalized” in your bucket (prefix `uploads/`) and targets this Cloud Run service.

## Webhook payload (to Nest)

When `NEST_WEBHOOK_URL` is set, the service POSTs on success:

```json
{
  "jobId": "...",
  "userId": "...",
  "status": "ready",
  "bucket": "...",
  "rawKey": "uploads/userId/jobId/file.mp4",
  "metadata": { "width": 1920, "height": 1080, "duration": 120, "orientation": "landscape" },
  "assets": [
    { "type": "video", "quality": "360p", "key": "processed/.../video_360p.mp4", "sizeMb": 5.2 },
    { "type": "thumbnail", "key": "processed/.../thumbnail.jpg", "sizeMb": 0.1 }
  ]
}
```

On failure it POSTs `{ "jobId", "userId", "status": "failed", "error": "..." }`. Your Nest app should expose a route (e.g. `POST /media/processing-complete`) that updates Media/MediaAsset/MediaProcessingJob and validates `X-Webhook-Secret` if used.
