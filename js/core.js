/**
 * QuickCut shared core.
 * Pure helpers used by the plugin UI and the ffmpeg pipeline.
 * Works in the browser (window.QC) and in Node (module.exports).
 */
(function (factory) {
    const api = factory();
    // Eagle plugins run with nodeIntegration enabled, so `module` exists even
    // though the file is loaded with a plain <script> tag. Always expose the
    // browser global as well as the CommonJS export.
    if (typeof window !== 'undefined') window.QC = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
    'use strict';

    const VIDEO_EXTS = [
        'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'mpg',
        'mpeg', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'ogv', 'rmvb', 'rm'
    ];

    const ASPECTS = [
        { key: 'source', label: '原始', ratio: null, hint: '跟随首段素材' },
        { key: '1:1', label: '1:1', ratio: 1, hint: '方形 · 头像 / 封面' },
        { key: '4:5', label: '4:5', ratio: 4 / 5, hint: '竖版 · 小红书' },
        { key: '3:4', label: '3:4', ratio: 3 / 4, hint: '竖版' },
        { key: '16:9', label: '16:9', ratio: 16 / 9, hint: '横版 · 宽屏' },
        { key: '9:16', label: '9:16', ratio: 9 / 16, hint: '竖版 · 短视频' },
        { key: '4:3', label: '4:3', ratio: 4 / 3, hint: '经典横版' },
        { key: '3:2', label: '3:2', ratio: 3 / 2, hint: '摄影横版' }
    ];

    const RESOLUTIONS = [
        { key: '2160', label: '4K', short: 2160, hint: '2160p' },
        { key: '1440', label: '2K', short: 1440, hint: '1440p' },
        { key: '1080', label: '1080p', short: 1080, hint: '全高清' },
        { key: '720', label: '720p', short: 720, hint: '高清' },
        { key: '480', label: '480p', short: 480, hint: '轻量' }
    ];

    const QUALITIES = [
        { key: 'high', label: '高', crf: 18, hint: '画质优先' },
        { key: 'standard', label: '标准', crf: 21, hint: '均衡' },
        { key: 'small', label: '轻量', crf: 24, hint: '体积优先' }
    ];

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function isVideoExt(ext) {
        return VIDEO_EXTS.includes(String(ext || '').toLowerCase().replace(/^\./, ''));
    }

    function normalizeRotation(rotation) {
        let r = Number(rotation);
        if (!Number.isFinite(r)) return 0;
        r = ((r % 360) + 360) % 360;
        return r;
    }

    function isQuarterTurn(rotation) {
        const r = normalizeRotation(rotation);
        return r === 90 || r === 270;
    }

    function displaySize(width, height, rotation) {
        const w = Math.max(0, Math.round(Number(width) || 0));
        const h = Math.max(0, Math.round(Number(height) || 0));
        return isQuarterTurn(rotation) ? { width: h, height: w } : { width: w, height: h };
    }

    function parseFraction(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        const text = String(value || '').trim();
        if (!text) return 0;
        if (text.includes('/')) {
            const [a, b] = text.split('/').map(Number);
            return b ? a / b : 0;
        }
        const n = Number(text);
        return Number.isFinite(n) ? n : 0;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function formatTime(seconds, options) {
        const opts = options || {};
        const showTenths = opts.tenths !== false;
        const total = Math.max(0, Number(seconds) || 0);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        const tenth = Math.min(9, Math.floor((total % 1) * 10 + 1e-3));
        let text = `${h > 0 ? pad2(h) + ':' : ''}${pad2(m)}:${pad2(s)}`;
        if (showTenths) text += `.${tenth}`;
        return text;
    }

    function formatClock(seconds) {
        return formatTime(seconds, { tenths: false });
    }

    function parseTimeInput(value) {
        if (typeof value === 'number') return Math.max(0, value);
        const text = String(value || '').trim().replace(',', '.');
        if (!text) return 0;
        const parts = text.split(':').map(Number);
        if (parts.some(n => !Number.isFinite(n))) return 0;
        let seconds = 0;
        for (const part of parts) seconds = seconds * 60 + part;
        return Math.max(0, seconds);
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = n;
        let i = -1;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
    }

    function makeEven(value) {
        const n = Math.round(Number(value) || 0);
        return Math.max(2, n % 2 ? n - 1 : n);
    }

    function aspectRatioFor(key, firstClip, customRatio) {
        if (key === 'custom' && Number(customRatio) > 0) {
            return clamp(Number(customRatio), 0.2, 5);
        }
        const preset = ASPECTS.find(a => a.key === key) || ASPECTS[0];
        if (preset.ratio) return preset.ratio;
        if (firstClip && firstClip.width > 0 && firstClip.height > 0) {
            return firstClip.width / firstClip.height;
        }
        return 16 / 9;
    }

    function normalizeRect(rect) {
        const x = clamp(Number(rect && rect.x) || 0, 0, 0.98);
        const y = clamp(Number(rect && rect.y) || 0, 0, 0.98);
        const w = clamp(Number(rect && rect.w) || 0.1, 0.02, 1 - x);
        const h = clamp(Number(rect && rect.h) || 0.1, 0.02, 1 - y);
        return { x, y, w, h };
    }

    function manualRectToCrop(srcW, srcH, rect) {
        const width = Math.max(2, Math.round(Number(srcW) || 0));
        const height = Math.max(2, Math.round(Number(srcH) || 0));
        const availW = width % 2 ? width - 1 : width;
        const availH = height % 2 ? height - 1 : height;
        const r = normalizeRect(rect);
        let x = Math.round((r.x * availW) / 2) * 2;
        let y = Math.round((r.y * availH) / 2) * 2;
        let w = Math.floor((r.w * availW) / 2) * 2;
        let h = Math.floor((r.h * availH) / 2) * 2;
        x = clamp(x, 0, availW - 2);
        y = clamp(y, 0, availH - 2);
        w = clamp(w, 2, availW - x);
        h = clamp(h, 2, availH - y);
        if (w % 2) w -= 1;
        if (h % 2) h -= 1;
        return { x, y, w: Math.max(2, w), h: Math.max(2, h) };
    }

    function computeOutputSize(ratio, shortEdge) {
        const r = Number(ratio) > 0 ? Number(ratio) : 16 / 9;
        const edge = Math.max(64, Math.round(Number(shortEdge) || 1080));
        let width, height;
        if (r >= 1) {
            height = edge;
            width = edge * r;
        } else {
            width = edge;
            height = edge / r;
        }
        return { width: makeEven(width), height: makeEven(height) };
    }

    function computeCropRect(input) {
        const srcW = Math.max(2, Math.round(Number(input.srcW) || 0));
        const srcH = Math.max(2, Math.round(Number(input.srcH) || 0));
        const ratio = Number(input.aspectW) > 0 && Number(input.aspectH) > 0
            ? Number(input.aspectW) / Number(input.aspectH)
            : 16 / 9;
        const zoom = clamp(Number(input.zoom) || 1, 1, 4);
        const offsetX = clamp(Number(input.offsetX) || 0, -100, 100);
        const offsetY = clamp(Number(input.offsetY) || 0, -100, 100);

        // Keep the crop inside the even-sized area of the source frame.
        const availW = srcW % 2 ? srcW - 1 : srcW;
        const availH = srcH % 2 ? srcH - 1 : srcH;

        let cropW, cropH;
        if (availW / availH > ratio) {
            cropH = availH;
            cropW = cropH * ratio;
        } else {
            cropW = availW;
            cropH = cropW / ratio;
        }
        cropW = cropW / zoom;
        cropH = cropH / zoom;
        cropW = Math.min(availW, Math.max(2, Math.floor(cropW / 2) * 2));
        cropH = Math.min(availH, Math.max(2, Math.floor(cropH / 2) * 2));

        const slackX = Math.max(0, availW - cropW);
        const slackY = Math.max(0, availH - cropH);
        let x = slackX / 2 + (offsetX / 100) * (slackX / 2);
        let y = slackY / 2 + (offsetY / 100) * (slackY / 2);
        x = clamp(Math.round(x / 2) * 2, 0, slackX - (slackX % 2));
        y = clamp(Math.round(y / 2) * 2, 0, slackY - (slackY % 2));
        if (x + cropW > availW) x = Math.max(0, availW - cropW);
        if (y + cropH > availH) y = Math.max(0, availH - cropH);

        return { x, y, w: cropW, h: cropH };
    }

    function buildVideoFilter(input) {
        const outW = makeEven(input.outW);
        const outH = makeEven(input.outH);
        const fps = clamp(Number(input.fps) || 30, 1, 120);
        const targetRatio = outW / outH;
        const prefix = 'setpts=PTS-STARTPTS,';
        const tail = `scale=${outW}:${outH}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p`;
        if (input.manualRect) {
            const crop = manualRectToCrop(input.srcW, input.srcH, input.manualRect);
            return prefix + `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` + tail;
        }
        if (input.fit === 'contain') {
            return prefix +
                `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
                `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
                `fps=${fps},format=yuv420p`;
        }
        const crop = computeCropRect({
            srcW: input.srcW,
            srcH: input.srcH,
            aspectW: targetRatio,
            aspectH: 1,
            zoom: input.zoom,
            offsetX: input.offsetX,
            offsetY: input.offsetY
        });
        return prefix +
            `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` +
            `scale=${outW}:${outH}:flags=lanczos,setsar=1,` +
            `fps=${fps},format=yuv420p`;
    }

    function buildAudioFilter(input) {
        const duration = Math.max(0.01, Number(input.duration) || 0.01);
        const volumeInput = input.volume == null ? 100 : Number(input.volume);
        const volume = input.muted ? 0 : clamp(Number.isFinite(volumeInput) ? volumeInput : 100, 0, 200) / 100;
        const factor = Number(volume.toFixed(4));
        return `asetpts=PTS-STARTPTS,volume=${factor},aresample=48000,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
            `apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}`;
    }

    function sanitizeFileName(name) {
        let value = String(name || '')
            .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
            .replace(/\s+/g, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '')
            .slice(0, 80);
        if (!value) value = 'QuickCut';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `_${value}`;
        return value;
    }

    function defaultProjectName(date) {
        const d = date instanceof Date ? date : new Date();
        return `快剪_${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    }

    function escapeConcatPath(filePath) {
        return `file '${String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    }

    function buildConcatList(paths) {
        return paths.map(escapeConcatPath).join('\n') + '\n';
    }

    function totalDuration(clips) {
        return (clips || []).reduce((sum, clip) => {
            const inPoint = Number(clip.in) || 0;
            const outPoint = Number(clip.out) || 0;
            return sum + Math.max(0, outPoint - inPoint);
        }, 0);
    }

    function clipDuration(clip) {
        if (!clip) return 0;
        return Math.max(0, (Number(clip.out) || 0) - (Number(clip.in) || 0));
    }

    function normalizeClipRange(clip) {
        const duration = Math.max(0.05, Number(clip.duration) || 0.05);
        let inPoint = clamp(Number(clip.in) || 0, 0, Math.max(0, duration - 0.05));
        let outPoint = clamp(Number(clip.out) || duration, inPoint + 0.05, duration);
        if (outPoint - inPoint < 0.05) outPoint = Math.min(duration, inPoint + 0.05);
        return { in: inPoint, out: outPoint };
    }

    function fileStem(name) {
        return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
    }

    return {
        VIDEO_EXTS,
        ASPECTS,
        RESOLUTIONS,
        QUALITIES,
        clamp,
        isVideoExt,
        normalizeRotation,
        isQuarterTurn,
        displaySize,
        parseFraction,
        formatTime,
        formatClock,
        parseTimeInput,
        formatBytes,
        makeEven,
        aspectRatioFor,
        computeOutputSize,
        computeCropRect,
        normalizeRect,
        manualRectToCrop,
        buildVideoFilter,
        buildAudioFilter,
        sanitizeFileName,
        defaultProjectName,
        escapeConcatPath,
        buildConcatList,
        totalDuration,
        clipDuration,
        normalizeClipRange,
        fileStem
    };
});
