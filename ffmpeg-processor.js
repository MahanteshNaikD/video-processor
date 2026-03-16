/**
 * FFmpeg processing logic (from media module: FfmpegService + ProcessVideoUsecase).
 * Uses fluent-ffmpeg + ffmpeg-static.
 */
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const video = metadata.streams.find((s) => s.codec_type === 'video');
      if (!video) return reject(new Error('No video stream found'));
      resolve({
        width: video.width,
        height: video.height,
        duration: metadata.format.duration ?? 0,
        orientation: video.width >= video.height ? 'landscape' : 'portrait',
      });
    });
  });
}

function transcodeVideo(inputPath, outputPath, size) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .size(size)
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset veryfast', '-movflags +faststart'])
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function generateThumbnail(inputPath, outputDir, size = '640x?') {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: ['5'],
        filename: 'thumbnail.jpg',
        folder: outputDir,
        size,
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

const VARIANTS = [
  { name: '144p', size: '256x144' },
  { name: '240p', size: '426x240' },
  { name: '360p', size: '640x360' },
  { name: '720p', size: '1280x720' },
  { name: '1080p', size: '1920x1080' },
];

/**
 * Process a local video file: metadata, transcode variants, thumbnail.
 * @param {string} videoPath - Path to input video
 * @param {string} outputDir - Directory for outputs (video_360p.mp4, etc.)
 * @returns {Promise<{ width, height, duration, orientation, variants: string[], thumbnail: string }>}
 */
async function processVideo(videoPath, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const metadata = await getVideoMetadata(videoPath);

  for (const v of VARIANTS) {
    const outputPath = path.join(outputDir, `video_${v.name}.mp4`);
    await transcodeVideo(videoPath, outputPath, v.size);
  }

  await generateThumbnail(videoPath, outputDir);

  return {
    ...metadata,
    variants: VARIANTS.map((v) => v.name),
    thumbnail: path.join(outputDir, 'thumbnail.jpg'),
  };
}

module.exports = {
  getVideoMetadata,
  transcodeVideo,
  generateThumbnail,
  processVideo,
  VARIANTS,
};
