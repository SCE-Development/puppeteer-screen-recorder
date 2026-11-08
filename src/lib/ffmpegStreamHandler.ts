const { spawn } = require('child_process');
const logger = require('./logger');

export class FfmpegStreamHandler {
    writeImageCommand: any;
    stopping: boolean;
    page: any;
    isBackpressured: boolean = false;

    RTMP_STREAM_RESTART_DELAY_SECONDS = Number(process.env.RTMP_STREAM_RESTART_DELAY_SECONDS) || 30;
    WS4KP_MAX_RELOAD_RETRIES = Number(process.env.WS4KP_MAX_RELOAD_RETRIES) || 3;
    RTMP_STREAM_FRAMERATE = Number(process.env.RTMP_STREAM_FRAMERATE) || 15;

    constructor(page: any) {
        this.page = page;
        this.writeImageCommand = null;
        this.startLiveWeatherStream();
    }

    startLiveWeatherStream() {
        logger.info('starting weather live stream');
        const musicStreamUrl = process.env.RTMP_MUSIC_STREAM_URL;

        // from https://stackoverflow.com/a/61281547
        // and also https://stackoverflow.com/a/62807083
        const ffmpegArgs = [
            '-y',
            '-threads', '4',
            // Assign real-world clock timestamps to stdin video frames as they arrive
            '-use_wallclock_as_timestamps', '1',
            '-thread_queue_size', '4096',
            '-f', 'image2pipe',
            '-framerate', String(this.RTMP_STREAM_FRAMERATE), // Define incoming stdin framerate
            '-c:v', 'mjpeg',
            '-i', '-', // input 0: browser frames piped in over stdin
        ];

        if (musicStreamUrl) {
            ffmpegArgs.push(
                '-vn', // ignore video, just use audio from mp4 file
                '-stream_loop', '-1', // Loop indefinitely
                '-thread_queue_size', '4096',
                '-i', '/app/src/combined.mp4', // Input 1: RTMP Audio
            );
        }

        ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-r', String(this.RTMP_STREAM_FRAMERATE),
            '-g', String(this.RTMP_STREAM_FRAMERATE * 2),
        );

        if (musicStreamUrl) {
            // ffmpegArgs.push(
            //     '-map', '0:v:0',
            //     '-map', '1:a:0',
            //     '-c:a', 'aac', // Transcode audio to allow pitch-safe resampling
            //     '-b:a', '128k',
            //     '-ar', '44100',
            //     // Keep audio synced without altering pitch when video timestamps jitter
            //     '-af', 'aresample=async=1000:min_hard_comp=0.100000',
            // );
        } else {
            ffmpegArgs.push('-an'); // Explicitly disable audio if no music URL provided
        }

        ffmpegArgs.push(
            '-f', 'flv',
            process.env.RTMP_OUTPUT_URL,
        );

        // Inherit or pipe stdin safely
        this.writeImageCommand = spawn("ffmpeg", ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        // Handle backpressure events on stdin
        this.writeImageCommand.stdin.on('drain', () => {
            this.isBackpressured = false;
        });

        this.writeImageCommand.stdout.on('data', () => {
            // Keep lightweight or suppress in production to avoid high stdout overhead
        });

        this.writeImageCommand.stderr.on('data', (data) => {
            const str = data.toString();
            // Log errors or specific metrics if needed
            if (str.includes('Error')) logger.error(`FFmpeg stderr: ${str}`);
        });
        this.writeImageCommand.on('exit', async (code) => {
            logger.info(`FFmpeg process exited with code ${code}`);
            this.reloadWebpage();
            logger.info('scheduling restart in', this.RTMP_STREAM_RESTART_DELAY_SECONDS, 'seconds');
            setTimeout(() => {
                this.startLiveWeatherStream();
            }, this.RTMP_STREAM_RESTART_DELAY_SECONDS * 1000);
        });

        this.writeImageCommand.stdin.on('error', (err) => {
            if (err.code !== 'EPIPE') {
                logger.error('Stdin error:', err);
            }
        });
    }

    async reloadWebpage() {
        for (let i = 0; i < this.WS4KP_MAX_RELOAD_RETRIES; i++) {
            try {
                logger.info('reloading page');
                await this.page.reload();
                await this.page.waitForSelector('body');
                const frames = await this.page.frames();
                const iframe = frames[0];
                if (iframe) {
                    await iframe.evaluate(() => {
                        document.documentElement.scrollTop = 0;
                    });
                }
                logger.info('reloaded page');
                break;
            } catch (e) {
                logger.error('failed reloading page', e);
            }
        }
    }

    writeBase64ImageToWeatherStream(base64Data) {
        // Prevent buffer bloat: Drop incoming frame if FFmpeg buffer is full or stdin is closed
        if (!this.writeImageCommand || this.writeImageCommand.killed || !this.writeImageCommand.stdin.writable) {
            return;
        }

        if (this.isBackpressured) {
            // Frame dropped intentionally to protect RAM and maintain real-time sync
            return;
        }

        const buffer = Buffer.from(base64Data, 'base64');
        const canWrite = this.writeImageCommand.stdin.write(buffer);

        if (!canWrite) {
            this.isBackpressured = true;
        }
    }
}
