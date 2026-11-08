document.addEventListener('DOMContentLoaded', () => {
    const LANG_STORAGE_KEY = 'ace-player-lang';
    const SUBS_URL_STORAGE_KEY = 'ace-player-subs-url';

    const app = {
        // --- CONFIGURATION ---
        // Same-origin path: the engine serves this page, so it works for any host, IP or port.
        // content_id is the current parameter name per https://docs.acestream.net/developers/
        // ("id" is a deprecated alias); both work live but content_id is the documented one.
        BASE_STREAM_URL: '/ace/manifest.m3u8?transcode_audio=1&content_id=',
        ACESTREAM_PREFIX: "acestream://",
        HASH_RE: /^[a-f0-9]{40}$/,
        // Backoff between recovery attempts; the last one is the give-up point.
        RETRY_DELAYS_MS: [1000, 2000, 4000, 8000, 15000],
        // A starved live stream can sit at the end of its buffer forever without
        // video.js ever firing 'error', so playback progress itself is watched.
        STALL_CHECK_MS: 4000,
        STALL_LIMIT_MS: 12000,
        // Local ASR subtitle sidecar (subs/run.sh). The CSP only opens this port.
        SUBS_PORT: 8765,
        SUBS_POLL_MS: 1500,
        // Live streams are fetched segment-by-segment at the live edge, and each
        // segment's first byte waits on the P2P swarm (measured 1-6 s TTFB for a
        // ~6 s segment), so riding the edge drains the buffer and stutters. Sitting
        // this far behind the edge means we consume segments the engine has already
        // cached (instant) while it keeps downloading ahead: latency for smoothness.
        LIVE_CUSHION_SEC: 15,
        // Re-establish the cushion only when we have drifted back onto the edge.
        LIVE_CUSHION_MIN_SEC: 5,
        // Right after a (re)start the engine "catches up" and its edge advances
        // faster than wall-clock, which makes VHS snap playback back to the edge;
        // these bound the resulting backward jumps instead of fighting forever.
        LIVE_CUSHION_COOLDOWN_MS: 20000,
        LIVE_CUSHION_MAX_SEEKS: 3,

        // --- STATE ---
        state: {
            currentLang: null,
            currentId: null,
            lastErrorType: null,
            lastErrorParams: null,
            panelVisible: true,
            awaitingFirstPlay: false,
            cushionSeeks: 0,
            lastCushionSeekAt: 0,
            failureHandled: false,
            retryCount: 0,
            // Which notice the reason was, so exhausting the backoff can repeat it
            // in the banner ('noPeers' vs 'playbackFailed').
            pendingFailure: null,
            // Which sentence the loading overlay shows: 'loading' or 'reconnecting'.
            loadingKey: 'loading',
            loadingParams: null,
            // Stall watchdog: last observed playback position and when it froze.
            stallTime: null,
            stallSince: 0,
        },
        // Local ASR subtitle state (sidecar session + rendered text track).
        subs: {
            enabled: false,
            baseUrl: '',
            sessionId: null,
            pollTimer: null,
            statusTimer: null,
            nextSeq: -1,
            offset: 0,
            track: null,
            pollErrors: 0,
            statusKey: null,
        },
        t: null,
        loadTimer: null,
        retryTimer: null,
        stallTimer: null,

        // --- DOM ELEMENTS ---
        elements: {
            player: null,
            inputPanel: document.getElementById('input-panel'),
            toggleBtn: document.getElementById('toggle-panel-btn'),
            playBtn: document.getElementById('play-button'),
            linkInput: document.getElementById('acestream-link-input'),
            inputLabel: document.getElementById('input-label'),
            langControls: document.getElementById('lang-controls'),
            inputForm: document.getElementById('input-form'),
            errorMessage: document.getElementById('error-message'),
            loadingOverlay: document.getElementById('loading-overlay'),
            loadingText: document.getElementById('loading-text'),
            pressPlayHint: document.getElementById('press-play-hint'),
            pressPlayText: document.getElementById('press-play-text'),
            titleText: document.getElementById('title-text'),
            subtitleText: document.getElementById('subtitle-text'),
            helpLabel: document.getElementById('help-label'),
            helpBody: document.getElementById('help-body'),
            attributionLink: document.getElementById('attribution-link'),
            subsToggleBtn: document.getElementById('subs-toggle-btn'),
            subsStatus: document.getElementById('subs-status'),
            subsUrlInput: document.getElementById('subs-url-input'),
            subsUrlLabel: document.getElementById('subs-url-label'),
            subsHelp: document.getElementById('subs-help'),
        },

        // --- TRANSLATIONS ---
        // Every user-visible string must exist in every language. The `lang`
        // field is the BCP-47 code used both for <html lang> and for video.js,
        // whose Chinese pack (lang/zh-CN.js) registers exactly 'zh-CN'.
        translations: {
            en: {
                lang: 'en',
                title: 'Ace Stream Player',
                tabTitle: 'Ace Stream Player',
                subtitle: 'Paste an Ace Stream link or content ID below and press Play.',
                placeholder: 'acestream://... or 40-character ID',
                play: 'Play',
                inputLabel: 'Ace Stream link or content ID',
                helpLabel: 'Where do I get a link?',
                helpBody: 'A link looks like <code>acestream://&lt;40 characters&gt;</code> and comes from the channel list or community where you found the stream.',
                loading: 'Connecting to the stream... this can take 10-30 seconds.',
                reconnecting: 'Stream interrupted. Reconnecting... attempt {n} of {total}.',
                noPeers: 'No peers found for this stream. It may be offline right now, or your network may be blocking Ace Stream. Try another link or try again later.',
                showPanel: 'Show panel',
                hidePanel: 'Hide panel',
                playbackFailed: 'Could not load the stream. The link may be offline or wrong. Try another one.',
                invalidFormat: 'That is not a valid Ace Stream link. It should be acestream:// followed by 40 characters (letters a-f and numbers).',
                emptyInput: 'Please enter an Ace Stream link or content ID first.',
                pressPlay: 'Ready. Press the play button to start watching.',
                githubTitle: 'View project on GitHub (opens in a new tab)',
                subsEnable: 'Enable subtitles',
                subsDisable: 'Disable subtitles',
                subsConnecting: 'Connecting to the subtitle server...',
                subsTranscribing: 'Live English subtitles on (a few seconds behind).',
                subsNoStream: 'Load a stream first, then enable subtitles.',
                subsUnavailable: 'Cannot reach the subtitle server. Is subs/run.sh running?',
                subsFailed: 'The subtitle session failed. Try enabling it again.',
                subsUrlLabel: 'Subtitle server (local ASR)',
                subsHelp: 'Press CC (top right) for live English subtitles from a local model.',
                subsTrackLabel: 'English (ASR)',
            },
            'zh-CN': {
                lang: 'zh-CN',
                title: 'Ace Stream 播放器',
                tabTitle: 'Ace Stream 播放器',
                subtitle: '在下方粘贴 Ace Stream 链接或内容 ID，然后点击播放。',
                placeholder: 'acestream://... 或 40 位 ID',
                play: '播放',
                inputLabel: 'Ace Stream 链接或内容 ID',
                helpLabel: '链接从哪里来？',
                helpBody: '链接的格式是 <code>acestream://&lt;40 个字符&gt;</code>，来自你找到这个频道的播单或社区。',
                loading: '正在连接这个流…可能需要 10 到 30 秒。',
                reconnecting: '播放中断，正在重连…第 {n}/{total} 次尝试。',
                noPeers: '没有找到这个流的节点（peers）。它现在可能没有在播，也可能是你的网络屏蔽了 Ace Stream。请换一个链接，或稍后再试。',
                showPanel: '显示面板',
                hidePanel: '隐藏面板',
                playbackFailed: '无法加载这个流。链接可能已经失效或填写有误，请换一个试试。',
                invalidFormat: '这不是有效的 Ace Stream 链接。应为 acestream:// 开头，后面跟 40 个字符（a–f 和数字）。',
                emptyInput: '请先输入 Ace Stream 链接或内容 ID。',
                pressPlay: '已就绪。点击播放按钮开始观看。',
                githubTitle: '在 GitHub 查看项目（在新标签页打开）',
                subsEnable: '开启字幕',
                subsDisable: '关闭字幕',
                subsConnecting: '正在连接字幕服务…',
                subsTranscribing: '实时英文字幕已开启（会滞后几秒）。',
                subsNoStream: '请先播放一个流，再开启字幕。',
                subsUnavailable: '无法连接字幕服务。subs/run.sh 是否在运行？',
                subsFailed: '字幕会话失败，请重新开启试试。',
                subsUrlLabel: '字幕服务（本地 ASR）',
                subsHelp: '按右上角 CC 开启本地模型生成的实时英文字幕。',
                subsTrackLabel: '英语（ASR）',
            },
            es: {
                lang: 'es',
                title: 'Reproductor Ace Stream',
                tabTitle: 'Reproductor Ace Stream',
                subtitle: 'Pega abajo un enlace Ace Stream o un ID de contenido y pulsa Reproducir.',
                placeholder: 'acestream://... o ID de 40 caracteres',
                play: 'Reproducir',
                inputLabel: 'Enlace Ace Stream o ID de contenido',
                helpLabel: '¿De dónde saco un enlace?',
                helpBody: 'Un enlace tiene la forma <code>acestream://&lt;40 caracteres&gt;</code> y lo obtienes de la lista de canales o la comunidad donde encontraste el stream.',
                loading: 'Conectando con el stream... puede tardar entre 10 y 30 segundos.',
                reconnecting: 'El stream se ha interrumpido. Reconectando... intento {n} de {total}.',
                noPeers: 'No se encontraron peers para este stream. Puede estar caído ahora mismo, o tu red podría estar bloqueando Ace Stream. Prueba otro enlace o inténtalo más tarde.',
                showPanel: 'Mostrar panel',
                hidePanel: 'Ocultar panel',
                playbackFailed: 'No se pudo cargar el stream. El enlace puede estar caído o ser incorrecto. Prueba con otro.',
                invalidFormat: 'Eso no es un enlace Ace Stream válido. Debe ser acestream:// seguido de 40 caracteres (letras a-f y números).',
                emptyInput: 'Introduce primero un enlace Ace Stream o un ID de contenido.',
                pressPlay: 'Listo. Pulsa el botón de reproducción para empezar a ver.',
                githubTitle: 'Ver proyecto en GitHub (se abre en una pestaña nueva)',
                subsEnable: 'Activar subtítulos',
                subsDisable: 'Desactivar subtítulos',
                subsConnecting: 'Conectando con el servidor de subtítulos...',
                subsTranscribing: 'Subtítulos en inglés en directo (unos segundos por detrás).',
                subsNoStream: 'Carga un stream primero y luego activa los subtítulos.',
                subsUnavailable: 'No se alcanza el servidor de subtítulos. ¿Está subs/run.sh en marcha?',
                subsFailed: 'La sesión de subtítulos falló. Intenta activarla de nuevo.',
                subsUrlLabel: 'Servidor de subtítulos (ASR local)',
                subsHelp: 'Pulsa CC (arriba a la derecha) para subtítulos en inglés desde un modelo local.',
                subsTrackLabel: 'Inglés (ASR)',
            }
        },

        // --- INITIALIZATION ---
        init() {
            // `fill` (not `fluid`): the player already fills #player-container via
            // CSS, and fluid's padding-top would fight that and stretch the picture.
            this.elements.player = videojs("video", {
                fill: true,
                html5: {
                    vhs: {
                        // Let the live cushion seek back inside the live window.
                        allowSeeksWithinUnsafeLiveWindow: true,
                        // A slow swarm segment is better waited out than aborted:
                        // aborts (status 0) force a rewind + re-fetch of several
                        // segments, which is what the visible stutter actually is.
                        timeout: 20000,
                    },
                },
            });
            this.addEventListeners();
            this.startStallWatch();
            this.changeLanguage(this.detectLanguage());
            this.initSubs();

            const deepLink = this.parseDeepLink();
            if (deepLink) {
                this.loadAceStream(deepLink);
            }
        },

        // Priority: an explicit earlier choice in localStorage, then the
        // browser's language, then English.
        detectLanguage() {
            const stored = localStorage.getItem(LANG_STORAGE_KEY);
            if (stored && this.translations[stored]) return stored;
            const nav = (navigator.language || '').toLowerCase();
            // Covers zh-CN / zh-TW / zh-Hans-* etc.; the UI ships one Chinese pack.
            if (nav.indexOf('zh') === 0) return 'zh-CN';
            return nav.indexOf('es') === 0 ? 'es' : 'en';
        },

        // ?id=<40-hex> takes priority; otherwise accept acestream:// or a
        // bare 40-hex id in the URL hash (e.g. shared as #<id>).
        parseDeepLink() {
            const params = new URLSearchParams(location.search);
            const idParam = params.get('id');
            if (idParam) return idParam.trim();

            let hash = location.hash.replace(/^#/, '');
            if (!hash) return null;
            try {
                hash = decodeURIComponent(hash);
            } catch (e) {
                // Malformed percent-encoding: fall through with the raw value,
                // loadAceStream() will reject it as an invalid format anyway.
            }
            return hash.trim();
        },

        // --- EVENT LISTENERS ---
        addEventListeners() {
            this.elements.toggleBtn.addEventListener('click', () => this.togglePanel());
            this.elements.inputForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.loadAceStream(this.elements.linkInput.value.trim());
            });
            this.elements.linkInput.addEventListener('input', () => {
                this.hideError();
                this.clearInputInvalid();
            });
            this.elements.langControls.querySelectorAll('.lang-button').forEach(btn => {
                btn.addEventListener('click', () => this.selectLanguage(btn.dataset.lang));
            });
            // Drive UI from real playback events instead of guessing.
            this.elements.player.on('play', () => this.hidePressPlayHint());
            this.elements.player.on('playing', () => {
                this.clearLoadTimer();
                this.clearRetryTimer();
                this.hideLoading();
                this.hidePressPlayHint();
                // Real frames mean the swarm came back: spend the recovery budget
                // again from zero instead of carrying the old attempt count over.
                this.state.retryCount = 0;
                this.state.pendingFailure = null;
                this.setLoadingMessage('loading');
                // A real 'playing' event means the stream is fine now, even if a
                // slow/flaky swarm made the safety-net timeout show "no peers"
                // earlier: clear that stale banner instead of leaving it stuck.
                if (this.state.lastErrorType) {
                    this.hideError();
                }
                // Auto-hide the panel only on the first successful play after a
                // load (possibly delayed past the safety-net timeout), not on
                // every buffer-resume 'playing' event.
                if (this.state.awaitingFirstPlay) {
                    this.state.awaitingFirstPlay = false;
                    this.togglePanel(false);
                    this.maybeAutoEnableSubs();
                    this.applyLiveCushion();
                }
            });
            this.elements.player.on('error', () => this.handleFailure());
            // Sustain the live cushion: cheap no-op unless we drift onto the edge.
            this.elements.player.on('timeupdate', () => this.applyLiveCushion());
            this.elements.subsToggleBtn.addEventListener('click', () => this.toggleSubs());
            this.elements.subsUrlInput.addEventListener('change', () => this.applySubsUrl());
        },

        // --- CORE LOGIC ---
        loadAceStream(link) {
            this.hideError();
            this.clearInputInvalid();

            if (!link) {
                this.showError('emptyInput');
                this.markInputInvalid();
                return;
            }

            const playerId = link.replace(this.ACESTREAM_PREFIX, '').toLowerCase();
            const isValidHash = this.HASH_RE.test(playerId);

            if (!isValidHash) {
                this.showError('invalidFormat');
                this.markInputInvalid();
                return;
            }

            this.elements.linkInput.value = link;
            this.state.currentId = playerId;
            this.applyDocumentTitle();
            // A new stream invalidates any previous subtitle session.
            this.disableSubs();
            this.elements.subsToggleBtn.disabled = false;

            // Bookmarkable/shareable URL for this stream.
            const shareUrl = `${location.pathname}?id=${playerId}`;
            history.replaceState(null, '', shareUrl);

            this.state.awaitingFirstPlay = true;
            this.state.retryCount = 0;
            this.state.pendingFailure = null;
            this.clearRetryTimer();
            this.startAttempt(playerId);
        },

        // One attempt against the engine's content_id entry point — for a new link
        // and for every recovery retry. That endpoint is the only one that rebuilds
        // the engine's live download: once a stream stalls, the
        // /ace/m/<infohash>/<token>.m3u8 address the player is left polling answers
        // 500 "download not found" for as long as the download is gone, so
        // re-playing the current address (player.reload() / player.load()) can never
        // recover. This is what a manual page refresh used to be doing.
        startAttempt(playerId) {
            this.state.failureHandled = false;
            this.state.cushionSeeks = 0;
            this.state.lastCushionSeekAt = 0;
            this.setLoadingMessage('loading');
            this.hidePressPlayHint();
            this.showLoading();
            this.startLoadTimer();

            const player = this.elements.player;
            // Re-issuing the same URL is a no-op deeper down than it looks: VHS
            // returns early when its src_ has not changed, and player.load() merely
            // calls src(currentSource()) again. Only tearing the tech down makes the
            // engine re-resolve content_id into a fresh /ace/m/<hash>/<token>.m3u8.
            // reset() defers through play() unless we are already paused, and a
            // starved element may never resolve that promise — so pause first.
            player.pause();
            player.reset();
            player.src({
                src: this.BASE_STREAM_URL + playerId,
                type: 'application/x-mpegURL',
            });

            const playPromise = player.play();

            if (playPromise !== undefined) {
                playPromise.catch((error) => {
                    if (error && error.name === 'NotAllowedError') {
                        // Not a real failure: the browser blocked autoplay because
                        // there was no user gesture (e.g. a deep link on page load).
                        // The stream keeps loading in the background; just prompt
                        // the user to press the (visible) big play button — and stand
                        // the safety net down, since a stream nobody has started yet
                        // must not be retried behind their back.
                        this.clearLoadTimer();
                        this.hideLoading();
                        this.showPressPlayHint();
                        return;
                    }
                    console.error('Video playback error:', error);
                    this.handleFailure();
                });
            }
        },

        // Keep playback ~LIVE_CUSHION_SEC behind the live edge. The segments behind
        // the edge are already in the engine's cache (instant first byte), so slow
        // P2P fetches land in the prefetch buffer instead of stalling the picture.
        // In steady state the edge advances ~1 s/s and the cushion holds by itself;
        // right after a (re)start the engine catches up and VHS snaps us back to the
        // edge, so re-establish it on a cooldown, bounded so we never jump forever.
        applyLiveCushion() {
            const player = this.elements.player;
            const tracker = player.liveTracker;
            const isLive = (tracker && tracker.isLive && tracker.isLive())
                || !Number.isFinite(player.duration());
            if (!isLive) return;                            // VOD needs no cushion
            const seekable = player.seekable();
            if (!seekable || !seekable.length) return;
            const start = seekable.start(0);
            const end = seekable.end(seekable.length - 1);
            const target = end - this.LIVE_CUSHION_SEC;
            if (target <= start) return;                    // window too small to sit back
            if (end - player.currentTime() >= this.LIVE_CUSHION_MIN_SEC) return;  // already back
            if (this.state.cushionSeeks >= this.LIVE_CUSHION_MAX_SEEKS) return;
            const now = Date.now();
            if (now - this.state.lastCushionSeekAt < this.LIVE_CUSHION_COOLDOWN_MS) return;
            this.state.cushionSeeks++;
            this.state.lastCushionSeekAt = now;
            player.currentTime(target);
        },

        // Single guarded failure path: the play() rejection and the video.js
        // 'error' event can both fire for one attempt, so dedupe them here.
        handleFailure(finalErrorType) {
            if (this.state.failureHandled) return;
            this.state.failureHandled = true;
            this.clearLoadTimer();
            const reason = finalErrorType || 'playbackFailed';
            // No id means no stream was ever loaded: a dead link, not a stall.
            if (!this.state.currentId) {
                this.giveUp(reason);
                return;
            }
            this.state.pendingFailure = reason;
            this.scheduleReconnect();
        },

        // Transient recovery: back off, then run another attempt. The overlay
        // carries the message because #error-message sits inside the input panel,
        // which is hidden while watching.
        scheduleReconnect() {
            const delay = this.RETRY_DELAYS_MS[this.state.retryCount];
            if (delay === undefined) {
                this.giveUp(this.state.pendingFailure);
                return;
            }
            this.state.retryCount++;
            this.setLoadingMessage('reconnecting', {
                n: this.state.retryCount,
                total: this.RETRY_DELAYS_MS.length,
            });
            this.hidePressPlayHint();
            this.showLoading();
            // Stop the loader so it quits hammering the dead manifest while we wait.
            this.elements.player.pause();
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.startAttempt(this.state.currentId);
            }, delay);
        },

        // Backoff spent: say why, and put the panel where the user can act on it.
        giveUp(reason) {
            this.state.failureHandled = true;
            this.clearLoadTimer();
            this.clearRetryTimer();
            this.setLoadingMessage('loading');
            this.hideLoading();
            this.hidePressPlayHint();
            this.showError(reason);
            this.togglePanel(true);
        },

        // Safety net so the spinner can never get stuck: if nothing plays and no
        // error fires (e.g. peers never found), treat the silence as a failed
        // attempt — the same recovery path a manual refresh used to take.
        startLoadTimer() {
            this.clearLoadTimer();
            this.loadTimer = setTimeout(() => this.handleFailure('noPeers'), 45000);
        },

        clearLoadTimer() {
            if (this.loadTimer) {
                clearTimeout(this.loadTimer);
                this.loadTimer = null;
            }
        },

        clearRetryTimer() {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
        },

        // Progress watchdog: a live download torn down engine-side leaves the
        // player sitting at the end of its buffer with no 'error' and sometimes no
        // 'waiting' either, which no event-driven path can see.
        startStallWatch() {
            if (this.stallTimer) return;
            this.stallTimer = setInterval(() => this.checkStall(), this.STALL_CHECK_MS);
        },

        checkStall() {
            const player = this.elements.player;
            const time = player.currentTime();
            // Nothing loaded yet, a user-initiated pause, or a seek in flight: none
            // of those are stalls, so keep the watchdog blind to them.
            if (!this.state.currentId || this.state.failureHandled || time === 0 ||
                player.paused() || player.seeking()) {
                this.state.stallTime = null;
                this.state.stallSince = 0;
                return;
            }
            if (time !== this.state.stallTime) {
                this.state.stallTime = time;
                this.state.stallSince = 0;
                return;
            }
            const now = Date.now();
            if (!this.state.stallSince) {
                this.state.stallSince = now;
                return;
            }
            if (now - this.state.stallSince >= this.STALL_LIMIT_MS) {
                this.state.stallTime = null;
                this.state.stallSince = 0;
                this.handleFailure('playbackFailed');
            }
        },

        showLoading() {
            this.elements.loadingOverlay.classList.add('visible');
        },

        hideLoading() {
            this.elements.loadingOverlay.classList.remove('visible');
        },

        // Which sentence the overlay shows: the plain "connecting" one, or the
        // reconnect attempt counter. Re-read on every language switch.
        setLoadingMessage(key, params) {
            this.state.loadingKey = key;
            this.state.loadingParams = params || null;
            this.elements.loadingText.innerText = this.interpolate(this.t[key], this.state.loadingParams);
        },

        showPressPlayHint() {
            this.elements.pressPlayText.innerText = this.t.pressPlay;
            this.elements.pressPlayHint.classList.add('visible');
        },

        hidePressPlayHint() {
            this.elements.pressPlayHint.classList.remove('visible');
        },

        togglePanel(forceState) {
            const show = forceState === true || (forceState === undefined && !this.state.panelVisible);
            this.state.panelVisible = show;

            this.elements.inputPanel.classList.toggle('hidden', !show);
            this.elements.toggleBtn.classList.toggle('panel-hidden', !show);

            const label = show ? this.t.hidePanel : this.t.showPanel;
            this.elements.toggleBtn.setAttribute('aria-label', label);
            this.elements.toggleBtn.setAttribute('aria-expanded', String(show));
        },

        showError(errorType, params) {
            this.state.lastErrorType = errorType;
            this.state.lastErrorParams = params || null;
            this.elements.errorMessage.innerText = this.interpolate(this.t[errorType], this.state.lastErrorParams);
            this.elements.errorMessage.style.display = 'block';
        },

        hideError() {
            this.state.lastErrorType = null;
            this.state.lastErrorParams = null;
            this.elements.errorMessage.style.display = 'none';
            this.elements.errorMessage.innerText = '';
        },

        interpolate(text, params) {
            if (!params) return text;
            return text.replace(/\{(\w+)\}/g, (match, key) =>
                params[key] === undefined ? match : String(params[key]));
        },

        markInputInvalid() {
            this.elements.linkInput.setAttribute('aria-invalid', 'true');
            this.elements.linkInput.setAttribute('aria-describedby', 'error-message');
        },

        clearInputInvalid() {
            this.elements.linkInput.removeAttribute('aria-invalid');
            this.elements.linkInput.removeAttribute('aria-describedby');
        },

        // --- LOCAL ASR SUBTITLES ---
        // The sidecar (subs/run.sh) transcribes the stream audio to English. The
        // player opens a session, polls incremental cues and renders them on a
        // native video.js text track so they survive fullscreen.
        initSubs() {
            const stored = localStorage.getItem(SUBS_URL_STORAGE_KEY);
            this.subs.baseUrl = (stored || this.defaultSubsBase()).replace(/\/+$/, '');
            this.elements.subsUrlInput.value = this.subs.baseUrl;
            this.updateSubsToggleLabel();
        },

        defaultSubsBase() {
            return `${location.protocol}//${location.hostname}:${this.SUBS_PORT}`;
        },

        resolveSubsBase() {
            return this.subs.baseUrl || this.defaultSubsBase();
        },

        applySubsUrl() {
            const val = this.elements.subsUrlInput.value.trim().replace(/\/+$/, '');
            this.subs.baseUrl = val || this.defaultSubsBase();
            this.elements.subsUrlInput.value = this.subs.baseUrl;
            localStorage.setItem(SUBS_URL_STORAGE_KEY, this.subs.baseUrl);
            if (this.subs.enabled) this.disableSubs();
        },

        toggleSubs() {
            if (this.subs.enabled) this.disableSubs();
            else this.enableSubs();
        },

        // Start subtitles together with playback when the sidecar is available.
        // Probe /health first so a missing sidecar stays silent (CC remains off)
        // instead of nagging on every play.
        async maybeAutoEnableSubs() {
            if (this.subs.enabled || !this.state.currentId) return;
            try {
                const res = await fetch(`${this.resolveSubsBase()}/health`);
                if (!res.ok) return;
                const data = await res.json();
                if (!data.ready) return;
            } catch (e) {
                return;
            }
            if (!this.subs.enabled) this.enableSubs();
        },

        async enableSubs() {
            if (!this.state.currentId) {
                this.showSubsStatus('subsNoStream', true);
                return;
            }
            const base = this.resolveSubsBase();
            this.subs.enabled = true;
            this.subs.nextSeq = -1;
            this.subs.pollErrors = 0;
            // Anchor the sidecar's elapsed-time cues onto the player timeline.
            this.subs.offset = this.elements.player.currentTime() || 0;
            this.updateSubsToggleLabel();
            this.ensureSubsTrack();
            this.showSubsStatus('subsConnecting');
            try {
                // No engine field: the sidecar uses its own --engine (host-local
                // 127.0.0.1:6878), which it can reach even when the page is opened
                // via a LAN IP the container does not bind.
                const res = await fetch(`${base}/session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content_id: this.state.currentId }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!this.subs.enabled) return;
                this.subs.sessionId = data.session_id;
                this.showSubsStatus('subsTranscribing');
                this.scheduleSubsPoll();
            } catch (err) {
                console.error('Subtitle session error:', err);
                this.subs.enabled = false;
                this.updateSubsToggleLabel();
                this.showSubsStatus('subsUnavailable', true);
            }
        },

        disableSubs() {
            const wasEnabled = this.subs.enabled;
            this.subs.enabled = false;
            if (this.subs.pollTimer) {
                clearTimeout(this.subs.pollTimer);
                this.subs.pollTimer = null;
            }
            const sid = this.subs.sessionId;
            this.subs.sessionId = null;
            if (sid) {
                fetch(`${this.resolveSubsBase()}/session/${sid}/stop`, { method: 'POST' }).catch(() => {});
            }
            if (this.subs.track) {
                this.subs.track.mode = 'disabled';
                // Remove it so re-enabling creates a fresh track (no accumulation,
                // and no stale reference after player.reset() tears the tech down).
                const player = this.elements.player;
                if (typeof player.removeRemoteTextTrack === 'function') {
                    player.removeRemoteTextTrack(this.subs.track);
                }
                this.subs.track = null;
            }
            this.updateSubsToggleLabel();
            if (wasEnabled) this.hideSubsStatus();
        },

        ensureSubsTrack() {
            if (this.subs.track) {
                const cues = this.subs.track.cues;
                if (cues) {
                    while (cues.length) this.subs.track.removeCue(cues[0]);
                }
                this.subs.track.mode = 'showing';
                return;
            }
            const el = this.elements.player.addRemoteTextTrack({
                kind: 'subtitles',
                language: 'en',
                srclang: 'en',
                label: this.t.subsTrackLabel,
            }, false);
            // video.js may return the TextTrack directly or an HTMLTrackElement.
            this.subs.track = el && el.track ? el.track : el;
            if (this.subs.track) this.subs.track.mode = 'showing';
        },

        async pollSubs() {
            this.subs.pollTimer = null;
            if (!this.subs.enabled || !this.subs.sessionId) return;
            const base = this.resolveSubsBase();
            try {
                const res = await fetch(`${base}/session/${this.subs.sessionId}/cues?after=${this.subs.nextSeq}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!this.subs.enabled) return;
                this.subs.pollErrors = 0;
                if (data.cues && data.cues.length) this.addSubsCues(data.cues);
                if (typeof data.next === 'number') this.subs.nextSeq = data.next;
                if (data.status === 'error') {
                    this.showSubsStatus('subsFailed', true);
                    this.disableSubs();
                    return;
                }
                // 'stopped' means the sidecar's stream ended: keep the cues already
                // on screen and stop polling.
                if (data.status !== 'stopped') this.scheduleSubsPoll();
            } catch (err) {
                if (!this.subs.enabled) return;
                this.subs.pollErrors++;
                if (this.subs.pollErrors >= 3) {
                    console.error('Subtitle poll error:', err);
                    this.showSubsStatus('subsUnavailable', true);
                    this.disableSubs();
                    return;
                }
                this.scheduleSubsPoll();
            }
        },

        scheduleSubsPoll() {
            if (this.subs.pollTimer) clearTimeout(this.subs.pollTimer);
            this.subs.pollTimer = setTimeout(() => this.pollSubs(), this.SUBS_POLL_MS);
        },

        addSubsCues(cues) {
            const track = this.subs.track;
            if (!track || typeof window.VTTCue !== 'function') return;
            const offset = this.subs.offset;
            cues.forEach((c) => {
                const start = Math.max(0, c.start + offset);
                const end = Math.max(start + 0.1, c.end + offset);
                track.addCue(new window.VTTCue(start, end, c.text));
            });
        },

        showSubsStatus(key, isError) {
            if (this.subs.statusTimer) {
                clearTimeout(this.subs.statusTimer);
                this.subs.statusTimer = null;
            }
            this.subs.statusKey = key;
            this.elements.subsStatus.innerText = this.t[key];
            this.elements.subsStatus.classList.toggle('error', !!isError);
            this.elements.subsStatus.classList.add('visible');
            if (!isError) {
                this.subs.statusTimer = setTimeout(() => this.hideSubsStatus(), 5000);
            }
        },

        hideSubsStatus() {
            if (this.subs.statusTimer) {
                clearTimeout(this.subs.statusTimer);
                this.subs.statusTimer = null;
            }
            this.subs.statusKey = null;
            this.elements.subsStatus.classList.remove('visible', 'error');
        },

        updateSubsToggleLabel() {
            if (!this.t) return;
            const label = this.subs.enabled ? this.t.subsDisable : this.t.subsEnable;
            this.elements.subsToggleBtn.setAttribute('aria-label', label);
            this.elements.subsToggleBtn.setAttribute('title', label);
            this.elements.subsToggleBtn.setAttribute('aria-pressed', String(this.subs.enabled));
        },

        // Tab title follows the loaded stream, in the current language. Before a
        // stream is loaded the static <title> from player.html stands.
        applyDocumentTitle() {
            if (!this.state.currentId) return;
            document.title = `${this.t.tabTitle} [${this.state.currentId.substr(0, 7)}]`;
        },

        // Persist an explicit user choice, then apply it.
        selectLanguage(lang) {
            localStorage.setItem(LANG_STORAGE_KEY, lang);
            this.changeLanguage(lang);
        },

        changeLanguage(lang) {
            const t = this.translations[lang] || this.translations.en;
            this.t = t;
            this.state.currentLang = t.lang;

            document.documentElement.lang = t.lang;
            this.elements.titleText.innerText = t.title;
            this.elements.subtitleText.innerText = t.subtitle;
            this.elements.linkInput.placeholder = t.placeholder;
            this.elements.inputLabel.innerText = t.inputLabel;
            this.elements.playBtn.innerText = t.play;
            this.elements.helpLabel.innerText = t.helpLabel;
            this.elements.helpBody.innerHTML = t.helpBody;
            this.elements.loadingText.innerText = this.interpolate(t[this.state.loadingKey], this.state.loadingParams);
            this.elements.attributionLink.setAttribute('aria-label', t.githubTitle);
            this.elements.attributionLink.setAttribute('title', t.githubTitle);
            this.elements.subsUrlLabel.innerText = t.subsUrlLabel;
            this.elements.subsHelp.innerText = t.subsHelp;
            this.updateSubsToggleLabel();
            if (this.subs.statusKey && this.elements.subsStatus.classList.contains('visible')) {
                this.elements.subsStatus.innerText = t[this.subs.statusKey];
            }

            if (this.elements.player && typeof this.elements.player.language === 'function') {
                this.elements.player.language(t.lang);
            }

            // Re-render a visible error or hint in the new language.
            if (this.state.lastErrorType) {
                this.elements.errorMessage.innerText = this.interpolate(t[this.state.lastErrorType], this.state.lastErrorParams);
            }
            if (this.elements.pressPlayHint.classList.contains('visible')) {
                this.elements.pressPlayText.innerText = t.pressPlay;
            }
            this.applyDocumentTitle();

            // Keep the toggle button's accessible name in sync.
            const label = this.state.panelVisible ? t.hidePanel : t.showPanel;
            this.elements.toggleBtn.setAttribute('aria-label', label);

            // Highlight the active language button.
            this.elements.langControls.querySelectorAll('.lang-button').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.lang === lang);
                btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
            });
        }
    };

    // Expose for debugging/console use.
    window.app = app;
    app.init();
});
