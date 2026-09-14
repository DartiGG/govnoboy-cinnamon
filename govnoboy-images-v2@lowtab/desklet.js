const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Meta = imports.gi.Meta;

const API = 'http://ge1.rock.hosts.name:34633/images';
const COUNT = 10;
const REFRESH_SECONDS = 60;
const ANIMATION_MS = 280;

class ApiImageFeedDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);
        this.setHeader('API Image Feed');

        this._session = new Soup.Session();
        this._urls = [];
        this._files = [];
        this._index = 0;
        this._loading = false;
        this._refreshTimer = null;
        this._autoSlideTimer = null;
        this._requestGeneration = 0;
        this._animating = false;

        // Настройки по умолчанию
        this.enableAutoSwitch = true;
        this.slideInterval = 5;
        this.presetSize = 'medium';
        this.pauseWhenDesktopInactive = true;
        this._displaySignalId = null;

        // Биндинг настроек
        try {
            this.settings = new Settings.DeskletSettings(this, this.metadata.uuid, deskletId);
            this.settings.bindProperty(Settings.BindingDirection.IN, "enableAutoSwitch", "enableAutoSwitch", this._onSettingsChanged.bind(this), null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "slideInterval", "slideInterval", this._onSettingsChanged.bind(this), null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "presetSize", "presetSize", this._updateDimensions.bind(this), null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "pauseWhenDesktopInactive", "pauseWhenDesktopInactive", this._onPauseSettingChanged.bind(this), null);
            this._displaySignalId = global.display.connect('notify::focus-window', this._onFocusWindowChanged.bind(this));
        } catch (e) {
            // Не глотаем ошибку молча — иначе все настройки тихо остаются
            // на дефолтных значениях, и непонятно почему.
            logError(e, 'API Image Feed: settings bind failed');
        }

        this._root = new St.BoxLayout({
            vertical: false,
            style_class: 'api-image-feed'
        });
        this.setContent(this._root);

        this._imageFrame = new St.Widget({
            style_class: 'image-frame',
            reactive: true,
            x_expand: false,
            y_expand: false,
            layout_manager: new Clutter.BinLayout()
        });
        this._imageFrame.set_clip_to_allocation(true);
        this._root.add_child(this._imageFrame);

        this._imageA = this._createImage();
        this._imageB = this._createImage();
        this._imageFrame.add_child(this._imageA);
        this._imageFrame.add_child(this._imageB);
        this._activeImage = this._imageA;
        this._inactiveImage = this._imageB;
        this._inactiveImage.hide();

        this._addContextMenuItems();

        this._imageFrame.connect('scroll-event', (_actor, event) => {
            if (this._animating || this._loading)
                return Clutter.EVENT_STOP;

            let direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.DOWN)
                this._next();
            else if (direction === Clutter.ScrollDirection.UP)
                this._previous();

            this._startAutoSlideTimer();
            return Clutter.EVENT_STOP;
        });

        this._imageFrame.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            if (this._animating || this._loading)
                return Clutter.EVENT_STOP;

            this._next();
            this._startAutoSlideTimer();
            return Clutter.EVENT_STOP;
        });

        this._imageFrame.connect('allocation-changed', () => this._fitImages());

        this._updateDimensions();
        this._refresh();
        this._scheduleRefresh();
        this._startAutoSlideTimer();
    }

    _updateDimensions() {
        let width = 150;
        let height = 150;

        switch (this.presetSize) {
            case 'small':
                width = 110;
                height = 110;
                break;
            case 'medium':
                width = 150;
                height = 150;
                break;
            case 'large':
                width = 230;
                height = 230;
                break;
            case 'xlarge':
                width = 320;
                height = 320;
                break;
        }

        this._root.set_width(width);
        this._root.set_height(height);

        this._imageFrame.set_width(width);
        this._imageFrame.set_height(height);

        this._fitImages();
    }

    _addContextMenuItems() {
        let refreshItem = new PopupMenu.PopupMenuItem('Обновить изображения');
        refreshItem.connect('activate', () => {
            this._refresh();
            this._startAutoSlideTimer();
        });
        this._menu.addMenuItem(refreshItem);

        let downloadItem = new PopupMenu.PopupMenuItem('Скачать текущее изображение');
        downloadItem.connect('activate', () => this._downloadCurrent());
        this._menu.addMenuItem(downloadItem);
    }

    _onSettingsChanged() {
        this._startAutoSlideTimer();
    }

    _onPauseSettingChanged() {
        this._startAutoSlideTimer();
        this._scheduleRefresh();
    }

    _onFocusWindowChanged() {
        if (this._isDesktopActive()) {
            this._startAutoSlideTimer();
            this._scheduleRefresh();
        } else {
            this._stopAutoSlideTimer();
        }
    }

    _isDesktopActive() {
        if (!this.pauseWhenDesktopInactive)
            return true;

        let window = global.display.focus_window;
        if (!window)
            return true;

        try {
            let type = window.get_window_type();
            return type === Meta.WindowType.DESKTOP ||
                   type === Meta.WindowType.DOCK;
        } catch (_) {
            return false;
        }
    }

    _startAutoSlideTimer() {
        this._stopAutoSlideTimer();

        if (!this.enableAutoSwitch || !this._isDesktopActive())
            return;

        this._autoSlideTimer = Mainloop.timeout_add_seconds(this.slideInterval, () => {
            if (!this._isDesktopActive())
                return false;

            if (this._urls.length > 0 && !this._loading && !this._animating) {
                this._next();
            }
            return true;
        });
    }

    _stopAutoSlideTimer() {
        if (this._autoSlideTimer) {
            Mainloop.source_remove(this._autoSlideTimer);
            this._autoSlideTimer = null;
        }
    }

    _createImage() {
        let image = new St.Icon({
            icon_name: 'image-x-generic',
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            opacity: 255
        });
        image.set_pivot_point(0.5, 0.5);
        return image;
    }

    _scheduleRefresh() {
        if (this._refreshTimer)
            Mainloop.source_remove(this._refreshTimer);

        this._refreshTimer = Mainloop.timeout_add_seconds(REFRESH_SECONDS, () => {
            if (!this._isDesktopActive())
                return true;

            this._refresh();
            return true;
        });
    }

    _setStatus(text) {}

    _request(url) {
        return new Promise((resolve, reject) => {
            let message = Soup.Message.new('GET', url);
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
                try {
                    let bytes = this._session.send_and_read_finish(result);
                    if (message.get_status() < 200 || message.get_status() >= 300)
                        throw new Error('HTTP ' + message.get_status());
                    resolve(bytes);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _getImageUrl() {
        let bytes = await this._request(API);
        let text = imports.byteArray.toString(bytes.get_data());
        let data = JSON.parse(text);
        if (!data.url)
            throw new Error('API не вернул url');
        return data.url;
    }

    _cleanupOldFiles() {
        if (!this._files) return;
        for (let file of this._files) {
            if (file && file.query_exists(null)) {
                try {
                    file.delete(null);
                } catch (_) {}
            }
        }
    }

    async _refresh() {
        if (this._loading)
            return;

        this._loading = true;
        const generation = ++this._requestGeneration;
        this._setStatus('...');

        try {
            let results = await Promise.all(
                Array.from({ length: COUNT }, () => this._getImageUrl().catch(() => null))
            );

            if (generation !== this._requestGeneration)
                return;

            let urls = results.filter(Boolean);
            if (!urls.length)
                throw new Error('Ошибка');

            this._cleanupOldFiles();

            this._urls = urls;
            this._index = 0;
            this._files = [];

            // Сброс анимаций
            this._activeImage.remove_all_transitions();
            this._inactiveImage.remove_all_transitions();
            this._animating = false;

            this._activeImage.translation_x = 0;
            this._activeImage.translation_y = 0;
            this._inactiveImage.translation_x = 0;
            this._inactiveImage.translation_y = 0;
            this._inactiveImage.hide();

            let firstFile = await this._downloadPreview(0, generation);
            if (generation === this._requestGeneration && firstFile) {
                this._setImageActorFile(this._activeImage, firstFile);
                this._setStatus('1/' + this._urls.length);
                this._prefetchNext(0, generation);
            }
        } catch (e) {
            logError(e, 'API Image Feed: refresh failed');
            this._setStatus('Err');
        } finally {
            this._loading = false;
        }
    }

    _tempFile(index, url) {
        let cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'cinnamon-api-image-feed']);
        GLib.mkdir_with_parents(cacheDir, 0o755);

        let ext = '.jpg';
        try {
            let cleanUrl = url.split('?')[0].split('#')[0];
            let match = cleanUrl.match(/\.(jpe?g|png|webp|gif)$/i);
            if (match)
                ext = '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (_) {}

        return Gio.File.new_for_path(
            GLib.build_filenamev([cacheDir, 'img-' + this._requestGeneration + '-' + index + ext])
        );
    }

    async _downloadToFile(url, file) {
        let bytes = await this._request(url);
        let stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            stream.write_bytes(bytes, null);
        } finally {
            stream.close(null);
        }
        return file;
    }

    async _downloadPreview(index, generation) {
        if (!this._urls[index] || generation !== this._requestGeneration)
            return null;

        if (this._files[index])
            return this._files[index];

        let file = this._tempFile(index, this._urls[index]);
        try {
            await this._downloadToFile(this._urls[index], file);
            if (generation !== this._requestGeneration) return null;
            this._files[index] = file;
            return file;
        } catch (e) {
            logError(e, 'API Image Feed: image download failed');
            throw e;
        }
    }

    _prefetchNext(currentIndex, generation) {
        if (!this._urls.length) return;
        let nextIndex = (currentIndex + 1) % this._urls.length;
        this._downloadPreview(nextIndex, generation).catch(() => {});
    }

    _setImageActorFile(actor, file) {
        actor.gicon = new Gio.FileIcon({ file });
        actor.opacity = 255;
        this._fitOneImage(actor);
    }

    _fitOneImage(actor) {
        if (!actor || !this._imageFrame)
            return;

        const w = this._imageFrame.width;
        const h = this._imageFrame.height;
        if (w <= 0 || h <= 0)
            return;

        const padding = 6;
        const size = Math.max(16, Math.floor(Math.min(w, h) - padding));

        actor.set_size(size, size);
        actor.icon_size = size;
        actor.set_position(
            Math.floor((w - size) / 2),
            Math.floor((h - size) / 2)
        );
    }

    _fitImages() {
        this._fitOneImage(this._imageA);
        this._fitOneImage(this._imageB);
    }

    async _show(index, direction) {
        if (!this._urls.length || this._animating || this._loading)
            return;

        let target = (index + this._urls.length) % this._urls.length;
        if (target === this._index)
            return;

        this._animating = true;
        let generation = this._requestGeneration;
        let file;

        try {
            file = await this._downloadPreview(target, generation);
        } catch (_) {
            this._animating = false;
            this._setStatus('Err');
            return;
        }

        if (!file || generation !== this._requestGeneration) {
            this._animating = false;
            return;
        }

        this._index = target;
        this._setStatus((this._index + 1) + '/' + this._urls.length);

        this._setImageActorFile(this._inactiveImage, file);

        let h = Math.max(1, this._imageFrame.height);
        let fromY = direction > 0 ? h : -h;
        let toY = direction > 0 ? -h : h;

        this._activeImage.translation_x = 0;
        this._activeImage.translation_y = 0;
        this._inactiveImage.translation_x = 0;
        this._inactiveImage.translation_y = fromY;
        this._inactiveImage.show();

        this._activeImage.ease({
            translation_y: toY,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC
        });

        this._inactiveImage.ease({
            translation_y: 0,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._activeImage.hide();
                this._activeImage.translation_y = 0;
                this._inactiveImage.translation_y = 0;

                let old = this._activeImage;
                this._activeImage = this._inactiveImage;
                this._inactiveImage = old;

                this._animating = false;
                this._prefetchNext(this._index, generation);
            }
        });
    }

    _next() {
        if (!this._urls.length || this._loading || this._animating)
            return;
        this._show(this._index + 1, 1);
    }

    _previous() {
        if (!this._urls.length || this._loading || this._animating)
            return;
        this._show(this._index - 1, -1);
    }

    async _downloadCurrent() {
        if (!this._urls[this._index])
            return;

        let downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (!downloads)
            downloads = GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);

        downloads = GLib.build_filenamev([downloads, 'API-Images']);
        GLib.mkdir_with_parents(downloads, 0o755);

        let source = this._urls[this._index];
        let ext = '.jpg';
        try {
            let path = new URL(source).pathname;
            let match = path.match(/\.(jpe?g|png|webp|gif)$/i);
            if (match)
                ext = '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (_) {}

        let file = Gio.File.new_for_path(
            GLib.build_filenamev([downloads, 'api-image-' + Date.now() + ext])
        );

        try {
            this._setStatus('...');
            await this._downloadToFile(source, file);
            this._setStatus('OK ' + (this._index + 1));
        } catch (e) {
            logError(e, 'API Image Feed: save failed');
            this._setStatus('Err');
        }
    }

    on_desklet_removed() {
        if (this._refreshTimer) {
            Mainloop.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }

        this._stopAutoSlideTimer();
        if (this._displaySignalId) {
            global.display.disconnect(this._displaySignalId);
            this._displaySignalId = null;
        }
        this._cleanupOldFiles();
        this._requestGeneration++;
    }
}

function main(metadata, deskletId) {
    return new ApiImageFeedDesklet(metadata, deskletId);
}
