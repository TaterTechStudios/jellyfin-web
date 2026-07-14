import { AppFeature } from 'constants/appFeature';
import { PluginType } from 'constants/pluginType';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import { appHost } from '../../components/apphost';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import profileBuilder from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import Events from '../../utils/events.ts';

function getDefaultProfile() {
    return profileBuilder({});
}

let fadeTimeout;
function fade(instance, elem, startingVolume) {
    instance._isFadingOut = true;

    // Need to record the starting volume on each pass rather than querying elem.volume
    // This is due to iOS safari not allowing volume changes and always returning the system volume value
    const newVolume = Math.max(0, startingVolume - 0.15);
    console.debug('fading volume to ' + newVolume);
    elem.volume = newVolume;

    if (newVolume <= 0) {
        instance._isFadingOut = false;
        return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
        cancelFadeTimeout();
        fadeTimeout = setTimeout(function () {
            fade(instance, elem, newVolume).then(resolve, reject);
        }, 100);
    });
}

function cancelFadeTimeout() {
    const timeout = fadeTimeout;
    if (timeout) {
        clearTimeout(timeout);
        fadeTimeout = null;
    }
}

function supportsFade() {
    // Not working on tizen.
    // We could possibly enable on other tv's, but all smart tv browsers tend to be pretty primitive
    return !browser.tv;
}

function requireHlsPlayer(callback) {
    import('hls.js/dist/hls.js').then(({ default: hls }) => {
        hls.DefaultConfig.lowLatencyMode = false;
        hls.DefaultConfig.backBufferLength = Infinity;
        hls.DefaultConfig.liveBackBufferLength = 90;
        window.Hls = hls;
        callback();
    });
}

function enableHlsPlayer(url, item, mediaSource, mediaType) {
    if (!htmlMediaHelper.enableHlsJsPlayer(mediaSource.RunTimeTicks, mediaType)) {
        return Promise.reject();
    }

    if (url.indexOf('.m3u8') !== -1) {
        return Promise.resolve();
    }

    // issue head request to get content type
    return new Promise(function (resolve, reject) {
        import('../../utils/fetch').then((fetchHelper) => {
            fetchHelper.ajax({
                url: url,
                type: 'HEAD'
            }).then(function (response) {
                const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                if (contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegurl') {
                    resolve();
                } else {
                    reject();
                }
            }, reject);
        });
    });
}

class HtmlAudioPlayer {
    constructor() {
        const self = this;

        self.name = 'Html Audio Player';
        self.type = PluginType.MediaPlayer;
        self.id = 'htmlaudioplayer';

        // Let any players created by plugins take priority
        self.priority = 1;

        self.play = function (options) {
            resetPreload();

            self._started = false;
            self._timeUpdated = false;
            self._currentTime = null;
            self._pendingSeekTarget = null;

            const elem = createMediaElement();

            return setCurrentSrc(elem, options);
        };

        function setCurrentSrc(elem, options) {
            unBindEvents(elem);
            bindEvents(elem);

            let val = options.url;
            console.debug('playing url: ' + val);
            import('../../scripts/settings/userSettings').then((userSettings) => {
                if (browser.iOS) {
                    // createMediaElementSource breaks playbackRate and pitch on iOS WebKit
                    return;
                }

                let normalizationGain;
                if (userSettings.selectAudioNormalization() == 'TrackGain') {
                    normalizationGain = options.item.NormalizationGain
                        ?? options.mediaSource.albumNormalizationGain;
                } else if (userSettings.selectAudioNormalization() == 'AlbumGain') {
                    normalizationGain =
                        options.mediaSource.albumNormalizationGain
                        ?? options.item.NormalizationGain;
                } else {
                    console.debug('normalization disabled');
                    return;
                }

                if (!self.gainNode) {
                    addGainElement(elem);
                    if (!self.gainNode) return;
                }

                if (normalizationGain) {
                    self.normalizationGain = Math.pow(10, normalizationGain / 20);
                    self.gainNode.gain.value = self.normalizationGain;
                } else {
                    self.gainNode.gain.value = 1;
                    self.normalizationGain = 1;
                }
                if (browser.safari) {
                    // Gain value is absolute in Safari. Add volume from the slider
                    self.gainNode.gain.value *= elem.volume;
                }
                console.debug('gain: ' + self.normalizationGain);
            }).catch((err) => {
                console.error('Failed to add/change gainNode', err);
            });

            const atempoRate = Number.parseFloat((val.match(/AudioPlaybackRate=([\d.]+)/) || [])[1]) || 1;
            const seconds = (options.playerStartPositionTicks || 0) / 10000000 / atempoRate;
            if (seconds) {
                val += '#t=' + seconds;
            }

            htmlMediaHelper.destroyHlsPlayer(self);

            self._currentPlayOptions = options;

            const crossOrigin = htmlMediaHelper.getCrossOriginValue(options.mediaSource);
            if (crossOrigin) {
                elem.crossOrigin = crossOrigin;
            }

            // This avoids the AudioContext being suspended when Safari is put into background
            if ('audioSession' in navigator) {
                navigator.audioSession.type = 'playback';
            }

            return enableHlsPlayer(val, options.item, options.mediaSource, 'Audio').then(function () {
                return new Promise(function (resolve, reject) {
                    requireHlsPlayer(async () => {
                        const includeCorsCredentials = await getIncludeCorsCredentials();

                        const hls = new Hls({
                            manifestLoadingTimeOut: 20000,
                            enableWorker: false,
                            xhrSetup: function (xhr) {
                                xhr.withCredentials = includeCorsCredentials;
                            }
                        });
                        hls.loadSource(val);
                        hls.attachMedia(elem);

                        htmlMediaHelper.bindEventsToHlsPlayer(self, hls, elem, onError, resolve, reject);

                        self._hlsPlayer = hls;

                        self._currentSrc = val;
                    });
                });
            }, async () => {
                elem.autoplay = true;

                const includeCorsCredentials = await getIncludeCorsCredentials();
                if (includeCorsCredentials) {
                    // Safari will not send cookies without this
                    elem.crossOrigin = 'use-credentials';
                }

                return htmlMediaHelper.applySrc(elem, val, options).then(function () {
                    self._currentSrc = val;

                    return htmlMediaHelper.playWithPromise(elem, onError);
                });
            });
        }

        function bindEvents(elem) {
            elem.addEventListener('timeupdate', onTimeUpdate);
            elem.addEventListener('ended', onEnded);
            elem.addEventListener('volumechange', onVolumeChange);
            elem.addEventListener('pause', onPause);
            elem.addEventListener('playing', onPlaying);
            elem.addEventListener('play', onPlay);
            elem.addEventListener('waiting', onWaiting);
        }

        function unBindEvents(elem) {
            elem.removeEventListener('timeupdate', onTimeUpdate);
            elem.removeEventListener('ended', onEnded);
            elem.removeEventListener('volumechange', onVolumeChange);
            elem.removeEventListener('pause', onPause);
            elem.removeEventListener('playing', onPlaying);
            elem.removeEventListener('play', onPlay);
            elem.removeEventListener('waiting', onWaiting);
            elem.removeEventListener('error', onError); // bound in htmlMediaHelper
        }

        self.stop = function (destroyPlayer) {
            cancelFadeTimeout();
            resetPreload();

            const elem = self._mediaElement;
            const src = self._currentSrc;

            if (elem && src) {
                if (!destroyPlayer || !supportsFade()) {
                    elem.pause();

                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                    return Promise.resolve();
                }

                const originalVolume = elem.volume;

                return fade(self, elem, elem.volume).then(function () {
                    elem.pause();
                    elem.volume = originalVolume;

                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                });
            }
            return Promise.resolve();
        };

        self.destroy = function () {
            unBindEvents(self._mediaElement);
            htmlMediaHelper.resetSrc(self._mediaElement);
            resetPreload();
        };

        // Starts fetching and buffering the given stream in a hidden element, ahead of an anticipated switch.
        // Call promotePreload() to swap it in, or let it get superseded/discarded by the next preloadNext() call.
        self.preloadNext = function (options) {
            resetPreload();

            const elem = createPreloadMediaElement();
            self._preloadElement = elem;
            self._preloadOptions = options;
            self._preloadErrored = false;

            elem.addEventListener('error', onPreloadError);

            const val = options.url;

            enableHlsPlayer(val, options.item, options.mediaSource, 'Audio').then(function () {
                requireHlsPlayer(async () => {
                    // superseded by a newer preloadNext() call while hls.js was loading
                    if (self._preloadElement !== elem) {
                        return;
                    }

                    const includeCorsCredentials = await getIncludeCorsCredentials();

                    const hls = new Hls({
                        manifestLoadingTimeOut: 20000,
                        xhrSetup: function (xhr) {
                            xhr.withCredentials = includeCorsCredentials;
                        }
                    });
                    hls.on(Hls.Events.ERROR, function (event, data) {
                        // Non-fatal errors (e.g. bufferFullError once the unplayed element's buffer target is hit) are
                        // expected while preloading and don't mean the stream is unusable.
                        if (data?.fatal) {
                            onPreloadError();
                        }
                    });
                    hls.loadSource(val);
                    hls.attachMedia(elem);

                    self._preloadHlsPlayer = hls;
                });
            }, async () => {
                const includeCorsCredentials = await getIncludeCorsCredentials();
                if (includeCorsCredentials) {
                    elem.crossOrigin = 'use-credentials';
                }

                htmlMediaHelper.applySrc(elem, val, options).catch(onPreloadError);
            });
        };

        // Swaps the preloaded element in as the active one. Resolves false (leaving the caller to fall back
        // to a normal play()) if there's nothing usable preloaded.
        self.promotePreload = function () {
            const elem = self._preloadElement;
            const options = self._preloadOptions;

            if (!elem || !options || self._preloadErrored) {
                resetPreload();
                return Promise.resolve(false);
            }

            const hls = self._preloadHlsPlayer;
            self._preloadElement = null;
            self._preloadHlsPlayer = null;
            self._preloadOptions = null;
            elem.removeEventListener('error', onPreloadError);

            htmlMediaHelper.destroyHlsPlayer(self);
            if (self._mediaElement && self._mediaElement !== elem) {
                unBindEvents(self._mediaElement);
                htmlMediaHelper.resetSrc(self._mediaElement);
                self._mediaElement.remove();
            }

            elem.classList.remove('mediaPlayerAudioPreload');
            elem.classList.add('mediaPlayerAudio');
            if (elem.muted) {
                self._skipNextVolumeChange = true;
                elem.muted = false;
            }

            self._mediaElement = elem;
            self._hlsPlayer = hls;
            self._currentSrc = options.url;
            self._currentPlayOptions = options;
            self._started = false;
            self._timeUpdated = false;
            self._currentTime = null;
            self._pendingSeekTarget = null;

            bindEvents(elem);

            return htmlMediaHelper.playWithPromise(elem, onError).then(function () {
                return confirmPromotedPlaybackProgressing(elem);
            }, function () {
                rollBackPromotedElement(elem);
                return false;
            });
        };

        function confirmPromotedPlaybackProgressing(elem) {
            const startTime = elem.currentTime;

            return new Promise(function (resolve) {
                let settled = false;

                function settle(success) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    elem.removeEventListener('timeupdate', onProgress);
                    clearTimeout(timeoutId);

                    const stillCurrent = self._mediaElement === elem;
                    if (!success && stillCurrent) {
                        rollBackPromotedElement(elem);
                    }
                    resolve(success || !stillCurrent);
                }

                function onProgress() {
                    if (elem.currentTime - startTime > 0.3) {
                        settle(true);
                    }
                }

                elem.addEventListener('timeupdate', onProgress);
                const timeoutId = setTimeout(function () {
                    settle(elem.currentTime - startTime > 0.3);
                }, 1500);
            });
        }

        function rollBackPromotedElement(elem) {
            // Roll back the swap so a fallback play() builds a genuinely fresh element instead of reusing this broken one.
            unBindEvents(elem);
            htmlMediaHelper.resetSrc(elem);
            elem.remove();
            if (self._mediaElement === elem) {
                self._mediaElement = null;
                self._hlsPlayer = null;
            }
        }

        function onPreloadError() {
            self._preloadErrored = true;
        }

        function createPreloadMediaElement() {
            const elem = document.createElement('audio');
            elem.classList.add('mediaPlayerAudioPreload');
            elem.classList.add('hide');
            elem.muted = true;
            elem.preload = 'auto';

            document.body.appendChild(elem);

            return elem;
        }

        function resetPreload() {
            if (self._preloadHlsPlayer) {
                try {
                    self._preloadHlsPlayer.destroy();
                } catch (err) {
                    console.error(err);
                }
                self._preloadHlsPlayer = null;
            }

            if (self._preloadElement) {
                self._preloadElement.removeEventListener('error', onPreloadError);
                htmlMediaHelper.resetSrc(self._preloadElement);
                self._preloadElement.remove();
                self._preloadElement = null;
            }

            self._preloadOptions = null;
            self._preloadErrored = false;
        }

        function createMediaElement() {
            let elem = self._mediaElement;

            if (elem) {
                return elem;
            }

            elem = document.querySelector('.mediaPlayerAudio');

            if (!elem) {
                elem = document.createElement('audio');
                elem.classList.add('mediaPlayerAudio');
                elem.classList.add('hide');

                document.body.appendChild(elem);
            }

            // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
            if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                elem.volume = htmlMediaHelper.getSavedVolume();
            }

            self._mediaElement = elem;

            return elem;
        }

        function addGainElement(elem) {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext; /* eslint-disable-line compat/compat */

                const audioCtx = new AudioContext();
                const source = audioCtx.createMediaElementSource(elem);

                const gainNode = audioCtx.createGain();

                source.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                self.gainNode = gainNode;
            } catch (e) {
                console.error('Web Audio API is not supported in this browser', e);
            }
        }

        function onEnded() {
            htmlMediaHelper.onEndedInternal(self, this, onError);
        }

        function onTimeUpdate() {
            const time = this.currentTime;

            if (self._pendingSeekTarget !== null) {
                if (time < self._pendingSeekTarget) {
                    return;
                }
                self._pendingSeekTarget = null;
            }

            if (!self._isFadingOut) {
                self._currentTime = time;
                Events.trigger(self, 'timeupdate');
            }
        }

        function onVolumeChange() {
            if (self._skipNextVolumeChange) {
                self._skipNextVolumeChange = false;
                return;
            }
            if (!self._isFadingOut) {
                htmlMediaHelper.saveVolume(this.volume);
                if (browser.safari && self.gainNode) {
                    self.gainNode.gain.value = this.volume * self.normalizationGain;
                }
                Events.trigger(self, 'volumechange');
            }
        }

        function onPlaying(e) {
            if (!self._started) {
                self._started = true;
                this.removeAttribute('controls');

                const atempoRate = Number.parseFloat(((self._currentPlayOptions.url || '').match(/AudioPlaybackRate=([\d.]+)/) || [])[1]) || 1;
                const startTicks = self._currentPlayOptions.playerStartPositionTicks;
                const adjustedTicks = startTicks ? startTicks / atempoRate : startTicks;
                if (adjustedTicks) {
                    self._pendingSeekTarget = adjustedTicks / 10000000;
                }
                htmlMediaHelper.seekOnPlaybackStart(self, e.target, adjustedTicks);
            }
            Events.trigger(self, 'playing');
        }

        function onPlay() {
            Events.trigger(self, 'unpause');
        }

        function onPause() {
            Events.trigger(self, 'pause');
        }

        function onWaiting() {
            Events.trigger(self, 'waiting');
        }

        function onError() {
            const errorCode = this.error ? (this.error.code || 0) : 0;
            const errorMessage = this.error ? (this.error.message || '') : '';
            console.error('media element error: ' + errorCode.toString() + ' ' + errorMessage);

            let type;

            switch (errorCode) {
                case 1:
                    // MEDIA_ERR_ABORTED
                    // This will trigger when changing media while something is playing
                    return;
                case 2:
                    // MEDIA_ERR_NETWORK
                    type = MediaError.NETWORK_ERROR;
                    break;
                case 3:
                    // MEDIA_ERR_DECODE
                    if (self._hlsPlayer) {
                        htmlMediaHelper.handleHlsJsMediaError(self);
                        return;
                    } else {
                        type = MediaError.MEDIA_DECODE_ERROR;
                    }
                    break;
                case 4:
                    // MEDIA_ERR_SRC_NOT_SUPPORTED
                    type = MediaError.MEDIA_NOT_SUPPORTED;
                    break;
                default:
                    // seeing cases where Edge is firing error events with no error code
                    // example is start playing something, then immediately change src to something else
                    return;
            }

            htmlMediaHelper.onErrorInternal(self, type);
        }
    }

    currentSrc() {
        return this._currentSrc;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'audio';
    }

    getDeviceProfile(item) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item);
        }

        return getDefaultProfile();
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            if (val != null) {
                mediaElement.currentTime = val / 1000;
                return;
            }

            const currentTime = this._currentTime;
            if (currentTime) {
                return currentTime * 1000;
            }

            return (mediaElement.currentTime || 0) * 1000;
        }
    }

    duration() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (htmlMediaHelper.isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    seekable() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!htmlMediaHelper.isValidDuration(start)) {
                    start = 0;
                }
                if (!htmlMediaHelper.isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    getBufferedRanges() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return htmlMediaHelper.getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    pause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            // If the underlying connection died while backgrounded, rebuild the stream from the last known
            // position instead of leaving playback silently stuck.
            mediaElement.play().catch(() => {
                htmlMediaHelper.onErrorInternal(this, MediaError.NETWORK_ERROR);
            });
        }
    }

    paused() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    setVolume(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }
        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const mediaElement = this._mediaElement;

        if (mediaElement) {
            if (document.AirPlayEnabled) {
                if (isEnabled) {
                    mediaElement.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            } else {
                mediaElement.webkitShowPlaybackTargetPicker();
            }
        }
    }

    supports(feature) {
        if (!supportedFeatures) {
            supportedFeatures = getSupportedFeatures();
        }

        return supportedFeatures.indexOf(feature) !== -1;
    }
}

let supportedFeatures;

function getSupportedFeatures() {
    const list = [];
    const audio = document.createElement('audio');

    if (typeof audio.playbackRate === 'number') {
        list.push('PlaybackRate');
    }

    if (browser.safari) {
        list.push('AirPlay');
    }

    return list;
}

export default HtmlAudioPlayer;
