const { spawn } = require('child_process');

const logger = require('./logger');

export class FfmpegStreamHandler {
    writeImageCommand: any;
    stopping: boolean;
    page: any;

    RTMP_STREAM_RESTART_DELAY_SECONDS = Number(process.env.RTMP_STREAM_RESTART_DELAY_SECONDS) || 30;
    WS4KP_MAX_RELOAD_RETRIES = Number(process.env.WS4KP_MAX_RELOAD_RETRIES) || 3;
    RTMP_STREAM_FRAMERATE = Number(process.env.RTMP_STREAM_FRAMERATE) || 15;

    constructor(page: any) {
        this.page = page;
        this.writeImageCommand = null;
        this.startLiveWeatherStream();
    }

    startLiveWeatherStream() {
        this.ffmpegBackpressured = false;
        logger.info('starting weather live stream');

        // Background music is published to the node-media-server "sound"
        // channel by the separate `music` container. Pull it in as a second
        // input and mux its audio into the outgoing stream. It's optional:
        // without RTMP_MUSIC_STREAM_URL the stream stays video-only.
        const musicStreamUrl = process.env.RTMP_MUSIC_STREAM_URL;

        // from https://stackoverflow.com/a/61281547
        // and also https://stackoverflow.com/a/62807083
        const ffmpegArgs = [
            '-y',
            '-thread_queue_size', '256',
            '-use_wallclock_as_timestamps', '1', // stamp frames by real arrival time so the stream stays at real-time
            '-f', 'image2pipe',
            '-c:v', 'mjpeg',
            '-i', '-', // input 0: browser frames piped in over stdin
        ];

        if (musicStreamUrl) {
            // Stamp the music with the same wall-clock arrival time as the
            // video so both inputs ride one clock. Without this the video's
            // wall-clock timestamps and the RTMP stream's own (near-zero)
            // timeline don't line up, and ffmpeg drops video frames trying to
            // reconcile them -- the stream freezes and falls further behind.
            ffmpegArgs.push(
                '-thread_queue_size', '1024',
                '-use_wallclock_as_timestamps', '1',
                '-i', musicStreamUrl, // input 1: the music RTMP stream
            );
        }

        ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-vf', `setpts=PTS-STARTPTS,fps=${this.RTMP_STREAM_FRAMERATE}`,
            '-fps_mode', 'cfr',
            '-g', String(this.RTMP_STREAM_FRAMERATE * 2), // 2s keyframe interval
        );

        if (musicStreamUrl) {
            ffmpegArgs.push(
                '-map', '0:v:0', // video from the piped browser frames
                '-map', '1:a:0', // audio from the music stream
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-af', 'aresample=async=1', // add/drop samples to hold sync instead of stalling video
            );
        }

        ffmpegArgs.push(
            '-f', 'flv',
            process.env.RTMP_OUTPUT_URL,
        );

        this.writeImageCommand = spawn("ffmpeg", ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
        // Capture stdout and stderr for debugging
        this.writeImageCommand.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });

        this.writeImageCommand.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });
        this.writeImageCommand.on('exit', async () => {
            this.reloadWebpage();
            logger.info('scheduling restart in', this.RTMP_STREAM_RESTART_DELAY_SECONDS, 'seconds')
            setTimeout(() => {
                this.startLiveWeatherStream();
            }, this.RTMP_STREAM_RESTART_DELAY_SECONDS * 1000);
        });

        // We need this empty handler so the process exits when running
        // docker on a linux platform
        this.writeImageCommand.stdin.on('close', function (code, signal) {
            logger.debug('closed with params', { code, signal })
        });
        this.writeImageCommand.on('close', (code, signal) => {
            logger.info(`ffmpeg process closed with code ${code} and signal ${signal}`);
        });

        this.writeImageCommand.on('error', (err) => {
            logger.error('Error with ffmpeg process:', err);
        });
        this.writeImageCommand.stdin.on('error', function (err) {
            logger.debug('caught stdin error with code', err.code)
            if (err.code == "EPIPE") {
                // process.exit(0);
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
                await iframe.evaluate(() => {
                    document.documentElement.scrollTop = 0; // Scroll to the top of the iframe
                });
                logger.info('reloaded page');
                break;
            } catch (e) {
                logger.error('failed reloading page', e);
            }
        }
    }

    private lastFrameTime = 0;
    private ffmpegBackpressured = false;

    writeBase64ImageToWeatherStream(base64Data) {
        if (
            !this.writeImageCommand ||
            this.writeImageCommand.killed ||
            this.ffmpegBackpressured
        ) {
            return;
        }

        const now = Date.now();
        const frameInterval = 1000 / this.RTMP_STREAM_FRAMERATE;

        if (now - this.lastFrameTime < frameInterval) {
            return;
        }

        this.lastFrameTime = now;

        const accepted = this.writeImageCommand.stdin.write(Buffer.from(base64Data, 'base64'),);

        if (!accepted) {
            this.ffmpegBackpressured = true;

            this.writeImageCommand.stdin.once('drain', () => {
                this.ffmpegBackpressured = false;
            })
        }
    }
}
