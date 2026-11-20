/**
 * QuickCut ffmpeg pipeline (Node side, runs inside the Eagle plugin window).
 *
 * Every clip is normalised inside one filter graph (trim -> crop/fit ->
 * fps/format -> volume) and joined with the concat filter, so the whole
 * timeline is encoded exactly once: fast, frame accurate and without audio
 * gaps at clip boundaries.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const QC = require('./core.js');

class FFmpegError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'FFmpegError';
        this.details = details || '';
    }
}

function tail(text, max) {
    const value = String(text || '').trim();
    if (value.length <= max) return value;
    return '…' + value.slice(-max);
}

function friendlyError(text) {
    const raw = String(text || '');
    const rules = [
        [/moov atom not found/i, '视频文件不完整或已损坏，无法读取。'],
        [/Invalid data found when processing input/i, '无法识别该视频文件，可能已损坏或编码不受支持。'],
        [/No such file or directory/i, '找不到源文件，素材可能已被移动。'],
        [/Permission denied/i, '没有权限读取或写入文件。'],
        [/No space left/i, '磁盘空间不足。'],
        [/Cannot find a matching stream/i, '视频流解析失败，请尝试重新载入素材。'],
        [/Error while opening encoder|Error initializing output stream/i, '编码器初始化失败，请降低分辨率后重试。'],
        [/Conversion failed/i, 'FFmpeg 处理失败。']
    ];
    for (const [re, message] of rules) {
        if (re.test(raw)) return message;
    }
    return '视频处理失败。';
}

class FFmpeg {
    constructor(options) {
        this.ffmpegPath = options && options.ffmpegPath;
        this.ffprobePath = options && options.ffprobePath;
        this._child = null;
        this._cancelled = false;
    }

    static async resolveFromEagle() {
        if (typeof eagle === 'undefined' || !eagle.extraModule || !eagle.extraModule.ffmpeg) {
            throw new FFmpegError('当前环境没有 Eagle ffmpeg 模块。');
        }
        const installed = await eagle.extraModule.ffmpeg.isInstalled();
        if (!installed) {
            try {
                await eagle.extraModule.ffmpeg.install();
            } catch (err) {
                // install() opens Eagle's installer; getPaths below reports status.
            }
        }
        const paths = await eagle.extraModule.ffmpeg.getPaths();
        if (!paths || !paths.ffmpeg || !paths.ffprobe) {
            throw new FFmpegError('FFmpeg 尚未安装，请先在 Eagle 插件中心安装 FFmpeg。');
        }
        return new FFmpeg({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe });
    }

    _run(bin, args, options) {
        const opts = options || {};
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(bin, args, {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (err) {
                reject(new FFmpegError('无法启动 FFmpeg。', err.message));
                return;
            }
            this._child = child;
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timeout = opts.timeoutMs
                ? setTimeout(() => {
                    if (!settled) {
                        try { child.kill(); } catch (err) { /* ignore */ }
                    }
                }, opts.timeoutMs)
                : null;

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                stdout += chunk;
                if (opts.onStdout) opts.onStdout(chunk);
                if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
            });
            child.stderr.on('data', chunk => {
                stderr += chunk;
                if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-512 * 1024);
            });
            child.on('error', err => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                this._child = null;
                reject(new FFmpegError('无法启动 FFmpeg。', err.message));
            });
            child.on('close', code => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                this._child = null;
                if (this._cancelled) {
                    reject(new FFmpegError('CANCELLED', 'cancelled'));
                    return;
                }
                if (code === 0) resolve({ stdout, stderr });
                else reject(new FFmpegError(friendlyError(stderr), tail(stderr, 1500)));
            });
        });
    }

    async probe(filePath) {
        if (!this.ffprobePath) throw new FFmpegError('缺少 ffprobe。');
        if (!fs.existsSync(filePath)) throw new FFmpegError('找不到源文件，素材可能已被移动。');
        const args = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            filePath
        ];
        const { stdout } = await this._run(this.ffprobePath, args, { timeoutMs: 30000 });
        let data;
        try {
            data = JSON.parse(stdout);
        } catch (err) {
            throw new FFmpegError('无法解析视频信息。', tail(stdout, 500));
        }
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const videoStream = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        if (!videoStream) throw new FFmpegError('该文件不包含视频画面。');
        const audioStream = streams.find(s => s.codec_type === 'audio');

        let rotation = 0;
        for (const side of videoStream.side_data_list || []) {
            if (side && side.rotation != null) rotation = Number(side.rotation) || 0;
        }
        if (!rotation && videoStream.tags && videoStream.tags.rotate) {
            rotation = Number(videoStream.tags.rotate) || 0;
        }
        rotation = QC.normalizeRotation(rotation);
        const display = QC.displaySize(videoStream.width, videoStream.height, rotation);

        const durationCandidates = [
            Number(videoStream.duration),
            Number(data.format && data.format.duration)
        ].filter(n => Number.isFinite(n) && n > 0);
        const duration = durationCandidates.length ? durationCandidates[0] : 0;
        const fps = QC.parseFraction(videoStream.avg_frame_rate) || QC.parseFraction(videoStream.r_frame_rate) || 30;

        return {
            width: display.width,
            height: display.height,
            codedWidth: Number(videoStream.width) || 0,
            codedHeight: Number(videoStream.height) || 0,
            rotation,
            duration,
            fps,
            hasAudio: !!audioStream,
            audioChannels: audioStream ? Number(audioStream.channels) || 0 : 0,
            videoCodec: videoStream.codec_name || '',
            audioCodec: audioStream ? audioStream.codec_name || '' : '',
            size: Number(data.format && data.format.size) || fs.statSync(filePath).size,
            formatName: data.format ? data.format.format_name || '' : ''
        };
    }

    cancel() {
        this._cancelled = true;
        if (this._child) {
            try { this._child.kill(); } catch (err) { /* ignore */ }
        }
    }

    resetCancel() {
        this._cancelled = false;
    }

    async render(plan) {
        if (!this.ffmpegPath) throw new FFmpegError('缺少 ffmpeg。');
        this.resetCancel();
        const clips = Array.isArray(plan.clips) ? plan.clips : [];
        if (!clips.length) throw new FFmpegError('没有可导出的片段。');
        if (clips.length > 60) throw new FFmpegError('单次最多导出 60 个片段，请分批处理。');
        const outW = QC.makeEven(plan.width);
        const outH = QC.makeEven(plan.height);
        const fps = QC.clamp(Number(plan.fps) || 30, 1, 120);
        const crf = QC.clamp(Number(plan.crf) || 21, 12, 35);
        const preset = plan.preset || 'veryfast';
        const total = QC.totalDuration(clips);
        if (total <= 0.05) throw new FFmpegError('总时长太短，无法导出。');

        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const outDir = path.join(os.tmpdir(), `quickcut-out-${stamp}`);
        await fs.promises.mkdir(outDir, { recursive: true });
        const safeName = QC.sanitizeFileName(plan.name || QC.defaultProjectName());
        const outputPath = path.join(outDir, `${safeName}.mp4`);

        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-progress', 'pipe:1', '-nostats'
        ];
        const filters = [];
        const concatInputs = [];

        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            const duration = Math.max(0.05, Number(clip.out) - Number(clip.in));
            args.push('-ss', Number(clip.in).toFixed(3), '-t', duration.toFixed(3), '-i', clip.filePath);
            filters.push(`[${i}:v:0]` + QC.buildVideoFilter({
                srcW: clip.width,
                srcH: clip.height,
                outW,
                outH,
                fit: clip.fit === 'contain' ? 'contain' : 'cover',
                zoom: clip.zoom,
                offsetX: clip.offsetX,
                offsetY: clip.offsetY,
                fps
            }) + `[v${i}]`);
            if (clip.hasAudio) {
                filters.push(`[${i}:a:0]` + QC.buildAudioFilter({
                    duration,
                    volume: clip.volume,
                    muted: clip.muted
                }) + `[a${i}]`);
            } else {
                filters.push(
                    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)},` +
                    `asetpts=PTS-STARTPTS[a${i}]`
                );
            }
            concatInputs.push(`[v${i}][a${i}]`);
        }
        filters.push(`${concatInputs.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);

        const filterFile = path.join(outDir, 'filters.txt');
        await fs.promises.writeFile(filterFile, filters.join(';'), 'utf8');

        args.push(
            '-filter_complex_script', filterFile,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', preset,
            '-crf', String(crf),
            '-pix_fmt', 'yuv420p',
            '-profile:v', 'high',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2',
            '-movflags', '+faststart',
            outputPath
        );

        const startedAt = Date.now();
        let lastProgress = 0;
        let lastSeconds = 0;
        try {
            await this._run(this.ffmpegPath, args, {
                onStdout: chunk => {
                    let seconds = lastSeconds;
                    for (const line of String(chunk).split('\n')) {
                        const eq = line.indexOf('=');
                        if (eq < 0) continue;
                        const key = line.slice(0, eq);
                        const value = line.slice(eq + 1).trim();
                        if (key === 'out_time_us' || key === 'out_time_ms') {
                            const parsed = Number(value);
                            if (Number.isFinite(parsed)) seconds = parsed / 1e6;
                        }
                    }
                    if (seconds > 0 && seconds >= lastSeconds) {
                        lastSeconds = seconds;
                        const now = Date.now();
                        if (plan.onProgress && now - lastProgress > 120) {
                            lastProgress = now;
                            const ratio = QC.clamp(seconds / total, 0, 0.995);
                            const speed = ratio > 0 ? (seconds / ((now - startedAt) / 1000)) : 0;
                            plan.onProgress({
                                percent: ratio,
                                stage: 'encode',
                                seconds,
                                totalDuration: total,
                                speed
                            });
                        }
                    }
                }
            });
            const stat = await fs.promises.stat(outputPath);
            if (!stat.size) throw new FFmpegError('导出文件为空，请重试。');
            if (plan.onProgress) {
                plan.onProgress({ percent: 1, stage: 'done', seconds: total, totalDuration: total });
            }
            return {
                outputPath,
                outDir,
                size: stat.size,
                duration: total,
                width: outW,
                height: outH,
                cleanup: async () => {
                    try { await fs.promises.rm(outDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
                }
            };
        } catch (err) {
            try { await fs.promises.rm(outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            if (err && err.message === 'CANCELLED') throw new FFmpegError('已取消导出', 'cancelled');
            throw err;
        }
    }

    async generateThumbs(filePath, duration, count, outDir, prefix) {
        if (!this.ffmpegPath || !outDir) return [];
        const total = Math.max(0.2, Number(duration) || 0);
        const wanted = Math.max(4, Math.min(16, Number(count) || 12));
        const safe = String(prefix || 'thumb').replace(/[^\w-]/g, '_').slice(0, 40);
        const dir = path.join(outDir, `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
        await fs.promises.mkdir(dir, { recursive: true });
        const pattern = path.join(dir, 'f_%03d.jpg');
        const args = [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', filePath,
            '-vf', `fps=${(wanted / total).toFixed(4)},scale=160:-2`,
            '-frames:v', String(wanted),
            '-q:v', '5',
            pattern
        ];
        try {
            await new Promise((resolve, reject) => {
                let stderr = '';
                let settled = false;
                const child = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { child.kill('SIGKILL'); } catch (err) { /* ignore */ }
                    reject(new FFmpegError('缩略图生成超时。'));
                }, 45000);
                child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
                child.on('error', err => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(err);
                });
                child.on('close', code => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (code === 0) resolve();
                    else reject(new FFmpegError('缩略图生成失败。', stderr));
                });
            });
            const names = (await fs.promises.readdir(dir))
                .filter(name => /^f_\d+\.jpg$/i.test(name))
                .sort()
                .slice(0, wanted);
            return names.map((name, i) => ({
                time: ((i + 0.5) * total) / Math.max(1, names.length),
                url: pathToFileURL(path.join(dir, name)).href
            }));
        } catch (err) {
            try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            return [];
        }
    }
}

FFmpeg.FFmpegError = FFmpegError;
module.exports = FFmpeg;
