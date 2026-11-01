document.addEventListener('DOMContentLoaded', () => {
    const LANG_STORAGE_KEY = 'ace-player-lang';

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

        // --- STATE ---
        state: {
            currentLang: null,
            currentId: null,
            lastErrorType: null,
            lastErrorParams: null,
            panelVisible: true,
            awaitingFirstPlay: false,
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
            }
        },

        // --- INITIALIZATION ---
        init() {
            this.elements.player = videojs("video", { fluid: true });
            this.addEventListeners();
            this.startStallWatch();
            this.changeLanguage(this.detectLanguage());

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
                }
            });
            this.elements.player.on('error', () => this.handleFailure());
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
