const { spawn } = require('child_process');

const logger = require('./logger');

export class FfmpegStreamHandler {
    writeImageCommand: any;
    stopping: boolean;
    page: any;

    RTMP_STREAM_RESTART_DELAY_SECONDS = Number(process.env.RTMP_STREAM_RESTART_DELAY_SECONDS) || 30;
    RTMP_STREAM_KILL_INTERVAL_SECONDS = Number(process.env.RTMP_STREAM_KILL_INTERVAL_SECONDS) || 300; // every 5 minutes
    WS4KP_MAX_RELOAD_RETRIES = Number(process.env.WS4KP_MAX_RELOAD_RETRIES) || 3;
    RTMP_STREAM_FRAMERATE = Number(process.env.RTMP_STREAM_FRAMERATE) || 24;

    constructor(page: any) {
        this.page = page;
        this.writeImageCommand = null;
        this.startLiveWeatherStream();
        this.scheduleProcessRestart();
    }

    startLiveWeatherStream() {
        logger.info('starting weather live stream');
        this.writeImageCommand = spawn("ffmpeg",
            // from https://stackoverflow.com/a/61281547
            // and also https://stackoverflow.com/a/62807083
            [
                '-y',
                '-use_wallclock_as_timestamps', '1', // stamp frames by real arrival time so the stream stays at real-time
                '-f', 'image2pipe',
                '-c:v', 'mjpeg',
                '-i', '-',
                // '-i', process.env.RTMP_MUSIC_STREAM_URL,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-r', String(this.RTMP_STREAM_FRAMERATE), // steady output rate
                '-vsync', 'cfr', // duplicate/drop frames to hold real-time instead of lagging
                '-g', String(this.RTMP_STREAM_FRAMERATE * 2), // 2s keyframe interval
                '-f', 'flv',
                process.env.RTMP_OUTPUT_URL,
            ], { stdio: ['pipe', 'pipe', 'pipe'] })
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
                this.scheduleProcessRestart();
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

    scheduleProcessRestart() {
        setTimeout(() => {
            if (this.writeImageCommand && !this.writeImageCommand.killed) {
                logger.info('stopping ffmpeg process for weather website')
                this.writeImageCommand.stdin.end();
                this.writeImageCommand.kill();
            }
        }, this.RTMP_STREAM_KILL_INTERVAL_SECONDS * 1000);
    }
}
