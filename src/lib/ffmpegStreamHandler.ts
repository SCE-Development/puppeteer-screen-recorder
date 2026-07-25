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
        logger.info('starting weather live stream');

        const musicStreamUrl = process.env.RTMP_MUSIC_STREAM_URL;

        // Input 0: Video Pipe
        // We keep wallclock here because raw piped JPEGs have no inherent timestamps
        const ffmpegArgs = [
            '-y',
            '-thread_queue_size', '1024',
            '-use_wallclock_as_timestamps', '1', 
            '-f', 'image2pipe',
            '-c:v', 'mjpeg',
            '-i', '-', 
        ];

        // Input 1: Audio Stream
        if (musicStreamUrl) {
            ffmpegArgs.push(
                '-thread_queue_size', '1024',
                // REMOVED: '-use_wallclock_as_timestamps', '1'
                '-i', musicStreamUrl, 
            );
        }

        // Video Output Flags
        ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-r', String(this.RTMP_STREAM_FRAMERATE),
            // NEW: Resets the massive wall-clock timestamps to start at 0
            '-vf', 'setpts=PTS-STARTPTS', 
            '-vsync', 'cfr', 
            '-g', String(this.RTMP_STREAM_FRAMERATE * 2),
        );

        // Audio Output Flags and Muxing
        if (musicStreamUrl) {
            ffmpegArgs.push(
                '-map', '0:v:0', 
                '-map', '1:a:0', 
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                // NEW: Resets audio timestamps to 0, then applies async to maintain sync
                '-af', 'asetpts=PTS-STARTPTS,aresample=async=1', 
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

    writeBase64ImageToWeatherStream(base64Data) {
        if (this.writeImageCommand && !this.writeImageCommand.killed) {
            this.writeImageCommand.stdin.write(Buffer.from(base64Data, 'base64'));
        }
    }
}
