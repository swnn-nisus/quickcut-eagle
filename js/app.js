/* QuickCut 快剪 — Eagle plugin UI */
(function () {
    'use strict';

    const QC = window.QC;
    const $ = (selector, root) => (root || document).querySelector(selector);
    const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
    const MIN_CLIP = 0.1;
    const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
    const SETTINGS_KEY = 'quickcut.settings.v2';
    const EDITS_KEY = 'quickcut.edits.v1';

    const state = {
        created: false,
        plugin: null,
        clips: [],
        activeId: null,
        playing: false,
        loop: false,
        grid: true,
        masterVolume: 100,
        masterMuted: false,
        previewError: false,
        currentClipId: null,
        loading: false,
        loadToken: 0,
        loadPromise: null,
        loadAt: 0,
        exporting: false,
        exportMode: 'idle',
        exportingProgress: 0,
        ignoredCount: 0,
        folder: null,
        speed: 1,
        cropMode: false,
        cropRect: null,
        cropBoxDrag: null,
        inspectorTab: 'clip',
        settings: {
            aspect: 'source',
            resolution: 'source',
            fps: 'source',
            quality: 'standard',
            name: '',
            addToFolder: true,
            deleteSource: false,
            closeAfterExport: false,
            customAspect: null
        },
        ffmpegReady: false,
        ffmpegError: null,
        dragId: null,
        scrubDrag: false,
        cropDrag: null,
        advancing: false,
        cancelling: false,
        lastRemoved: null,
        history: { undo: [], redo: [] },
        historyRestoring: false,
        thumbDir: null,
        previewOutKey: '',
        lastUiTime: -1,
        suppressDraw: false,
        suppressTarget: null,
        suppressTimer: 0,
        savingTimer: null,
        loadingTimer: null
    };

    let video = null;
    let ffmpeg = null;
    let rafId = 0;
    const el = {};
    const NODE = (() => {
        try {
            if (typeof require === 'function') {
                return { fs: require('fs'), os: require('os'), path: require('path') };
            }
        } catch (err) { /* ignore */ }
        return null;
    })();

    /* ------------------------------------------------------------------ */
    /* boot                                                               */
    /* ------------------------------------------------------------------ */

    async function boot() {
        if (!QC) {
            document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif;color:#eee">QuickCut 无法加载核心模块。</div>';
            return;
        }
        cacheEls();
        loadSettings();
        applyTheme((window.eagle && eagle.app && eagle.app.theme) || 'GRAY');
        buildStaticUI();
        bindEvents();
        initPreview();
        updateSpeedUI();
        setupEagle();
        updateOutputUI();
        updateTransportUI();
        updateMeta();
        if (!window.eagle) {
            resetEditor('请在 Eagle 中打开 QuickCut');
        }
    }

    function cacheEls() {
        const ids = [
            'selectionMeta', 'ffmpegMeta', 'reloadBtn', 'minBtn', 'closeBtn',
            'clipList', 'clipCount', 'railHint',
            'previewIndex', 'previewName', 'outBadge', 'gridBtn',
            'previewWrap', 'previewAspect', 'previewCanvas', 'cropGrid', 'bigPlay', 'cropHint',
            'previewError', 'stageEmpty', 'cropEditor', 'cropRect', 'cropSizeLabel',
            'cropApplyBtn', 'cropCancelBtn', 'cropModeBtn',
            'playBtn', 'timeNow', 'timeTotal', 'scrub', 'scrubFill', 'scrubHead',
            'stepBackBtn', 'stepFwdBtn', 'speedBtn', 'loopBtn', 'muteBtn', 'masterVol',
            'timelinePanel', 'timelineTotal', 'timelineBody', 'timelineRuler',
            'timelineTrack', 'timelinePlayhead', 'timelineEmpty',
            'inspector', 'inspEmpty', 'inspBody', 'inspKicker', 'inspName', 'inspMeta', 'inspTabs',
            'volValue', 'clipMuteBtn', 'volSlider', 'fitSeg', 'resetCrop',
            'zoomRow', 'zoomSlider', 'zoomValue', 'cropTip',
            'aspectChips', 'exportSection', 'outputForm', 'outputMeta',
            'resSelect', 'fpsSelect', 'qualitySelect', 'outSizeText',
            'nameInput', 'folderField', 'folderCheck', 'folderLabel',
            'deleteSourceCheck', 'closeAfterExportCheck',
            'exportBtn', 'exportProgress', 'exportTitle', 'exportDetail',
            'progressFill', 'progressPct', 'cancelExportBtn',
            'topExportBtn', 'trimLeftBtn', 'splitBtn', 'trimRightBtn', 'resetTrimBtn', 'deleteClipBtn', 'editInfo',
            'undoBtn', 'redoBtn',
            'dropOverlay', 'loadingCover', 'loadingText', 'toasts', 'video', 'stage'
        ];
        for (const id of ids) el[id] = document.getElementById(id);
        el.canvasCtx = el.previewCanvas.getContext('2d');
        video = el.video;
    }

    function setupEagle() {
        if (!window.eagle) return;
        eagle.onPluginCreate(async plugin => {
            if (state.created) return;
            state.created = true;
            state.plugin = plugin;
            applyTheme(eagle.app.theme);
            if (eagle.app.locale) {
                document.documentElement.lang = String(eagle.app.locale).toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
            }
            await fitWindowToScreen();
            await loadSelection();
        });
        eagle.onPluginRun(() => {
            if (!state.created) return;
            if (Date.now() - state.loadAt < 1400 || state.loading || state.exporting) return;
            loadSelection();
        });
        if (typeof eagle.onPluginShow === 'function') {
            eagle.onPluginShow(() => {
                if (!state.created || !state.loadAt) return;
                if (Date.now() - state.loadAt < 1200 || state.loading || state.exporting) return;
                loadSelection();
            });
        }
        eagle.onThemeChanged(theme => applyTheme(theme));
        eagle.onPluginBeforeExit(() => {
            pausePlayback();
            flushEdits();
            cleanupThumbDir();
            if (ffmpeg) ffmpeg.cancel();
        });
        if (eagle.plugin && eagle.plugin.manifest) {
            state.created = true;
            state.plugin = eagle.plugin;
            loadSelection();
        }
    }

    function applyTheme(theme) {
        const value = String(theme || 'GRAY').toUpperCase();
        const light = value === 'LIGHT' || value === 'LIGHTGRAY';
        document.body.dataset.theme = light ? 'light' : 'dark';
    }

    async function fitWindowToScreen() {
        if (!eagle.screen || !eagle.window || !eagle.screen.getPrimaryDisplay) return;
        try {
            const display = await eagle.screen.getPrimaryDisplay();
            const area = display && (display.workAreaSize || display.workArea);
            if (!area || !area.width || !area.height) return;
            if (area.width >= 1260 && area.height >= 760) return;
            const width = Math.round(QC.clamp(area.width - 40, 1000, 1280));
            const height = Math.round(QC.clamp(area.height - 50, 600, 820));
            await eagle.window.setSize(width, height);
            if (eagle.window.center) await eagle.window.center();
        } catch (err) {
            console.warn('QuickCut: could not fit window to screen', err);
        }
    }

    /* ------------------------------------------------------------------ */
    /* settings                                                           */
    /* ------------------------------------------------------------------ */

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            if (Number(saved.customAspect) > 0) {
                state.settings.customAspect = QC.clamp(Number(saved.customAspect), 0.2, 5);
            }
            if (saved.aspect === 'custom' && state.settings.customAspect) {
                state.settings.aspect = 'custom';
            } else if (QC.ASPECTS.some(a => a.key === saved.aspect)) {
                state.settings.aspect = saved.aspect;
            }
            if (saved.resolution === 'source' || QC.RESOLUTIONS.some(r => r.key === saved.resolution)) state.settings.resolution = saved.resolution;
            if (saved.fps === 'source' || ['24', '25', '30', '60'].includes(String(saved.fps))) state.settings.fps = String(saved.fps);
            if (QC.QUALITIES.some(q => q.key === saved.quality)) state.settings.quality = saved.quality;
            if (typeof saved.addToFolder === 'boolean') state.settings.addToFolder = saved.addToFolder;
            if (typeof saved.deleteSource === 'boolean') state.settings.deleteSource = saved.deleteSource;
            if (typeof saved.closeAfterExport === 'boolean') state.settings.closeAfterExport = saved.closeAfterExport;
        } catch (err) {
            console.warn('QuickCut: settings read failed', err);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                aspect: state.settings.aspect,
                resolution: state.settings.resolution,
                fps: state.settings.fps,
                quality: state.settings.quality,
                addToFolder: state.settings.addToFolder,
                deleteSource: state.settings.deleteSource,
                closeAfterExport: state.settings.closeAfterExport,
                customAspect: state.settings.customAspect
            }));
        } catch (err) {
            console.warn('QuickCut: settings write failed', err);
        }
    }

    function readEdits() {
        try {
            const value = JSON.parse(localStorage.getItem(EDITS_KEY) || '{}');
            return value && typeof value === 'object' ? value : {};
        } catch (err) {
            return {};
        }
    }

    function saveEdits() {
        clearTimeout(state.savingTimer);
        state.savingTimer = setTimeout(flushEdits, 260);
    }

    function flushEdits() {
        clearTimeout(state.savingTimer);
        state.savingTimer = null;
        try {
            const all = readEdits();
            for (const clip of state.clips) {
                all[clip.eagleId] = {
                    in: clip.in,
                    out: clip.out,
                    volume: clip.volume,
                    muted: clip.muted,
                    fit: clip.fit,
                    zoom: clip.zoom,
                    offsetX: clip.offsetX,
                    offsetY: clip.offsetY,
                    manualRect: clip.manualRect || null
                };
            }
            const keys = Object.keys(all);
            if (keys.length > 300) {
                for (const key of keys.slice(0, keys.length - 300)) delete all[key];
            }
            localStorage.setItem(EDITS_KEY, JSON.stringify(all));
        } catch (err) {
            console.warn('QuickCut: edits write failed', err);
        }
    }

    /* ------------------------------------------------------------------ */
    /* static ui                                                          */
    /* ------------------------------------------------------------------ */

    function buildStaticUI() {
        el.aspectChips.innerHTML = QC.ASPECTS.map(aspect =>
            `<button type="button" data-aspect="${aspect.key}" title="${escapeAttr(aspect.hint)}">${aspect.label}</button>`
        ).join('') + `<button type="button" data-aspect="custom" id="customAspectChip" hidden>自定义</button>`;
        el.customAspectChip = document.getElementById('customAspectChip');

        el.resSelect.innerHTML = `<option value="source">原始尺寸</option>` + QC.RESOLUTIONS.map(res =>
            `<option value="${res.key}">${res.label}</option>`
        ).join('');
        el.resSelect.value = state.settings.resolution;

        el.fpsSelect.innerHTML = `<option value="source">跟随素材</option>` + ['24', '25', '30', '60'].map(fps =>
            `<option value="${fps}">${fps} fps</option>`
        ).join('');
        el.fpsSelect.value = state.settings.fps;

        el.qualitySelect.innerHTML = QC.QUALITIES.map(q =>
            `<option value="${q.key}">${q.label}</option>`
        ).join('');
        el.qualitySelect.value = state.settings.quality;

        el.nameInput.value = state.settings.name;
        el.gridBtn.classList.toggle('active', state.grid);
        el.cropGrid.classList.toggle('visible', state.grid);
        updateFolderUI();
        updateOutputUI();
    }

    function updateFolderUI() {
        const available = !!state.folder;
        el.folderField.classList.toggle('disabled', !available);
        el.folderCheck.disabled = !available;
        el.folderCheck.checked = available && state.settings.addToFolder;
        el.folderLabel.textContent = available ? `加入「${state.folder.name}」` : '未选择文件夹';
        el.folderLabel.title = available ? `导出后加入文件夹：${state.folder.name}` : '在 Eagle 侧边栏选择一个文件夹后再导出';
        if (el.deleteSourceCheck) el.deleteSourceCheck.checked = !!state.settings.deleteSource;
        if (el.closeAfterExportCheck) el.closeAfterExportCheck.checked = !!state.settings.closeAfterExport;
    }

    function updateRangeFill(input, percent) {
        if (!input) return;
        input.style.setProperty('--fill', `${QC.clamp(percent, 0, 100).toFixed(1)}%`);
    }

    /* ------------------------------------------------------------------ */
    /* events                                                             */
    /* ------------------------------------------------------------------ */

    function bindEvents() {
        $('#reloadBtn').addEventListener('click', () => loadSelection({ notify: true }));
        $('#topExportBtn').addEventListener('click', openExportPanel);
        $('#undoBtn').addEventListener('click', undo);
        $('#redoBtn').addEventListener('click', redo);
        $('#exportBtn').addEventListener('click', exportVideo);
        $('#cancelExportBtn').addEventListener('click', onCancelExport);
        $('#minBtn').addEventListener('click', () => window.eagle && eagle.window.minimize());
        $('#closeBtn').addEventListener('click', () => window.eagle && eagle.window.hide());

        $('#playBtn').addEventListener('click', togglePlay);
        $('#bigPlay').addEventListener('click', togglePlay);
        $('#stepBackBtn').addEventListener('click', () => stepFrame(-1));
        $('#stepFwdBtn').addEventListener('click', () => stepFrame(1));
        $('#speedBtn').addEventListener('click', () => cycleSpeed(-1));
        $('#cropModeBtn').addEventListener('click', toggleCropMode);
        $('#cropApplyBtn').addEventListener('click', applyManualCrop);
        $('#cropCancelBtn').addEventListener('click', cancelCropMode);
        $('#loopBtn').addEventListener('click', toggleLoop);
        $('#muteBtn').addEventListener('click', toggleMasterMute);
        $('#gridBtn').addEventListener('click', toggleGrid);

        $('#trimLeftBtn').addEventListener('click', () => trimToPlayhead('in'));
        $('#trimRightBtn').addEventListener('click', () => trimToPlayhead('out'));
        $('#splitBtn').addEventListener('click', splitClip);
        $('#resetTrimBtn').addEventListener('click', resetTrim);
        $('#deleteClipBtn').addEventListener('click', () => removeClip(state.activeId));

        el.masterVol.addEventListener('input', () => {
            state.masterVolume = Number(el.masterVol.value) || 0;
            if (state.masterMuted && state.masterVolume > 0) state.masterMuted = false;
            applyVolume();
            updateRangeFill(el.masterVol, state.masterVolume);
            updateMuteButtons();
        });

        bindScrub();
        bindTimeline();
        bindClipList();
        bindInspector();
        bindOutput();
        bindPreviewPointer();
        bindCropEditor();
        bindDropTarget();
        window.addEventListener('beforeunload', cleanupThumbDir);
        bindVideo();
        bindKeyboard();

        const ro = new ResizeObserver(() => schedulePreviewLayout());
        ro.observe(el.previewWrap);
        window.addEventListener('resize', schedulePreviewLayout);
        window.addEventListener('beforeunload', () => {
            flushEdits();
            pausePlayback();
            if (ffmpeg) ffmpeg.cancel();
        });
    }

    function bindScrub() {
        const seekFromEvent = event => {
            const rect = el.scrub.getBoundingClientRect();
            const ratio = QC.clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            seekGlobal(totalDuration() * ratio);
        };
        el.scrub.addEventListener('pointerdown', event => {
            if (!state.clips.length || event.button !== 0) return;
            state.scrubDrag = true;
            el.scrub.setPointerCapture(event.pointerId);
            seekFromEvent(event);
            event.preventDefault();
        });
        el.scrub.addEventListener('pointermove', event => {
            if (state.scrubDrag) seekFromEvent(event);
        });
        const stop = () => { state.scrubDrag = false; };
        el.scrub.addEventListener('pointerup', stop);
        el.scrub.addEventListener('pointercancel', stop);
    }

    function bindTimeline() {
        let rulerDrag = false;
        const seekFromRuler = event => {
            if (!state.clips.length) return;
            const rect = el.timelineRuler.getBoundingClientRect();
            const ratio = QC.clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            seekGlobal(ratio * totalDuration());
        };
        el.timelineRuler.addEventListener('pointerdown', event => {
            if (!state.clips.length) return;
            rulerDrag = true;
            pausePlayback();
            el.timelineRuler.setPointerCapture(event.pointerId);
            seekFromRuler(event);
            event.preventDefault();
        });
        el.timelineRuler.addEventListener('pointermove', event => {
            if (rulerDrag) seekFromRuler(event);
        });
        const stopRuler = () => { rulerDrag = false; };
        el.timelineRuler.addEventListener('pointerup', stopRuler);
        el.timelineRuler.addEventListener('pointercancel', stopRuler);

        el.timelineTrack.addEventListener('click', event => {
            const block = event.target.closest('.tl-clip');
            if (block && block.dataset.id) selectClip(block.dataset.id, { local: 0, play: state.playing });
        });

        el.timelineTrack.addEventListener('dragstart', event => {
            const block = event.target.closest('.tl-clip');
            if (!block || state.exporting || state.cropMode) {
                event.preventDefault();
                return;
            }
            state.dragId = block.dataset.id;
            block.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', state.dragId); } catch (err) { /* ignore */ }
        });
        el.timelineTrack.addEventListener('dragover', event => {
            if (!state.dragId) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            clearTimelineDropMarks();
            const block = event.target.closest('.tl-clip');
            if (!block || block.dataset.id === state.dragId) return;
            const rect = block.getBoundingClientRect();
            block.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
        });
        el.timelineTrack.addEventListener('dragleave', event => {
            if (!el.timelineTrack.contains(event.relatedTarget)) clearTimelineDropMarks();
        });
        el.timelineTrack.addEventListener('drop', event => {
            if (!state.dragId) return;
            event.preventDefault();
            const block = event.target.closest('.tl-clip');
            if (block && block.dataset.id === state.dragId) {
                state.dragId = null;
                clearTimelineDropMarks();
                $$('.tl-clip.dragging', el.timelineTrack).forEach(node => node.classList.remove('dragging'));
                return;
            }
            let before = false;
            if (block) {
                const rect = block.getBoundingClientRect();
                before = event.clientX < rect.left + rect.width / 2;
            }
            reorderClip(state.dragId, block ? block.dataset.id : null, before);
            state.dragId = null;
            clearTimelineDropMarks();
            $$('.tl-clip.dragging', el.timelineTrack).forEach(node => node.classList.remove('dragging'));
        });
        el.timelineTrack.addEventListener('dragend', () => {
            state.dragId = null;
            clearTimelineDropMarks();
            $$('.tl-clip.dragging', el.timelineTrack).forEach(node => node.classList.remove('dragging'));
        });
    }

    function clearTimelineDropMarks() {
        $$('.tl-clip.drop-before,.tl-clip.drop-after', el.timelineTrack).forEach(node => {
            node.classList.remove('drop-before', 'drop-after');
        });
    }

    function bindDropTarget() {
        let depth = 0;
        const hasFiles = event => {
            const types = event.dataTransfer && event.dataTransfer.types;
            return !!types && Array.from(types).includes('Files');
        };
        window.addEventListener('dragenter', event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth += 1;
            el.dropOverlay.hidden = false;
        });
        window.addEventListener('dragover', event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        });
        window.addEventListener('dragleave', event => {
            if (!hasFiles(event)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) el.dropOverlay.hidden = true;
        });
        window.addEventListener('drop', event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth = 0;
            el.dropOverlay.hidden = true;
            const files = Array.from(event.dataTransfer.files || []);
            if (files.length) importDropFiles(files);
        });
    }

    function bindClipList() {
        el.clipList.addEventListener('click', event => {
            const reload = event.target.closest('[data-action="reload"]');
            if (reload) {
                loadSelection({ notify: true });
                return;
            }
            const remove = event.target.closest('[data-action="remove"]');
            if (remove) {
                event.stopPropagation();
                removeClip(remove.dataset.id);
                return;
            }
            const card = event.target.closest('.clip-card');
            if (card && card.dataset.id) selectClip(card.dataset.id, { local: 0, play: state.playing });
        });

        el.clipList.addEventListener('dragstart', event => {
            if (event.target.closest('button')) {
                event.preventDefault();
                return;
            }
            const card = event.target.closest('.clip-card');
            if (!card) return;
            state.dragId = card.dataset.id;
            card.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', state.dragId); } catch (err) { /* ignore */ }
        });
        el.clipList.addEventListener('dragover', event => {
            if (!state.dragId) return;
            event.preventDefault();
            clearDropMarks();
            const card = event.target.closest('.clip-card');
            if (!card || card.dataset.id === state.dragId) return;
            const rect = card.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            card.classList.add(before ? 'drop-before' : 'drop-after');
        });
        el.clipList.addEventListener('dragleave', event => {
            if (!el.clipList.contains(event.relatedTarget)) clearDropMarks();
        });
        el.clipList.addEventListener('drop', event => {
            if (!state.dragId) return;
            event.preventDefault();
            const card = event.target.closest('.clip-card');
            if (card && card.dataset.id === state.dragId) {
                clearDropMarks();
                state.dragId = null;
                return;
            }
            let targetId = card ? card.dataset.id : null;
            let before = true;
            if (card) {
                const rect = card.getBoundingClientRect();
                before = event.clientY < rect.top + rect.height / 2;
            }
            if (targetId) reorderClip(state.dragId, targetId, before);
            else reorderClip(state.dragId, null, false);
            clearDropMarks();
            state.dragId = null;
        });
        el.clipList.addEventListener('dragend', () => {
            state.dragId = null;
            clearDropMarks();
            $$('.clip-card.dragging', el.clipList).forEach(node => node.classList.remove('dragging'));
        });
    }

    function clearDropMarks() {
        $$('.drop-before,.drop-after', el.clipList).forEach(node => node.classList.remove('drop-before', 'drop-after'));
    }

    function bindInspector() {
        el.inspTabs.addEventListener('click', event => {
            const tab = event.target.closest('.insp-tab');
            if (tab) setInspectorTab(tab.dataset.tab);
        });

        el.volSlider.addEventListener('pointerdown', () => pushHistory('调整音量'));
        el.volSlider.addEventListener('input', () => {
            const clip = getActive();
            if (!clip) return;
            clip.volume = Number(el.volSlider.value) || 0;
            if (clip.muted && clip.volume > 0) clip.muted = false;
            applyVolume();
            updateVolumeUI(clip);
            saveEdits();
        });
        el.clipMuteBtn.addEventListener('click', () => {
            const clip = getActive();
            if (!clip) return;
            pushHistory(clip.muted ? '取消静音' : '静音片段');
            clip.muted = !clip.muted;
            applyVolume();
            updateVolumeUI(clip);
            updateMuteButtons();
            saveEdits();
        });
        $$('.pills button', el.inspBody).forEach(button => {
            button.addEventListener('click', () => {
                const clip = getActive();
                if (!clip) return;
                pushHistory('调整音量');
                clip.volume = Number(button.dataset.vol);
                clip.muted = false;
                applyVolume();
                updateVolumeUI(clip);
                updateMuteButtons();
                saveEdits();
            });
        });

        el.fitSeg.addEventListener('click', event => {
            const button = event.target.closest('button[data-fit]');
            const clip = getActive();
            if (!button || !clip || clip.fit === button.dataset.fit) return;
            pushHistory('调整画面适配');
            clip.fit = button.dataset.fit;
            clip.manualRect = null;
            drawFrame();
            renderInspector();
            updateCropHint();
            saveEdits();
        });
        el.zoomSlider.addEventListener('pointerdown', () => pushHistory('缩放画面'));
        el.zoomSlider.addEventListener('input', () => {
            const clip = getActive();
            if (!clip) return;
            clip.manualRect = null;
            clip.zoom = (Number(el.zoomSlider.value) || 100) / 100;
            el.zoomValue.textContent = `${Math.round(clip.zoom * 100)}%`;
            updateRangeFill(el.zoomSlider, ((clip.zoom * 100 - 100) / 150) * 100);
            drawFrame();
            saveEdits();
        });
        el.resetCrop.addEventListener('click', () => {
            const clip = getActive();
            if (!clip) return;
            pushHistory('重置构图');
            clip.manualRect = null;
            clip.zoom = 1;
            clip.offsetX = 0;
            clip.offsetY = 0;
            drawFrame();
            renderInspector();
            saveEdits();
        });
    }

    function bindOutput() {
        el.aspectChips.addEventListener('click', event => {
            const button = event.target.closest('button[data-aspect]');
            if (!button) return;
            if (state.cropMode) cancelCropMode();
            const next = button.dataset.aspect;
            if (next === 'custom' && !(Number(state.settings.customAspect) > 0)) return;
            if (next === state.settings.aspect) return;
            pushHistory('切换画幅');
            state.settings.aspect = next;
            if (next !== 'custom') {
                for (const clip of state.clips) clip.manualRect = null;
                saveEdits();
            }
            saveSettings();
            updateOutputUI();
            schedulePreviewLayout();
            drawFrame();
        });
        el.resSelect.addEventListener('change', () => {
            state.settings.resolution = el.resSelect.value;
            saveSettings();
            updateOutputUI();
        });
        el.fpsSelect.addEventListener('change', () => {
            state.settings.fps = el.fpsSelect.value;
            saveSettings();
            updateOutputUI();
        });
        el.qualitySelect.addEventListener('change', () => {
            state.settings.quality = el.qualitySelect.value;
            saveSettings();
        });
        el.nameInput.addEventListener('input', () => {
            state.settings.name = el.nameInput.value;
            state.nameTouched = true;
        });
        el.nameInput.addEventListener('blur', () => {
            if (!el.nameInput.value.trim()) {
                el.nameInput.value = QC.defaultProjectName();
                state.settings.name = el.nameInput.value;
            }
        });
        el.folderCheck.addEventListener('change', () => {
            state.settings.addToFolder = el.folderCheck.checked;
            saveSettings();
        });
        el.deleteSourceCheck.addEventListener('change', () => {
            if (el.deleteSourceCheck.checked) {
                const ok = window.confirm('启用后，导出成功时会把来源素材移到 Eagle 垃圾桶（可在 Eagle 垃圾桶恢复）。确定启用吗？');
                if (!ok) {
                    el.deleteSourceCheck.checked = false;
                    state.settings.deleteSource = false;
                    saveSettings();
                    return;
                }
            }
            state.settings.deleteSource = el.deleteSourceCheck.checked;
            saveSettings();
            if (state.settings.deleteSource) {
                showToast('导出成功后会把这些片段对应的原素材移到 Eagle 垃圾桶', 'info', null, 3200);
            }
        });
        el.closeAfterExportCheck.addEventListener('change', () => {
            state.settings.closeAfterExport = el.closeAfterExportCheck.checked;
            saveSettings();
        });
    }

    function bindPreviewPointer() {
        el.previewCanvas.addEventListener('pointerdown', event => {
            const clip = getActive();
            if (!clip || clip.fit !== 'cover' || clip.manualRect || state.cropMode || state.previewError || event.button !== 0) return;
            state.cropDrag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                offsetX: clip.offsetX,
                offsetY: clip.offsetY
            };
            el.previewCanvas.setPointerCapture(event.pointerId);
            el.previewAspect.classList.add('dragging');
            event.preventDefault();
        });
        el.previewCanvas.addEventListener('pointermove', event => {
            if (!state.cropDrag) return;
            const clip = getActive();
            if (!clip) return;
            const rect = el.previewCanvas.getBoundingClientRect();
            const dx = event.clientX - state.cropDrag.startX;
            const dy = event.clientY - state.cropDrag.startY;
            clip.offsetX = QC.clamp(state.cropDrag.offsetX - (dx / Math.max(1, rect.width)) * 200, -100, 100);
            clip.offsetY = QC.clamp(state.cropDrag.offsetY - (dy / Math.max(1, rect.height)) * 200, -100, 100);
            drawFrame();
        });
        const endCropDrag = () => {
            if (!state.cropDrag) return;
            state.cropDrag = null;
            el.previewAspect.classList.remove('dragging');
            saveEdits();
        };
        el.previewCanvas.addEventListener('pointerup', endCropDrag);
        el.previewCanvas.addEventListener('pointercancel', endCropDrag);

        el.previewAspect.addEventListener('wheel', event => {
            const clip = getActive();
            if (!clip || clip.fit !== 'cover' || clip.manualRect || state.cropMode || state.previewError) return;
            event.preventDefault();
            const step = event.deltaY < 0 ? 0.05 : -0.05;
            clip.zoom = QC.clamp(Math.round((clip.zoom + step) * 100) / 100, 1, 2.5);
            el.zoomSlider.value = String(Math.round(clip.zoom * 100));
            el.zoomValue.textContent = `${Math.round(clip.zoom * 100)}%`;
            updateRangeFill(el.zoomSlider, ((clip.zoom * 100 - 100) / 150) * 100);
            drawFrame();
            saveEdits();
        }, { passive: false });

        el.previewAspect.addEventListener('dblclick', () => {
            const clip = getActive();
            if (!clip || clip.fit !== 'cover' || state.cropMode) return;
            clip.manualRect = null;
            clip.zoom = 1;
            clip.offsetX = 0;
            clip.offsetY = 0;
            renderInspector();
            drawFrame();
            saveEdits();
        });
    }

    function bindCropEditor() {
        el.cropRect.addEventListener('pointerdown', event => {
            if (!state.cropMode) return;
            const handle = event.target.closest('.crop-handle');
            startCropBoxDrag(event, handle ? handle.dataset.handle : 'move');
        });
    }

    function bindVideo() {
        video.addEventListener('loadedmetadata', () => {
            drawFrame();
        });
        video.addEventListener('loadeddata', () => {
            state.previewError = false;
            el.previewError.hidden = true;
            drawFrame();
        });
        video.addEventListener('seeked', () => {
            if (state.suppressDraw && state.suppressTarget != null &&
                Math.abs(video.currentTime - state.suppressTarget) > 0.01) {
                return;
            }
            state.suppressDraw = false;
            state.suppressTarget = null;
            if (state.suppressTimer) {
                clearTimeout(state.suppressTimer);
                state.suppressTimer = 0;
            }
            drawFrame();
        });
        video.addEventListener('error', () => {
            if (!state.currentClipId) return;
            state.suppressDraw = false;
            state.suppressTarget = null;
            if (state.suppressTimer) {
                clearTimeout(state.suppressTimer);
                state.suppressTimer = 0;
            }
            state.previewError = true;
            el.previewError.hidden = false;
            pausePlayback();
        });
        video.addEventListener('ended', () => {
            if (state.playing) advanceOrStop();
        });
        video.addEventListener('play', () => {
            state.playing = true;
            applyPlaybackRate();
            el.stage.classList.add('is-playing');
            updatePlayIcons();
            startTick();
        });
        video.addEventListener('pause', () => {
            el.stage.classList.remove('is-playing');
            updatePlayIcons();
        });
    }

    function bindKeyboard() {
        document.addEventListener('keydown', event => {
            const tag = (event.target && event.target.tagName) || '';
            const inputType = (event.target && event.target.type) || '';
            const isField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
            const isTextField = tag === 'TEXTAREA' || tag === 'SELECT' ||
                (tag === 'INPUT' && !['range', 'checkbox', 'radio'].includes(inputType));
            const mod = event.ctrlKey || event.metaKey;
            if (mod && event.key.toLowerCase() === 's') {
                event.preventDefault();
                exportVideo();
                return;
            }
            if (!isTextField && mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
                event.preventDefault();
                undo();
                return;
            }
            if (!isTextField && mod && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
                event.preventDefault();
                redo();
                return;
            }
            if (isField) {
                if (event.key === 'Escape') event.target.blur();
                return;
            }
            if (mod && event.key.toLowerCase() === 'e') {
                event.preventDefault();
                exportVideo();
                return;
            }
            if (event.key === 'Escape') {
                if (state.cropMode) {
                    event.preventDefault();
                    cancelCropMode();
                } else if (window.eagle && eagle.window) {
                    event.preventDefault();
                    eagle.window.hide();
                }
                return;
            }
            if ((event.key === 'c' || event.key === 'C') && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                toggleCropMode();
                return;
            }
            if (event.key === ',' || event.key === '.') {
                event.preventDefault();
                cycleSpeed(event.key === ',' ? -1 : 1);
                return;
            }
            if (event.key === ' ' || event.code === 'Space') {
                event.preventDefault();
                togglePlay();
            } else if (event.key === '[') {
                event.preventDefault();
                trimToPlayhead('in');
            } else if (event.key === ']') {
                event.preventDefault();
                trimToPlayhead('out');
            } else if ((event.key === 's' || event.key === 'S') && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                splitClip();
            } else if (event.key === 'g' || event.key === 'G') {
                toggleGrid();
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                if (state.activeId) removeClip(state.activeId);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                stepFrame(direction, event.shiftKey ? 1 : null);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* loading selected items                                             */
    /* ------------------------------------------------------------------ */

    function loadSelection(options) {
        const opts = options || {};
        if (state.exporting) {
            showToast('导出进行中，完成后才能重新载入素材', 'info');
            return Promise.resolve();
        }
        if (state.loadPromise) return state.loadPromise;
        state.loadPromise = doLoadSelection(opts).catch(err => {
            console.error('QuickCut: load failed', err);
            showToast(`载入失败：${err && err.message ? err.message : err}`, 'error');
        }).finally(() => {
            state.loadPromise = null;
            state.loading = false;
            showLoading(false);
            updateOutputUI();
        });
        return state.loadPromise;
    }

    async function doLoadSelection(options) {
        const opts = options || {};
        if (state.cropMode) cancelCropMode();
        state.loading = true;
        pausePlayback();
        const token = ++state.loadToken;
        state.loadAt = Date.now();
        showLoading(true, '正在读取 Eagle 选中素材…');
        el.selectionMeta.classList.add('busy');
        updateOutputUI();

        let selected = [];
        try {
            selected = await eagle.item.getSelected();
        } catch (err) {
            console.error(err);
            state.loading = false;
            resetEditor('无法读取 Eagle 选中素材');
            showToast('无法读取 Eagle 中选中的素材，请确认插件已正确载入', 'error');
            return;
        }
        if (token !== state.loadToken) return;
        selected = Array.isArray(selected) ? selected.filter(item => item && !item.isDeleted) : [];
        const videos = selected.filter(item => QC.isVideoExt(item.ext || extOf(item.filePath)));
        state.ignoredCount = selected.length - videos.length;

        if (!videos.length) {
            state.loading = false;
            if (!state.clips.length) {
                resetEditor(selected.length ? '选中的素材里没有视频' : '从 Eagle 拖放视频以添加，或点右上角「重新载入」');
            }
            if (opts.notify) {
                showToast(selected.length ? '选中的素材里没有视频' : 'Eagle 当前没有选中视频', 'info');
            }
            return;
        }

        try {
            await ensureFFmpeg();
        } catch (err) {
            state.ffmpegError = err;
            state.loading = false;
            updateFfmpegMeta();
            resetEditor('需要安装 FFmpeg 才能处理视频');
            showToast(err.message || 'FFmpeg 未就绪', 'error', {
                label: '安装 FFmpeg',
                onClick: () => installFfmpeg()
            }, 8000);
            return;
        }
        if (token !== state.loadToken) return;

        showLoading(true, `正在解析 ${videos.length} 个视频…`);
        const edits = readEdits();
        const results = await mapLimit(videos, 3, async item => {
            try {
                const meta = await ffmpeg.probe(item.filePath);
                if (!meta || !Number.isFinite(meta.width) || meta.width <= 0 || !Number.isFinite(meta.duration) || meta.duration <= 0.08) {
                    throw new Error('视频没有可用的画面或时长');
                }
                return { item, meta };
            } catch (err) {
                return { item, error: err };
            }
        });
        if (token !== state.loadToken) return;

        const built = [];
        const failures = [];
        for (const result of results) {
            if (result.error) {
                failures.push(result);
                continue;
            }
            built.push(buildClip(result.item, result.meta, edits));
        }

        if (!built.length) {
            state.loading = false;
            resetEditor('视频解析失败');
            showToast(failures.length ? (failures[0].error.message || '视频解析失败') : '没有可用的视频', 'error');
            return;
        }

        const previousActive = state.activeId;
        state.clips = built;
        state.lastRemoved = null;
        if (state.settings.aspect !== 'custom') {
            for (const clip of built) clip.manualRect = null;
        }
        state.activeId = built.some(clip => clip.id === previousActive) ? previousActive : built[0].id;
        if (!state.nameTouched || !state.settings.name) {
            state.settings.name = defaultNameFor(built[0]);
        }
        el.nameInput.value = state.settings.name;

        try {
            const folders = await eagle.folder.getSelected();
            state.folder = Array.isArray(folders) && folders.length ? folders[0] : null;
        } catch (err) {
            state.folder = null;
        }
        updateFolderUI();
        state.history = { undo: [], redo: [] };
        updateHistoryButtons();

        renderAll();
        selectClip(state.activeId, { local: 0, play: false });
        hydrateThumbs(built);
        updateFfmpegMeta();
        state.loading = false;
        showLoading(false);
        updateOutputUI();
        updateEditBar();

        if (failures.length) {
            const names = failures.slice(0, 2).map(f => f.item.name).join('、');
            showToast(`${failures.length} 个视频无法读取：${names}${failures.length > 2 ? ' 等' : ''}`, 'error');
            for (const failure of failures) console.warn('QuickCut: failed to read', failure.item.filePath, failure.error);
        } else if (state.ignoredCount > 0) {
            showToast(`已忽略 ${state.ignoredCount} 个非视频素材`, 'info');
        } else if (opts.notify) {
            showToast(`已载入 ${built.length} 个片段`, 'success', null, 1600);
        }
    }

    function defaultNameFor(clip) {
        return QC.sanitizeFileName(`${QC.fileStem(clip.name || '快剪')}_剪辑`);
    }

    function buildClip(item, meta, edits, idOverride) {
        const saved = edits[item.id] || {};
        const duration = Math.max(0.1, Number(meta.duration) || 0);
        const range = QC.normalizeClipRange({
            duration,
            in: saved.in == null ? 0 : saved.in,
            out: saved.out == null ? duration : saved.out
        });
        return {
            id: idOverride || item.id,
            eagleId: item.id,
            name: item.name || QC.fileStem(item.filePath || '未命名'),
            ext: item.ext || '',
            filePath: item.filePath,
            fileURL: item.fileURL,
            thumbURL: item.thumbnailURL || '',
            size: Number(item.size) || 0,
            width: meta.width,
            height: meta.height,
            rotation: meta.rotation || 0,
            duration,
            fps: Number(meta.fps) || 30,
            hasAudio: !!meta.hasAudio,
            audioChannels: Number(meta.audioChannels) || 0,
            videoCodec: meta.videoCodec || '',
            audioCodec: meta.audioCodec || '',
            in: range.in,
            out: range.out,
            volume: saved.volume == null ? 100 : QC.clamp(Number(saved.volume) || 0, 0, 200),
            muted: !!saved.muted,
            fit: saved.fit === 'contain' ? 'contain' : 'cover',
            zoom: QC.clamp(Number(saved.zoom) || 1, 1, 2.5),
            offsetX: QC.clamp(Number(saved.offsetX) || 0, -100, 100),
            offsetY: QC.clamp(Number(saved.offsetY) || 0, -100, 100),
            manualRect: saved.manualRect && Number(saved.manualRect.w) > 0
                ? QC.normalizeRect(saved.manualRect)
                : null
        };
    }

    async function ensureFFmpeg() {
        if (state.ffmpegReady) return ffmpeg;
                const modulePath = (typeof __dirname !== 'undefined' ? __dirname : (eagle.plugin && eagle.plugin.path) || '') + '/js/ffmpeg.js';
        const FFmpeg = require(modulePath);
        ffmpeg = await FFmpeg.resolveFromEagle();
        state.ffmpegReady = true;
        state.ffmpegError = null;
        updateFfmpegMeta();
        return ffmpeg;
    }

    function initThumbDir() {
        if (!NODE || state.thumbDir) return;
        try {
            state.thumbDir = NODE.path.join(NODE.os.tmpdir(), `quickcut-thumbs-${Date.now()}`);
            NODE.fs.mkdirSync(state.thumbDir, { recursive: true });
        } catch (err) {
            state.thumbDir = null;
        }
    }

    function cleanupThumbDir() {
        if (!NODE || !state.thumbDir) return;
        try { NODE.fs.rmSync(state.thumbDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
        state.thumbDir = null;
    }

    async function hydrateThumbs(clips) {
        if (!ffmpeg || !NODE) return;
        initThumbDir();
        if (!state.thumbDir) return;
        const queue = clips.filter(clip => !clip.thumbsTried && (!clip.thumbs || !clip.thumbs.length));
        const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
            while (queue.length) {
                const clip = queue.shift();
                if (clip.thumbsTried) continue;
                clip.thumbsTried = true;
                try {
                    const files = await ffmpeg.generateThumbs(clip.filePath, clip.duration, 12, state.thumbDir, clip.id);
                    if (files.length && state.clips.includes(clip)) {
                        clip.thumbs = files;
                        renderTimeline();
                    }
                } catch (err) { /* fall back to the cover thumbnail */ }
            }
        });
        await Promise.all(workers);
    }

    function updateFfmpegMeta() {
                if (state.ffmpegError) {
            el.ffmpegMeta.hidden = false;
            el.ffmpegMeta.textContent = 'FFmpeg 未就绪';
        } else {
            el.ffmpegMeta.hidden = true;
        }
    }

    function resetEditor(message) {
        pausePlayback();
        showLoading(false);
        el.selectionMeta.classList.remove('busy');
        state.clips = [];
        state.activeId = null;
        state.currentClipId = null;
        state.playhead = 0;
        state.suppressDraw = false;
        state.suppressTarget = null;
        if (state.suppressTimer) {
            clearTimeout(state.suppressTimer);
            state.suppressTimer = 0;
        }
        state.ignoredCount = 0;
        state.loading = false;
        if (video) {
            video.removeAttribute('src');
            video.load();
        }
        if (message) {
            const line = el.stageEmpty.querySelector('span');
            if (line) line.textContent = message;
        }
        renderAll();
        updateOutputUI();
        updateEditBar();
    }

    async function installFfmpeg() {
        try {
            await eagle.extraModule.ffmpeg.install();
            showToast('正在打开 FFmpeg 安装窗口，安装完成后点击「重新载入」', 'info', null, 6000);
        } catch (err) {
            showToast('无法启动 FFmpeg 安装', 'error');
        }
    }

    async function importDropFiles(files) {
        if (state.exporting) {
            showToast('导出进行中，完成后再添加素材', 'info');
            return;
        }
        if (state.loading) {
            showToast('正在解析素材，请稍候', 'info', null, 1500);
            return;
        }
        if (state.cropMode) cancelCropMode();
        const paths = files.map(file => file.path).filter(Boolean);
        if (!paths.length) {
            showToast('请从 Eagle 中拖放视频素材', 'info');
            return;
        }
        const ids = [];
        for (const filePath of paths) {
            const match = String(filePath).match(/([^/\\]+)\.info[\\/]/);
            if (match && !ids.includes(match[1])) ids.push(match[1]);
        }
        if (!ids.length) {
            showToast('没有识别到 Eagle 素材，请直接从 Eagle 拖放', 'info');
            return;
        }
        try {
            const items = await eagle.item.getByIds(ids);
            const videos = (items || []).filter(item => item && !item.isDeleted && QC.isVideoExt(item.ext || extOf(item.filePath)));
            if (!videos.length) {
                showToast('拖入的素材里没有视频', 'info');
                return;
            }
            await appendItems(videos);
        } catch (err) {
            console.error('QuickCut: drop failed', err);
            showToast('拖入素材失败，请重试', 'error');
        }
    }

    async function appendItems(items) {
        if (!items.length || state.exporting) return;
        state.loading = true;
        showLoading(true, `正在解析 ${items.length} 个视频…`);
        try {
            await ensureFFmpeg();
        } catch (err) {
            state.loading = false;
            showLoading(false);
            state.ffmpegError = err;
            updateFfmpegMeta();
            showToast(err.message || 'FFmpeg 未就绪', 'error', {
                label: '安装 FFmpeg',
                onClick: () => installFfmpeg()
            }, 8000);
            return;
        }
        const token = ++state.loadToken;
        const edits = readEdits();
        const results = await mapLimit(items, 3, async item => {
            try {
                const meta = await ffmpeg.probe(item.filePath);
                return { item, meta };
            } catch (err) {
                return { item, error: err };
            }
        });
        if (token !== state.loadToken) return;
        const built = [];
        const failures = [];
        for (const result of results) {
            if (result.error) {
                failures.push(result);
                continue;
            }
            let id = result.item.id;
            let suffix = 2;
            while (state.clips.some(clip => clip.id === id) || built.some(clip => clip.id === id)) {
                id = `${result.item.id}-${suffix++}`;
            }
            built.push(buildClip(result.item, result.meta, edits, id));
        }
        state.loading = false;
        showLoading(false);
        if (!built.length) {
            showToast(failures.length ? (failures[0].error.message || '视频解析失败') : '没有可用的视频', 'error');
            return;
        }
        if (!state.clips.length) {
            resetEditor();
        }
        pushHistory('添加素材');
        state.clips.push(...built);
        state.activeId = built[0].id;
        if (!state.settings.name) {
            state.settings.name = defaultNameFor(state.clips[0]);
            el.nameInput.value = state.settings.name;
        }
        try {
            const folders = await eagle.folder.getSelected();
            state.folder = Array.isArray(folders) && folders.length ? folders[0] : null;
            updateFolderUI();
        } catch (err) { /* keep last known folder */ }
        renderAll();
        selectClip(built[0].id, { local: 0, play: false });
        hydrateThumbs(built);
        showToast(`已添加 ${built.length} 个片段`, 'success', null, 1800);
        if (failures.length) {
            showToast(`${failures.length} 个视频无法读取`, 'error');
        }
    }

    function showLoading(show, text) {
        clearTimeout(state.loadingTimer);
        if (show) {
            if (text) el.loadingText.textContent = text;
            el.selectionMeta.classList.add('busy');
            state.loadingTimer = setTimeout(() => {
                if (state.loading) el.loadingCover.hidden = false;
            }, 160);
        } else {
            el.loadingCover.hidden = true;
            el.selectionMeta.classList.remove('busy');
        }
    }

    /* ------------------------------------------------------------------ */
    /* rendering                                                          */
    /* ------------------------------------------------------------------ */

    function renderAll() {
        renderClipList();
        renderTimeline();
        renderInspector();
        updateMeta();
        updateOutputUI();
        updateTransportUI();
        updateCropHint();
        updateMuteButtons();
        updateEditBar();
        const empty = !state.clips.length;
        el.timelineEmpty.hidden = !empty;
        el.stageEmpty.hidden = !empty;
        el.previewAspect.style.visibility = empty ? 'hidden' : 'visible';
        if (!empty) {
            const line = el.stageEmpty.querySelector('span');
            if (line) line.textContent = '从 Eagle 拖放视频到此处，或点右上角「重新载入」';
        }
        updateTimelinePlayhead();
    }

    function renderClipList() {
        const scrollTop = el.clipList.scrollTop;
        el.clipCount.textContent = String(state.clips.length);
        if (!state.clips.length) {
            el.clipList.innerHTML = `<div class="rail-empty">
                <svg class="ic"><use href="#i-film"/></svg>
                <strong>尚未选择视频</strong>
                <span>从 Eagle 拖放视频以添加</span>
            </div>`;
            el.clipList.scrollTop = 0;
            return;
        }
        el.clipList.innerHTML = state.clips.map((clip, index) => {
            const active = clip.id === state.activeId ? ' active' : '';
            const thumb = clip.thumbURL
                ? `<img src="${escapeAttr(clip.thumbURL)}" alt="" draggable="false" onerror="this.remove()">`
                : '';
            const audio = clip.hasAudio ? '有声' : '<span class="warn">无声</span>';
            const trimmed = clip.in > 0.05 || clip.out < clip.duration - 0.05;
            const rangeLeft = (clip.in / clip.duration) * 100;
            const rangeWidth = ((clip.out - clip.in) / clip.duration) * 100;
            return `<article class="clip-card${active}" data-id="${escapeAttr(clip.id)}" draggable="true">
                <div class="clip-thumb">
                    <span class="no-thumb"><svg class="ic"><use href="#i-film"/></svg></span>
                    ${thumb}
                    <span class="clip-index">${String(index + 1).padStart(2, '0')}</span>
                    <span class="clip-duration">${QC.formatTime(clipDuration(clip))}</span>
                </div>
                <div class="clip-body">
                    <div class="clip-name" title="${escapeAttr(clip.name)}">${escapeHtml(clip.name)}</div>
                    <div class="clip-sub">
                        <span>${clip.width}×${clip.height}</span><i class="dot"></i><span>${Math.round(clip.fps)}fps</span>
                        <i class="dot"></i>${audio}${trimmed ? '<i class="dot"></i><span>已裁剪</span>' : ''}
                    </div>
                    <div class="clip-range"><i style="left:${rangeLeft}%;width:${rangeWidth}%"></i></div>
                </div>
                <button class="clip-remove" data-action="remove" data-id="${escapeAttr(clip.id)}" title="移除片段" draggable="false">
                    <svg class="ic"><use href="#i-close"/></svg>
                </button>
            </article>`;
        }).join('');
        el.clipList.scrollTop = scrollTop;
    }

    function renderTimeline() {
        renderTimelineRuler();
        if (!state.clips.length) {
            el.timelineTrack.innerHTML = '';
            el.timelineEmpty.hidden = false;
            updateTimelinePlayhead();
            return;
        }
        el.timelineEmpty.hidden = true;
        el.timelineTrack.innerHTML = state.clips.map((clip, index) => {
            const active = clip.id === state.activeId ? ' active' : '';
            const thumbs = timelineThumbs(clip);
            const tiles = thumbs.length
                ? thumbs.map(item => `<img src="${escapeAttr(item.url)}" alt="" draggable="false">`).join('')
                : (clip.thumbURL ? `<img src="${escapeAttr(clip.thumbURL)}" alt="" draggable="false">` : '');
            return `<div class="tl-clip${active}" draggable="true" data-id="${escapeAttr(clip.id)}" style="flex:${Math.max(0.1, clipDuration(clip))} 1 0" title="${escapeAttr(clip.name)}">
                <div class="tl-tiles">${tiles}</div>
                <div class="tl-shade"></div>
                <div class="tl-label"><b>${index + 1}</b><span>${escapeHtml(clip.name)}</span><em>${QC.formatTime(clipDuration(clip))}</em></div>
            </div>`;
        }).join('');
        requestAnimationFrame(updateTimelinePlayhead);
    }

    function timelineThumbs(clip) {
        const all = Array.isArray(clip.thumbs) ? clip.thumbs : [];
        let list = all.filter(item => item.time >= clip.in - 0.001 && item.time <= clip.out + 0.001);
        if (!list.length && all.length) {
            const middle = (clip.in + clip.out) / 2;
            list = [all.reduce((best, item) => Math.abs(item.time - middle) < Math.abs(best.time - middle) ? item : best, all[0])];
        }
        if (list.length > 8) {
            const step = (list.length - 1) / 7;
            list = Array.from({ length: 8 }, (_, i) => list[Math.round(i * step)]);
        }
        return list;
    }

    function renderTimelineRuler() {
        const total = totalDuration();
        el.timelineRuler.innerHTML = '';
        if (total <= 0) return;
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
            const ratio = i / ticks;
            const time = total * ratio;
            const cls = i === 0 ? ' first' : i === ticks ? ' last' : '';
            el.timelineRuler.insertAdjacentHTML('beforeend',
                `<span class="ruler-tick" style="left:${ratio * 100}%"></span>` +
                `<span class="ruler-label${cls}" style="left:${ratio * 100}%">${QC.formatClock(time)}</span>`
            );
        }
    }

    function setInspectorTab(tab) {
        if (tab !== 'clip' && tab !== 'output') return;
        state.inspectorTab = tab;
        if (el.inspTabs) el.inspTabs.hidden = !getActive();
        $$('.insp-tab', el.inspTabs).forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tab);
        });
        $$('[data-pane]', el.inspBody).forEach(pane => {
            pane.hidden = pane.dataset.pane !== tab;
        });
        if (el.inspector) el.inspector.scrollTop = 0;
    }

    function renderInspector() {
        const clip = getActive();
        if (!clip) {
            el.inspTabs.hidden = true;
            el.inspEmpty.hidden = false;
            el.inspBody.hidden = true;
            return;
        }
        el.inspTabs.hidden = false;
        el.inspEmpty.hidden = true;
        el.inspBody.hidden = false;
        setInspectorTab(state.inspectorTab);
        const index = activeIndex();
        el.inspKicker.textContent = `片段 ${String(index + 1).padStart(2, '0')} / ${String(state.clips.length).padStart(2, '0')}`;
        el.inspName.textContent = clip.name;
        el.inspMeta.textContent = `${clip.width}×${clip.height} · ${Math.round(clip.fps)}fps · ${clip.hasAudio ? '有声' : '无声'} · ${formatCodec(clip.videoCodec) || '视频'}`;
        el.volSlider.value = String(Math.round(clip.volume));
        updateVolumeUI(clip);
        el.zoomSlider.value = String(Math.round(clip.zoom * 100));
        el.zoomValue.textContent = `${Math.round(clip.zoom * 100)}%`;
        updateRangeFill(el.zoomSlider, ((clip.zoom * 100 - 100) / 150) * 100);
        const contain = clip.fit === 'contain';
        const manual = !!clip.manualRect;
        el.zoomRow.classList.toggle('disabled', contain || manual);
        el.zoomSlider.disabled = contain || manual;
        $$('#fitSeg button', el.inspBody).forEach(button => {
            button.classList.toggle('active', button.dataset.fit === clip.fit);
        });
        el.cropTip.textContent = manual
            ? '当前使用手动框选画幅，点「重置构图」恢复自动取景。'
            : contain
                ? '完整画面模式会自动留出黑边，不裁剪。'
                : '在预览中拖动画面可调整取景位置，滚轮缩放。';
        el.previewAspect.classList.toggle('can-pan', !contain && !manual);
        updateCropHint();
    }

    function snapshotState() {
        return {
            clips: JSON.parse(JSON.stringify(state.clips)),
            activeId: state.activeId,
            playhead: state.playhead,
            aspect: state.settings.aspect,
            customAspect: state.settings.customAspect
        };
    }

    function pushHistory(label) {
        if (state.historyRestoring || state.exporting) return;
        const snapshot = snapshotState();
        state.history.undo.push({ label, data: snapshot });
        if (state.history.undo.length > 50) state.history.undo.shift();
        state.history.redo = [];
        updateHistoryButtons();
    }

    function updateHistoryButtons() {
        if (el.undoBtn) el.undoBtn.disabled = !state.history.undo.length || state.exporting;
        if (el.redoBtn) el.redoBtn.disabled = !state.history.redo.length || state.exporting;
    }

    function restoreSnapshot(snapshot) {
        if (!snapshot) return;
        state.historyRestoring = true;
        try {
            state.clips = JSON.parse(JSON.stringify(snapshot.clips || []));
            state.settings.aspect = snapshot.aspect || 'source';
            state.settings.customAspect = snapshot.customAspect == null ? null : snapshot.customAspect;
            state.activeId = state.clips.some(clip => clip.id === snapshot.activeId)
                ? snapshot.activeId
                : (state.clips[0] ? state.clips[0].id : null);
            state.currentClipId = null;
            state.playhead = QC.clamp(Number(snapshot.playhead) || 0, 0, totalDuration());
            saveSettings();
            saveEdits();
            renderAll();
            const clip = getActive();
            if (clip) {
                const index = activeIndex();
                const local = QC.clamp(state.playhead - clipStart(index), 0, clipDuration(clip));
                selectClip(clip.id, { local, play: false });
            } else {
                video.removeAttribute('src');
                video.load();
                renderAll();
            }
            for (const item of state.clips) {
                if (!item.thumbs || !item.thumbs.length) item.thumbsTried = false;
            }
            hydrateThumbs(state.clips);
        } finally {
            state.historyRestoring = false;
        }
        updateHistoryButtons();
    }

    function undo() {
        if (state.exporting) return;
        if (state.cropMode) cancelCropMode();
        if (!state.history.undo.length) {
            showToast('没有可撤销的操作', 'info', null, 1200);
            return;
        }
        const entry = state.history.undo.pop();
        state.history.redo.push({ label: entry.label, data: snapshotState() });
        restoreSnapshot(entry.data);
        showToast(`已撤销：${entry.label}`, 'info', null, 1500);
    }

    function redo() {
        if (state.exporting) return;
        if (state.cropMode) cancelCropMode();
        if (!state.history.redo.length) {
            showToast('没有可恢复的操作', 'info', null, 1200);
            return;
        }
        const entry = state.history.redo.pop();
        state.history.undo.push({ label: entry.label, data: snapshotState() });
        restoreSnapshot(entry.data);
        showToast(`已恢复：${entry.label}`, 'info', null, 1500);
    }

    function updateEditBar() {
        const clip = getActive();
        const disabled = !clip || state.exporting || state.cropMode;
        [el.trimLeftBtn, el.splitBtn, el.trimRightBtn, el.resetTrimBtn, el.deleteClipBtn].forEach(button => {
            if (button) button.disabled = disabled;
        });
        el.timelineTotal.textContent = QC.formatTime(totalDuration());
        if (!clip) {
            el.editInfo.textContent = '尚未选择片段';
            updateHistoryButtons();
            return;
        }
        const index = activeIndex();
        el.editInfo.textContent = `片段 ${index + 1} / ${state.clips.length} · ${QC.formatTime(clip.out - clip.in)} · ${clip.name}`;
        updateHistoryButtons();
    }

    function updateVolumeUI(clip) {
        el.volSlider.value = String(Math.round(clip.volume));
        updateRangeFill(el.volSlider, (clip.volume / 200) * 100);
        const db = clip.volume <= 0 ? '−∞ dB' : `${(20 * Math.log10(clip.volume / 100)).toFixed(1)} dB`;
        el.volValue.textContent = `${Math.round(clip.volume)}% · ${db}`;
        updateMuteButtons();
    }

    function updateMuteButtons() {
        const clip = getActive();
        const clipMuted = !!(clip && (clip.muted || clip.volume <= 0));
        el.clipMuteBtn.classList.toggle('active', clipMuted);
        setIcon(el.clipMuteBtn, clipMuted ? '#i-mute' : '#i-volume');
        const masterMuted = state.masterMuted || state.masterVolume <= 0;
        el.muteBtn.classList.toggle('active', masterMuted);
        setIcon(el.muteBtn, masterMuted ? '#i-mute' : '#i-volume');
        updateRangeFill(el.masterVol, state.masterVolume);
    }

    function updateCropHint() {
        const clip = getActive();
        if (!clip || clip.fit === 'contain' || clip.manualRect || state.cropMode) {
            el.cropHint.classList.add('off');
        } else {
            el.cropHint.classList.remove('off');
        }
    }

    /* ------------------------------------------------------------------ */
    /* manual crop                                                        */
    /* ------------------------------------------------------------------ */

    function formatAspect(ratio) {
        const value = Number(ratio);
        if (!Number.isFinite(value) || value <= 0) return '—';
        const presets = [[16, 9], [9, 16], [4, 5], [3, 4], [1, 1], [4, 3], [3, 2], [21, 9]];
        for (const [w, h] of presets) {
            if (Math.abs(value - w / h) < 0.004) return `${w}:${h}`;
        }
        return `${value.toFixed(2)}:1`;
    }

    function toggleCropMode() {
        if (state.cropMode) cancelCropMode();
        else enterCropMode();
    }

    function enterCropMode() {
        if (!state.clips.length) return;
        if (state.exporting || state.loading) {
            showToast(state.exporting ? '导出中，暂不能框选画幅' : '素材还在解析中，请稍候', 'info');
            return;
        }
        const clip = getActive();
        if (!clip) return;
        pausePlayback();
        state.cropMode = true;
        state.cropRect = initialCropRect(clip);
        el.stage.classList.add('crop-mode');
        el.cropEditor.hidden = false;
        el.cropModeBtn.classList.add('active');
        const label = el.cropModeBtn.querySelector('span');
        if (label) label.textContent = '框选中';
        updateCropEditorUI();
        schedulePreviewLayout();
        drawFrame();
        updateCropHint();
        updateEditBar();
    }

    function cancelCropMode() {
        if (!state.cropMode) return;
        endCropBoxDrag();
        state.cropMode = false;
        state.cropRect = null;
        el.stage.classList.remove('crop-mode');
        el.cropEditor.hidden = true;
        el.cropModeBtn.classList.remove('active');
        const label = el.cropModeBtn.querySelector('span');
        if (label) label.textContent = '框选';
        schedulePreviewLayout();
        drawFrame();
        updateCropHint();
        updateEditBar();
    }

    function initialCropRect(clip) {
        if (clip.manualRect) return QC.normalizeRect(clip.manualRect);
        if (clip.fit === 'contain' || !clip.width || !clip.height) {
            return { x: 0, y: 0, w: 1, h: 1 };
        }
        const ratio = QC.aspectRatioFor(state.settings.aspect, state.clips[0], state.settings.customAspect);
        const crop = QC.computeCropRect({
            srcW: clip.width,
            srcH: clip.height,
            aspectW: ratio,
            aspectH: 1,
            zoom: clip.zoom,
            offsetX: clip.offsetX,
            offsetY: clip.offsetY
        });
        return QC.normalizeRect({
            x: crop.x / clip.width,
            y: crop.y / clip.height,
            w: crop.w / clip.width,
            h: crop.h / clip.height
        });
    }

    function updateCropEditorUI() {
        const clip = getActive();
        const rect = state.cropRect;
        if (!clip || !rect) return;
        el.cropRect.style.left = `${rect.x * 100}%`;
        el.cropRect.style.top = `${rect.y * 100}%`;
        el.cropRect.style.width = `${rect.w * 100}%`;
        el.cropRect.style.height = `${rect.h * 100}%`;
        const pixelWidth = Math.max(1, Math.round(rect.w * clip.width));
        const pixelHeight = Math.max(1, Math.round(rect.h * clip.height));
        el.cropSizeLabel.textContent = `${formatAspect(pixelWidth / pixelHeight)} · ${pixelWidth} × ${pixelHeight}`;
    }

    function applyManualCrop() {
        if (!state.cropMode) return;
        const clip = getActive();
        if (!clip || !state.cropRect) {
            cancelCropMode();
            return;
        }
        const rect = QC.normalizeRect(state.cropRect);
        const rawAspect = (rect.w * clip.width) / (rect.h * clip.height);
        if (!Number.isFinite(rawAspect) || rawAspect < 0.2 || rawAspect > 5) {
            showToast('框选比例过于极端，请重新框选', 'error');
            return;
        }
        const aspect = rawAspect;
        pushHistory('手动框选画幅');
        state.settings.customAspect = aspect;
        state.settings.aspect = 'custom';
        for (const item of state.clips) item.manualRect = null;
        clip.manualRect = rect;
        clip.zoom = 1;
        clip.offsetX = 0;
        clip.offsetY = 0;
        clip.fit = 'cover';
        state.cropMode = false;
        state.cropRect = null;
        el.stage.classList.remove('crop-mode');
        el.cropEditor.hidden = true;
        el.cropModeBtn.classList.remove('active');
        const label = el.cropModeBtn.querySelector('span');
        if (label) label.textContent = '框选';
        saveSettings();
        saveEdits();
        renderAll();
        updateOutputUI();
        schedulePreviewLayout();
        drawFrame();
        showToast(`已应用自定义画幅 ${formatAspect(aspect)}`, 'success', null, 2200);
    }

    function startCropBoxDrag(event, handle) {
        if (!state.cropMode || !state.cropRect) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = el.previewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        state.cropBoxDrag = {
            handle: handle || 'move',
            rect,
            startX: event.clientX,
            startY: event.clientY,
            start: { ...state.cropRect }
        };
        window.addEventListener('pointermove', onCropBoxMove);
        window.addEventListener('pointerup', endCropBoxDrag);
        window.addEventListener('pointercancel', endCropBoxDrag);
    }

    function onCropBoxMove(event) {
        const drag = state.cropBoxDrag;
        if (!drag) return;
        event.preventDefault();
        const dx = (event.clientX - drag.startX) / Math.max(1, drag.rect.width);
        const dy = (event.clientY - drag.startY) / Math.max(1, drag.rect.height);
        const start = drag.start;
        const min = 0.03;
        let x = start.x;
        let y = start.y;
        let w = start.w;
        let h = start.h;
        if (drag.handle === 'move') {
            x = QC.clamp(start.x + dx, 0, 1 - w);
            y = QC.clamp(start.y + dy, 0, 1 - h);
        } else {
            let left = start.x;
            let right = start.x + start.w;
            let top = start.y;
            let bottom = start.y + start.h;
            if (drag.handle.includes('w')) left = QC.clamp(left + dx, 0, right - min);
            if (drag.handle.includes('e')) right = QC.clamp(right + dx, left + min, 1);
            if (drag.handle.includes('n')) top = QC.clamp(top + dy, 0, bottom - min);
            if (drag.handle.includes('s')) bottom = QC.clamp(bottom + dy, top + min, 1);
            x = left;
            y = top;
            w = right - left;
            h = bottom - top;
        }
        state.cropRect = {
            x: Math.round(x * 10000) / 10000,
            y: Math.round(y * 10000) / 10000,
            w: Math.round(w * 10000) / 10000,
            h: Math.round(h * 10000) / 10000
        };
        updateCropEditorUI();
    }

    function endCropBoxDrag() {
        window.removeEventListener('pointermove', onCropBoxMove);
        window.removeEventListener('pointerup', endCropBoxDrag);
        window.removeEventListener('pointercancel', endCropBoxDrag);
        state.cropBoxDrag = null;
    }

    function updateMeta() {
        const total = totalDuration();
        const count = state.clips.length;
        if (count) {
            const ignored = state.ignoredCount ? ` · 忽略 ${state.ignoredCount} 个非视频` : '';
            el.selectionMeta.textContent = `${count} 段 · 总时长 ${QC.formatTime(total)}${ignored}`;
            el.selectionMeta.title = `已载入 ${count} 个视频片段`;
        } else {
            el.selectionMeta.textContent = state.loading ? '正在载入素材…' : '尚未选择视频 · 从 Eagle 拖放';
            el.selectionMeta.title = '从 Eagle 拖放视频到窗口，或在 Eagle 中选中视频后点「重新载入」';
        }
        el.clipCount.textContent = String(count);
        const clip = getActive();
        const index = activeIndex();
        el.previewIndex.textContent = count ? `${index + 1} / ${count}` : '0 / 0';
        el.previewName.textContent = clip ? clip.name : '';
        el.timeTotal.textContent = QC.formatTime(total);
    }

    function sourceShortEdge() {
        if (!state.clips.length) return 1080;
        const shortest = Math.min(...state.clips.map(clip => Math.min(clip.width || 0, clip.height || 0)).filter(Boolean));
        return QC.makeEven(QC.clamp(shortest || 1080, 240, 2160));
    }

    function sourceFps() {
        if (!state.clips.length) return 30;
        const fps = Math.max(...state.clips.map(clip => Number(clip.fps) || 30));
        return Math.round(QC.clamp(fps, 1, 120) * 100) / 100;
    }

    function resolvedShortEdge() {
        if (state.settings.resolution === 'source') return sourceShortEdge();
        const resolution = QC.RESOLUTIONS.find(r => r.key === state.settings.resolution);
        return resolution ? resolution.short : 1080;
    }

    function resolvedFps() {
        if (state.settings.fps === 'source') return sourceFps();
        return QC.clamp(Number(state.settings.fps) || 30, 1, 120);
    }

    function outputSizeNow() {
        const ratio = QC.aspectRatioFor(state.settings.aspect, state.clips[0], state.settings.customAspect);
        return QC.computeOutputSize(ratio, resolvedShortEdge());
    }

    function updateOutputUI() {
        const size = outputSizeNow();
        el.outBadge.hidden = !state.clips.length;
        el.outBadge.textContent = state.clips.length ? `${size.width} × ${size.height}` : '—';
        const aspectTitle = state.settings.aspect === 'source'
            ? '跟随首段素材'
            : state.settings.aspect === 'custom'
                ? `自定义 ${formatAspect(state.settings.customAspect)}`
                : state.settings.aspect;
        const resolutionLabel = state.settings.resolution === 'source' ? '原始尺寸' : (QC.RESOLUTIONS.find(r => r.key === state.settings.resolution) || {}).label;
        el.outBadge.title = `${aspectTitle} · ${resolutionLabel || ''}`;
        el.outSizeText.textContent = state.clips.length ? `${size.width} × ${size.height}` : '—';
        el.outputMeta.textContent = 'MP4 · H.264';

        const hasCustom = Number(state.settings.customAspect) > 0;
        if (el.customAspectChip) {
            el.customAspectChip.hidden = !hasCustom;
            if (hasCustom) {
                el.customAspectChip.textContent = `自定义 ${formatAspect(state.settings.customAspect)}`;
                el.customAspectChip.title = `手动框选的画幅 ${formatAspect(state.settings.customAspect)}`;
            }
        }
        $$('#aspectChips button', el.aspectChips).forEach(button => {
            button.classList.toggle('active', button.dataset.aspect === state.settings.aspect);
        });
        const resSource = el.resSelect.querySelector('option[value="source"]');
        if (resSource) resSource.textContent = `原始尺寸 (${sourceShortEdge()}p)`;
        const fpsSource = el.fpsSelect.querySelector('option[value="source"]');
        if (fpsSource) fpsSource.textContent = `跟随素材 (${sourceFps()} fps)`;
        if (el.resSelect.value !== state.settings.resolution) el.resSelect.value = state.settings.resolution;
        if (el.fpsSelect.value !== state.settings.fps) el.fpsSelect.value = state.settings.fps;
        if (el.qualitySelect.value !== state.settings.quality) el.qualitySelect.value = state.settings.quality;
        if (document.activeElement !== el.nameInput && el.nameInput.value !== state.settings.name) {
            el.nameInput.value = state.settings.name;
        }
        updateFolderUI();
        const disabled = !state.clips.length || state.exporting || state.loading;
        el.exportBtn.disabled = disabled;
        if (el.topExportBtn) el.topExportBtn.disabled = !state.clips.length || state.exporting;
        el.reloadBtn.disabled = state.exporting;

        const key = `${size.width}x${size.height}`;
        if (key !== state.previewOutKey) {
            state.previewOutKey = key;
            schedulePreviewLayout();
        }
    }

    /* ------------------------------------------------------------------ */
    /* preview                                                            */
    /* ------------------------------------------------------------------ */

    function initPreview() {
        video.volume = 1;
        video.muted = false;
        window.addEventListener('resize', schedulePreviewLayout);
        requestAnimationFrame(updatePreviewLayout);
    }

    let layoutFrame = 0;
    function schedulePreviewLayout() {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            updatePreviewLayout();
        });
    }

    function updatePreviewLayout() {
        const clip = getActive();
        const cropMode = state.cropMode && clip;
        const ratio = cropMode
            ? (clip.width / clip.height || 16 / 9)
            : (QC.aspectRatioFor(state.settings.aspect, state.clips[0], state.settings.customAspect) || 16 / 9);
        const wrap = el.previewWrap;
        const availW = Math.max(120, wrap.clientWidth - 32);
        const availH = Math.max(80, wrap.clientHeight - 32);
        let width = availW;
        let height = width / ratio;
        if (height > availH) {
            height = availH;
            width = height * ratio;
        }
        width = Math.max(80, Math.floor(width));
        height = Math.max(45, Math.floor(height));
        el.previewAspect.style.width = `${width}px`;
        el.previewAspect.style.height = `${height}px`;

        const size = cropMode
            ? { width: clip.width, height: clip.height }
            : outputSizeNow();
        const scale = Math.min(1, 1280 / Math.max(size.width, size.height));
        const cw = Math.max(64, Math.round(size.width * scale));
        const ch = Math.max(36, Math.round(size.height * scale));
        if (el.previewCanvas.width !== cw || el.previewCanvas.height !== ch) {
            el.previewCanvas.width = cw;
            el.previewCanvas.height = ch;
        }
        drawFrame();
        updateTransportUI();
    }

    const posterCache = new Map();

    function getPoster(url) {
        if (!url) return null;
        let image = posterCache.get(url);
        if (!image) {
            image = new Image();
            image.decoding = 'async';
            image.onload = () => {
                const clip = getActive();
                if (clip && clip.thumbURL === url) drawFrame();
            };
            image.src = url;
            posterCache.set(url, image);
        }
        return image;
    }

    function drawFrame() {
        if (state.suppressDraw) return;
        const canvas = el.previewCanvas;
        const ctx = el.canvasCtx;
        if (!canvas || !ctx) return;
        const cw = canvas.width;
        const ch = canvas.height;
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        const clip = getActive();
        if (!clip) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        try {
            const source = video.readyState >= 2 && video.videoWidth && video.videoHeight ? video : null;
            const sourceWidth = source ? video.videoWidth : 0;
            const sourceHeight = source ? video.videoHeight : 0;
            const poster = source ? null : (clip.thumbURL ? getPoster(clip.thumbURL) : null);
            const posterReady = poster && poster.complete && poster.naturalWidth;
            if (state.cropMode) {
                if (source) paintFull(ctx, source, sourceWidth, sourceHeight, cw, ch);
                else if (posterReady) paintFull(ctx, poster, poster.naturalWidth, poster.naturalHeight, cw, ch);
                return;
            }
            if (source) paintSource(ctx, source, sourceWidth, sourceHeight, clip, cw, ch);
            else if (posterReady) paintSource(ctx, poster, poster.naturalWidth, poster.naturalHeight, clip, cw, ch);
        } catch (err) {
            console.warn('QuickCut: draw failed', err);
        }
    }

    function paintFull(ctx, source, sourceWidth, sourceHeight, cw, ch) {
        const scale = Math.min(cw / sourceWidth, ch / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        ctx.drawImage(source, (cw - width) / 2, (ch - height) / 2, width, height);
    }

    function paintSource(ctx, source, sourceWidth, sourceHeight, clip, cw, ch) {
        if (clip.manualRect) {
            const crop = QC.manualRectToCrop(sourceWidth, sourceHeight, clip.manualRect);
            ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, cw, ch);
            return;
        }
        if (clip.fit === 'contain') {
            paintFull(ctx, source, sourceWidth, sourceHeight, cw, ch);
            return;
        }
        const crop = QC.computeCropRect({
            srcW: sourceWidth,
            srcH: sourceHeight,
            aspectW: cw,
            aspectH: ch,
            zoom: clip.zoom,
            offsetX: clip.offsetX,
            offsetY: clip.offsetY
        });
        ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, cw, ch);
    }

    /* ------------------------------------------------------------------ */
    /* clip selection and playback                                        */
    /* ------------------------------------------------------------------ */

    function getActive() {
        return state.clips.find(clip => clip.id === state.activeId) || null;
    }

    function activeIndex() {
        return state.clips.findIndex(clip => clip.id === state.activeId);
    }

    function clipDuration(clip) {
        return Math.max(0, (Number(clip.out) || 0) - (Number(clip.in) || 0));
    }

    function clipStart(index) {
        let sum = 0;
        for (let i = 0; i < index; i++) sum += clipDuration(state.clips[i]);
        return sum;
    }

    function totalDuration() {
        return state.clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
    }

    function globalToClip(seconds) {
        const total = totalDuration();
        const time = QC.clamp(seconds, 0, total);
        let acc = 0;
        for (let i = 0; i < state.clips.length; i++) {
            const clip = state.clips[i];
            const duration = clipDuration(clip);
            if (time < acc + duration || i === state.clips.length - 1) {
                return { clip, index: i, local: QC.clamp(time - acc, 0, duration) };
            }
            acc += duration;
        }
        return { clip: state.clips[0], index: 0, local: 0 };
    }

    function selectClip(id, options) {
        const opts = options || {};
        if (state.cropMode && id !== state.activeId) cancelCropMode();
        const index = state.clips.findIndex(clip => clip.id === id);
        if (index < 0) return;
        const clip = state.clips[index];
        const same = state.activeId === id;
        state.activeId = id;
        const duration = clipDuration(clip);
        const local = QC.clamp(Number(opts.local) || 0, 0, duration);
        state.playhead = clipStart(index) + local;
        if (opts.play !== undefined) state.playing = !!opts.play;
        if (!same) {
            renderClipList();
            renderTimeline();
            renderInspector();
        }
        updateMeta();
        updateEditBar();
        loadVideoForClip(clip, local, state.playing);
        updateTransportUI();
        updateOutputUI();
    }

    function loadVideoForClip(clip, local, autoplay) {
        const target = QC.clamp(clip.in + local, clip.in, Math.max(clip.in, clip.out - 0.01));
        const newSource = state.currentClipId !== clip.id;
        if (newSource) {
            state.currentClipId = clip.id;
            state.previewError = false;
            state.suppressDraw = true;
            state.suppressTarget = target;
            if (state.suppressTimer) clearTimeout(state.suppressTimer);
            state.suppressTimer = setTimeout(() => {
                state.suppressDraw = false;
                state.suppressTarget = null;
                drawFrame();
            }, 2500);
            el.previewError.hidden = true;
            video.src = clip.fileURL;
            video.load();
        }
        const token = (state.pendingSeekToken || 0) + 1;
        state.pendingSeekToken = token;
        const applySeek = () => {
            if (state.pendingSeekToken !== token) return;
            const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.02) : target;
            const effective = QC.clamp(target, 0, max);
            const alreadyThere = Math.abs((video.currentTime || 0) - effective) < 0.001;
            state.suppressTarget = effective;
            if (alreadyThere) {
                state.suppressDraw = false;
                state.suppressTarget = null;
                drawFrame();
            } else {
                state.suppressDraw = true;
                seekVideoSafe(target);
                if (state.suppressTimer) clearTimeout(state.suppressTimer);
                state.suppressTimer = setTimeout(() => {
                    if (state.pendingSeekToken !== token) return;
                    state.suppressDraw = false;
                    state.suppressTarget = null;
                    drawFrame();
                }, 1500);
            }
            applyVolume();
            applyPlaybackRate();
            if (autoplay && !state.previewError) playVideoSafe();
            else if (!autoplay) video.pause();
        };
        if (video.readyState >= 2) {
            applySeek();
            return;
        }
        const onReady = () => {
            video.removeEventListener('loadeddata', onReady);
            video.removeEventListener('canplay', onReady);
            applySeek();
        };
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('canplay', onReady);
    }

    function seekVideoSafe(time) {
        if (!Number.isFinite(time)) return;
        try {
            const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.02) : time;
            video.currentTime = QC.clamp(time, 0, max);
        } catch (err) {
            // metadata not ready yet
        }
    }

    function playVideoSafe() {
        const promise = video.play();
        if (promise && promise.catch) {
            promise.catch(err => {
                if (err && err.name === 'AbortError') return;
                state.playing = false;
                console.warn('QuickCut: play failed', err);
                updateTransportUI();
            });
        }
    }

    function applyVolume() {
        const clip = getActive();
        const master = state.masterMuted ? 0 : state.masterVolume / 100;
        const clipGain = clip ? (clip.muted ? 0 : clip.volume / 100) : 0;
        const gain = QC.clamp(master * clipGain, 0, 1);
        video.volume = gain;
        video.muted = gain <= 0.001;
    }

    function togglePlay() {
        if (!state.clips.length) return;
        if (state.cropMode) {
            showToast('先应用或取消框选，再播放预览', 'info');
            return;
        }
        if (state.playing) {
            pausePlayback();
            return;
        }
        if (state.previewError) {
            showToast('当前视频编码无法预览，但仍可正常导出', 'info');
            return;
        }
        if (state.playhead >= totalDuration() - 0.03) {
            state.playhead = 0;
            selectClip(state.clips[0].id, { local: 0, play: false });
        }
        state.playing = true;
        const clip = getActive();
        const local = QC.clamp(state.playhead - clipStart(activeIndex()), 0, clipDuration(clip));
        loadVideoForClip(clip, local, true);
        updateTransportUI();
        startTick();
    }

    function pausePlayback() {
        state.playing = false;
        cancelAnimationFrame(rafId);
        rafId = 0;
        if (video) video.pause();
        el.stage.classList.remove('is-playing');
        updatePlayIcons();
        updateTransportUI();
    }

    function startTick() {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
    }

    function tick() {
        if (!state.playing) return;
        const clip = getActive();
        if (!clip) {
            pausePlayback();
            return;
        }
        const index = activeIndex();
        const start = clipStart(index);
        const duration = clipDuration(clip);
        const local = QC.clamp(video.currentTime - clip.in, 0, duration);
        state.playhead = start + local;
        updateTransportUI();
        drawFrame();
        if (video.currentTime >= clip.out - 0.035 && video.currentTime > clip.in) {
            advanceOrStop();
            return;
        }
        rafId = requestAnimationFrame(tick);
    }

    function advanceOrStop() {
        if (state.advancing) return;
        state.advancing = true;
        const index = activeIndex();
        if (index >= 0 && index < state.clips.length - 1) {
            const next = state.clips[index + 1];
            state.advancing = false;
            selectClip(next.id, { local: 0, play: true });
            return;
        }
        if (state.loop && state.clips.length) {
            state.advancing = false;
            selectClip(state.clips[0].id, { local: 0, play: true });
            return;
        }
        const clip = getActive();
        state.playhead = totalDuration();
        if (clip) {
            const local = Math.max(0, clipDuration(clip) - 0.05);
            state.playhead = clipStart(activeIndex()) + local;
            seekVideoSafe(clip.in + local);
        }
        state.advancing = false;
        pausePlayback();
        updateTransportUI();
        drawFrame();
    }

    function seekGlobal(seconds) {
        if (!state.clips.length) return;
        const total = totalDuration();
        const time = QC.clamp(seconds, 0, total);
        const target = globalToClip(time);
        selectClip(target.clip.id, { local: target.local, play: state.playing });
    }

    function stepFrame(direction, seconds) {
        if (!state.clips.length) return;
        pausePlayback();
        const clip = getActive();
        const fps = (clip && clip.fps) || Number(state.settings.fps) || 30;
        const delta = seconds != null ? direction * seconds : direction / fps;
        seekGlobal(state.playhead + delta);
    }

    function cycleSpeed(direction) {
        const current = SPEEDS.indexOf(state.speed);
        const index = current < 0 ? 3 : (current + (direction >= 0 ? 1 : -1) + SPEEDS.length) % SPEEDS.length;
        state.speed = SPEEDS[index];
        applyPlaybackRate();
        updateSpeedUI();
        showToast(`预览速度 ${state.speed}×`, 'info', null, 1100);
    }

    function applyPlaybackRate() {
        if (video) video.playbackRate = state.speed;
    }

    function updateSpeedUI() {
        if (!el.speedBtn) return;
        el.speedBtn.textContent = state.speed === 1 ? '1×' : `${state.speed}×`;
        el.speedBtn.classList.toggle('slow', state.speed < 1);
        el.speedBtn.title = `播放速度 ${state.speed}×（点击切换，, / .）`;
    }

    function toggleLoop() {
        state.loop = !state.loop;
        el.loopBtn.classList.toggle('active', state.loop);
        showToast(state.loop ? '循环预览已开启' : '循环预览已关闭', 'info', null, 1400);
    }

    function toggleMasterMute() {
        state.masterMuted = !state.masterMuted;
        applyVolume();
        updateMuteButtons();
    }

    function toggleGrid() {
        state.grid = !state.grid;
        el.gridBtn.classList.toggle('active', state.grid);
        el.cropGrid.classList.toggle('visible', state.grid);
    }

    function updatePlayIcons() {
        setIcon(el.playBtn, state.playing ? '#i-pause' : '#i-play');
        el.playBtn.classList.toggle('is-playing', state.playing);
        el.playBtn.title = state.playing ? '暂停 (空格)' : '播放 (空格)';
        el.stage.classList.toggle('is-playing', state.playing);
    }

    function setIcon(button, href) {
        const use = button && button.querySelector('use');
        if (use) use.setAttribute('href', href);
    }

    function updateTransportUI() {
        const total = totalDuration();
        const time = QC.clamp(state.playhead, 0, Math.max(0, total));
        const pct = total > 0 ? (time / total) * 100 : 0;
        el.scrubFill.style.width = `${pct}%`;
        el.scrubHead.style.left = `${pct}%`;
        el.timeNow.textContent = QC.formatTime(time);
        el.timeTotal.textContent = QC.formatTime(total);
        el.playBtn.disabled = !state.clips.length;
        updateTimelinePlayhead();
        updatePlayIcons();
    }

    function updateTimelinePlayhead() {
        const total = totalDuration();
        const pct = total > 0 ? QC.clamp(state.playhead / total, 0, 1) : 0;
        const track = el.timelineTrack;
        const left = (track.offsetLeft || 0) + pct * track.clientWidth;
        el.timelinePlayhead.style.left = `${left}px`;
        el.timelinePlayhead.style.opacity = total > 0 ? '1' : '0';
    }

    /* ------------------------------------------------------------------ */
    /* trim                                                               */
    /* ------------------------------------------------------------------ */

    function applyTrim(clip, which, value) {
        pushHistory(which === 'in' ? '左裁剪' : '右裁剪');
        const oldIn = clip.in;
        const index = state.clips.indexOf(clip);
        const start = clipStart(index);
        const sourceTime = oldIn + QC.clamp(state.playhead - start, 0, clipDuration(clip));
        if (which === 'in') {
            clip.in = QC.clamp(roundTo(value, 2), 0, Math.max(0, clip.out - MIN_CLIP));
        } else {
            clip.out = QC.clamp(roundTo(value, 2), Math.min(clip.duration, clip.in + MIN_CLIP), clip.duration);
        }
        const duration = clipDuration(clip);
        const local = QC.clamp(sourceTime - clip.in, 0, duration);
        state.playhead = start + local;
        if (state.activeId === clip.id) {
            seekVideoSafe(clip.in + local);
        }
        updateMeta();
        renderAll();
        saveEdits();
    }

    function roundTo(value, digits) {
        const factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    function trimToPlayhead(which) {
        const clip = getActive();
        if (!clip) return;
        if (state.cropMode) {
            showToast('先应用或取消框选画幅', 'info', null, 1600);
            return;
        }
        pausePlayback();
        const index = activeIndex();
        const local = QC.clamp(state.playhead - clipStart(index), 0, clipDuration(clip));
        const sourceTime = video.readyState >= 1 && state.currentClipId === clip.id
            ? video.currentTime
            : clip.in + local;
        const previous = which === 'in' ? clip.in : clip.out;
        if (Math.abs(sourceTime - previous) < 0.02) {
            showToast(which === 'in' ? '播放位置已经在片段开头' : '播放位置已经在片段结尾', 'info', null, 1400);
            return;
        }
        applyTrim(clip, which, sourceTime, false);
        showToast(`${which === 'in' ? '左' : '右'}裁剪到 ${QC.formatTime(sourceTime)}`, 'info', null, 1400);
    }

    function splitClip() {
        const clip = getActive();
        if (!clip) return;
        if (state.cropMode) {
            showToast('先应用或取消框选画幅', 'info', null, 1600);
            return;
        }
        pausePlayback();
        const index = activeIndex();
        const local = QC.clamp(state.playhead - clipStart(index), 0, clipDuration(clip));
        const cut = clip.in + local;
        if (cut <= clip.in + MIN_CLIP || cut >= clip.out - MIN_CLIP) {
            showToast('播放位置太靠近片段边缘，无法分割', 'info', null, 1800);
            return;
        }
        pushHistory('分割片段');
        const suffix = Date.now().toString(36);
        const right = {
            ...clip,
            id: `${clip.id}-s${suffix}`,
            eagleId: `${clip.eagleId}::split-${suffix}`,
            in: cut,
            out: clip.out,
            manualRect: clip.manualRect ? { ...clip.manualRect } : null
        };
        clip.out = cut;
        state.clips.splice(index + 1, 0, right);
        state.activeId = right.id;
        state.playhead = clipStart(index + 1);
        renderAll();
        selectClip(right.id, { local: 0, play: false });
        saveEdits();
        showToast(`已在 ${QC.formatTime(cut)} 分割`, 'success', null, 1800);
    }

    function resetTrim() {
        const clip = getActive();
        if (!clip) return;
        if (clip.in <= 0.01 && clip.out >= clip.duration - 0.01) {
            showToast('当前片段已经是完整长度', 'info', null, 1400);
            return;
        }
        pushHistory('重置裁剪');
        clip.in = 0;
        clip.out = clip.duration;
        state.playhead = clipStart(activeIndex());
        seekVideoSafe(clip.in);
        renderAll();
        saveEdits();
    }

    /* ------------------------------------------------------------------ */
    /* clip removal / ordering                                            */
    /* ------------------------------------------------------------------ */

    function removeClip(id) {
        const index = state.clips.findIndex(clip => clip.id === id);
        if (index < 0) return;
        if (state.cropMode) cancelCropMode();
        pausePlayback();
        pushHistory('删除片段');
        const [clip] = state.clips.splice(index, 1);
        state.lastRemoved = { clip, index };
        state.currentClipId = null;
        if (!state.clips.length) {
            state.activeId = null;
            resetEditor('片段已清空，从 Eagle 拖放视频以添加');
            showToast(`已移除「${clip.name}」`, 'info', {
                label: '撤销',
                onClick: undo
            });
            saveEdits();
            return;
        }
        state.activeId = state.clips[Math.min(index, state.clips.length - 1)].id;
        renderAll();
        selectClip(state.activeId, { local: 0, play: false });
        saveEdits();
        showToast(`已移除「${clip.name}」`, 'info', {
            label: '撤销',
            onClick: undo
        });
    }

    function reorderClip(dragId, targetId, before) {
        const from = state.clips.findIndex(clip => clip.id === dragId);
        if (from < 0) return;
        pushHistory('调整片段顺序');
        const localBefore = state.playhead - clipStart(activeIndex());
        const [moved] = state.clips.splice(from, 1);
        let insertAt = state.clips.length;
        if (targetId) {
            const target = state.clips.findIndex(clip => clip.id === targetId);
            if (target >= 0) insertAt = before ? target : target + 1;
        }
        state.clips.splice(insertAt, 0, moved);
        state.playhead = clipStart(activeIndex()) + QC.clamp(localBefore, 0, Math.max(0, clipDuration(getActive())));
        renderAll();
        updateTransportUI();
        saveEdits();
    }

    /* ------------------------------------------------------------------ */
    /* export                                                             */
    /* ------------------------------------------------------------------ */

    function buildPlan() {
        const quality = QC.QUALITIES.find(q => q.key === state.settings.quality) || QC.QUALITIES[1];
        const size = outputSizeNow();
        const fps = resolvedFps();
        const rawName = state.settings.name || defaultNameFor(state.clips[0]) || QC.defaultProjectName();
        const name = QC.sanitizeFileName(rawName.replace(/\.(mp4|mov|m4v|webm|mkv|avi)$/i, ''));
        return {
            clips: state.clips.map(clip => ({
                filePath: clip.filePath,
                width: clip.width,
                height: clip.height,
                hasAudio: clip.hasAudio,
                in: clip.in,
                out: clip.out,
                volume: clip.volume,
                muted: clip.muted,
                fit: clip.fit,
                zoom: clip.zoom,
                offsetX: clip.offsetX,
                offsetY: clip.offsetY,
                manualRect: clip.manualRect || null
            })),
            width: size.width,
            height: size.height,
            fps,
            crf: quality.crf,
            preset: 'veryfast',
            name,
            duration: totalDuration()
        };
    }

    function electronShell() {
        try {
            if (typeof require === 'function') {
                const electron = require('electron');
                return electron && electron.shell ? electron.shell : null;
            }
        } catch (err) { /* ignore */ }
        return null;
    }

    async function deleteOriginalFiles(protectedPath) {
        if (!NODE) return { deleted: 0, failed: 0, skipped: true };
        const sourceIds = [...new Set(state.clips
            .map(clip => String(clip.eagleId || '').split('::split-')[0])
            .filter(Boolean))];
        const seen = new Set();
        const paths = [];
        for (const clip of state.clips) {
            if (!clip.filePath || seen.has(clip.filePath)) continue;
            seen.add(clip.filePath);
            paths.push(clip.filePath);
        }
        pausePlayback();
        try {
            video.removeAttribute('src');
            video.load();
        } catch (err) { /* ignore */ }
        state.currentClipId = null;
        await new Promise(resolve => setTimeout(resolve, 220));

        if (window.eagle && eagle.item && eagle.item.getByIds && sourceIds.length) {
            try {
                const items = await eagle.item.getByIds(sourceIds);
                let deleted = 0;
                let failed = 0;
                let supported = false;
                for (const item of items || []) {
                    if (!item || item.isDeleted) continue;
                    if (typeof item.moveToTrash !== 'function') continue;
                    supported = true;
                    try {
                        const ok = await item.moveToTrash();
                        if (ok === false) failed += 1;
                        else deleted += 1;
                    } catch (err) {
                        failed += 1;
                    }
                }
                if (supported) return { deleted, failed, skipped: false };
            } catch (err) {
                console.warn('QuickCut: move source items to trash failed', err);
            }
        }

        const protectedResolved = protectedPath ? NODE.path.resolve(protectedPath) : '';
        const shell = electronShell();
        let deleted = 0;
        let failed = 0;
        for (const sourcePath of paths) {
            try {
                if (!NODE.fs.existsSync(sourcePath)) continue;
                if (NODE.fs.statSync(sourcePath).isDirectory()) continue;
                if (protectedResolved && NODE.path.resolve(sourcePath) === protectedResolved) continue;
                if (shell && typeof shell.trashItem === 'function') {
                    await shell.trashItem(sourcePath);
                } else {
                    failed += 1;
                    continue;
                }
                deleted += 1;
            } catch (err) {
                failed += 1;
                console.warn('QuickCut: delete source failed', sourcePath, err);
            }
        }
        return { deleted, failed, skipped: false };
    }

    async function finishExport(filePath) {
        const sessionClips = state.clips;
        let deletion = { deleted: 0, failed: 0, skipped: true };
        if (state.settings.deleteSource) {
            deletion = await deleteOriginalFiles(filePath);
            if (deletion.deleted > 0) {
                showToast(`已将 ${deletion.deleted} 个原文件移到 Eagle 垃圾桶`, 'info', null, 3200);
            }
            if (deletion.failed > 0) {
                showToast(`${deletion.failed} 个原文件删除失败`, 'error', null, 4200);
            }
            if (deletion.deleted === 0 && deletion.failed > 0) {
                const current = getActive();
                if (current) selectClip(current.id, { local: 0, play: false });
            }
            if (deletion.deleted > 0) {
                const clearDeletedTimeline = immediate => {
                    if ((!immediate && state.exporting) || state.loading || state.clips !== sessionClips) return;
                    state.history = { undo: [], redo: [] };
                    resetEditor('原文件已删除；导出视频已加入 Eagle');
                    updateHistoryButtons();
                };
                if (state.settings.closeAfterExport) clearDeletedTimeline(true);
                else setTimeout(() => clearDeletedTimeline(false), 1400);
            }
        }
        const close = state.settings.closeAfterExport && deletion.failed === 0;
        if (close) {
            setTimeout(() => {
                if (state.exporting || state.loading) return;
                if (window.eagle && eagle.window && typeof eagle.window.hide === 'function') eagle.window.hide();
            }, 700);
        }
    }

    async function exportVideo() {
        if (state.exporting) return;
        if (!state.clips.length) {
            showToast('先添加视频再导出', 'info', null, 1500);
            return;
        }
        if (state.cropMode) {
            showToast('先应用或取消框选画幅，再导出', 'info');
            return;
        }
        if (state.loading) {
            showToast('素材还在解析中，请稍候', 'info');
            return;
        }
        if (!state.ffmpegReady) {
            try {
                await ensureFFmpeg();
            } catch (err) {
                showToast(err.message || 'FFmpeg 未就绪', 'error');
                return;
            }
        }
        const plan = buildPlan();
        state.settings.name = plan.name;
        el.nameInput.value = plan.name;
        pausePlayback();
        state.exporting = true;
        state.exportMode = 'running';
        state.cancelling = false;
        setInspectorTab('output');
        setExportUI('running', 0, '准备素材…');
        updateOutputUI();
        updateEditBar();

        let result = null;
        try {
            if (!ffmpeg) throw new Error('FFmpeg 未就绪');
            result = await ffmpeg.render({
                ...plan,
                onProgress: progress => {
                    setExportUI('running', progress.percent, describeProgress(progress));
                }
            });

            state.exportMode = 'importing';
            setExportUI('importing', 0.99, '正在加入 Eagle 素材库…');
            let folder = state.folder;
            if (state.settings.addToFolder) {
                try {
                    const folders = await eagle.folder.getSelected();
                    if (Array.isArray(folders) && folders.length) {
                        folder = folders[0];
                        state.folder = folder;
                        updateFolderUI();
                    }
                } catch (err) { /* keep last known folder */ }
            }
            const folderId = state.settings.addToFolder && folder ? folder.id : null;
            const itemId = await eagle.item.addFromPath(result.outputPath, {
                name: plan.name,
                tags: [],
                folders: folderId ? [folderId] : []
            });
            const item = await eagle.item.getById(itemId);
            const filePath = item && item.filePath ? item.filePath : result.outputPath;
            if (result && result.cleanup) await result.cleanup();
            state.exportMode = 'done';
            setExportUI('done', 1, `${QC.formatTime(plan.duration)} · ${QC.formatBytes(result.size)}${folderId ? ` · ${folder.name}` : ''}`);
            updateOutputUI();
            showToast(`导出完成，已加入 Eagle${folderId ? `「${folder.name}」` : ''}`, 'success', {
                label: '在文件夹中显示',
                onClick: () => eagle.shell.showItemInFolder(filePath)
            }, 7000);
            await finishExport(filePath);
        } catch (err) {
            console.error('QuickCut export failed', err);
            state.exporting = false;
            const message = err && err.message ? err.message : '导出失败';
            if (message === '已取消导出' || (err && err.details === 'cancelled')) {
                resetExportUI();
                showToast('已取消导出', 'info');
            } else {
                setExportUI('error', 0, message);
                updateOutputUI();
                showToast(message, 'error', {
                    label: '重试',
                    onClick: () => exportVideo()
                }, 8000);
            }
        } finally {
            state.exporting = false;
            updateOutputUI();
            updateEditBar();
        }
    }

    function openExportPanel() {
        exportVideo();
    }

    function describeProgress(progress) {
        if (!progress) return '准备中';
        if (progress.stage === 'done') return '收尾中…';
        if (progress.stage === 'encode') {
            const seconds = Number(progress.seconds) || 0;
            const total = Number(progress.totalDuration) || totalDuration();
            return `编码中 ${QC.formatTime(seconds)} / ${QC.formatTime(total)}`;
        }
        return '准备中';
    }

    function setExportUI(mode, percent, detail) {
        state.exportMode = mode;
        const active = mode === 'running' || mode === 'importing';
        el.outputForm.hidden = mode !== 'idle';
        el.exportProgress.hidden = mode === 'idle';
        el.progressFill.classList.toggle('error', mode === 'error');
        const pct = mode === 'done' ? 100 : Math.round(QC.clamp(percent, 0, 1) * 100);
        el.progressFill.style.width = `${pct}%`;
        el.progressPct.textContent = `${pct}%`;
        if (mode === 'running') {
            el.exportTitle.textContent = '正在导出视频';
            el.exportDetail.textContent = detail || '准备中…';
            el.cancelExportBtn.textContent = state.cancelling ? '正在取消…' : '取消';
            el.cancelExportBtn.disabled = state.cancelling;
            el.exportSection.scrollIntoView({ block: 'nearest' });
        } else if (mode === 'importing') {
            el.exportTitle.textContent = '正在加入 Eagle';
            el.exportDetail.textContent = detail || '正在生成素材缩略图…';
            el.cancelExportBtn.textContent = '请稍候';
            el.cancelExportBtn.disabled = true;
        } else if (mode === 'done') {
            el.exportTitle.textContent = '导出完成';
            el.exportDetail.textContent = detail || '已加入 Eagle 素材库';
            el.cancelExportBtn.textContent = '完成';
            el.cancelExportBtn.disabled = false;
        } else if (mode === 'error') {
            el.exportTitle.textContent = '导出失败';
            el.exportDetail.textContent = detail || '请重试';
            el.cancelExportBtn.textContent = '返回';
            el.cancelExportBtn.disabled = false;
        } else {
            el.outputForm.hidden = false;
            el.exportProgress.hidden = true;
        }
        if (!active) updateOutputUI();
    }

    function resetExportUI() {
        state.cancelling = false;
        setExportUI('idle', 0, '');
        state.exportMode = 'idle';
    }

    function onCancelExport() {
        if (state.exportMode === 'running') {
            state.cancelling = true;
            if (ffmpeg) ffmpeg.cancel();
            el.cancelExportBtn.disabled = true;
            el.cancelExportBtn.textContent = '正在取消…';
        } else if (state.exportMode === 'done' || state.exportMode === 'error') {
            resetExportUI();
        }
    }

    /* ------------------------------------------------------------------ */
    /* misc                                                               */
    /* ------------------------------------------------------------------ */

    function showToast(message, type, action, duration) {
        const toast = document.createElement('div');
        toast.className = `toast ${type || 'info'}`;
        const icon = type === 'success' ? '#i-check' : type === 'error' ? '#i-alert' : '#i-film';
        toast.innerHTML = `<svg class="ic"><use href="${icon}"/></svg><span>${escapeHtml(message)}</span>`;
        if (action && action.label) {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.addEventListener('click', () => {
                action.onClick();
                toast.remove();
            });
            toast.appendChild(button);
        }
        el.toasts.appendChild(toast);
        while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity .18s';
            setTimeout(() => toast.remove(), 200);
        }, duration || 4800);
    }

    function extOf(filePath) {
        const value = String(filePath || '');
        const dot = value.lastIndexOf('.');
        return dot >= 0 ? value.slice(dot + 1) : '';
    }

    function formatCodec(codec) {
        const value = String(codec || '').toLowerCase();
        const names = {
            h264: 'H.264', avc1: 'H.264', hevc: 'HEVC', h265: 'HEVC',
            vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes',
            mpeg4: 'MPEG-4', theora: 'Theora', aac: 'AAC', opus: 'Opus',
            mp3: 'MP3', vorbis: 'Vorbis', ac3: 'AC-3', flac: 'FLAC', pcm_s16le: 'PCM'
        };
        return names[value] || value.toUpperCase();
    }

    function mapLimit(items, limit, worker) {
        const results = new Array(items.length);
        let next = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const index = next++;
                if (index >= items.length) return;
                results[index] = await worker(items[index], index);
            }
        });
        return Promise.all(runners).then(() => results);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    boot().catch(err => {
        console.error('QuickCut boot failed', err);
        document.body.innerHTML = `<div style="padding:40px;font:13px sans-serif;color:#eee">QuickCut 启动失败：${escapeHtml(err.message || err)}</div>`;
    });
})();

