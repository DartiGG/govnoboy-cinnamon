const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const Tooltips = imports.ui.tooltips;

const API = 'http://ge1.rock.hosts.name:34633/images';
const COUNT = 10;
const REFRESH_SECONDS = 60;
const ANIMATION_MS = 280;

function iconButton(iconName, tooltipText, callback) {
    let button = new St.Button({
        style_class: 'control-button',
        reactive: true,
        can_focus: true,
        track_hover: true,
        child: new St.Icon({ icon_name: iconName, icon_size: 16 })
    });
    new Tooltips.Tooltip(button, tooltipText);
    button.connect('clicked', callback);
    return button;
}

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
        this._requestGeneration = 0;
        this._animating = false;

        this._root = new St.BoxLayout({
            vertical: false,
            style_class: 'api-image-feed'
        });
        this._root.set_width(220);
        this._root.set_height(150);
        this.setContent(this._root);

        this._imageFrame = new St.Widget({
            style_class: 'image-frame',
            reactive: true,
            x_expand: true,
            y_expand: true,
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

        let sidePanel = new St.BoxLayout({
            vertical: true,
            style_class: 'side-panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._root.add_child(sidePanel);

        this._status = new St.Label({ style_class: 'status', text: '0/0' });
        sidePanel.add_child(this._status);

        this._controls = new St.BoxLayout({
            vertical: true,
            style_class: 'controls'
        });
        sidePanel.add_child(this._controls);

        this._controls.add_child(iconButton('go-up-symbolic', 'Предыдущее', () => this._previous()));
        this._controls.add_child(iconButton('view-refresh-symbolic', 'Обновить', () => this._refresh()));
        this._controls.add_child(iconButton('document-save-symbolic', 'Скачать', () => this._downloadCurrent()));
        this._controls.add_child(iconButton('go-down-symbolic', 'Следующее', () => this._next()));

        this._imageFrame.connect('scroll-event', (_actor, event) => {
            if (this._animating || this._loading)
                return Clutter.EVENT_STOP;

            let direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.DOWN)
                this._next();
            else if (direction === Clutter.ScrollDirection.UP)
                this._previous();
            return Clutter.EVENT_STOP;
        });

        this._imageFrame.connect('button-release-event', (_actor, event) => {
            if (this._animating || this._loading)
                return Clutter.EVENT_STOP;

            let button = event.get_button();
            if (button === 1) this._next();
            else if (button === 3) this._previous();
            return Clutter.EVENT_STOP;
        });

        this._imageFrame.connect('allocation-changed', () => this._fitImages());

        this._refresh();
        this._scheduleRefresh();
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
            this._refresh();
            return true;
        });
    }

    _setStatus(text) {
        this._status.text = text;
    }

    _request(url) {
        return new Promise((resolve, reject) => {
            let message = Soup.Message.new('GET', url);
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
                try {
                    let bytes = this._session.send_and_read_finish(result);
                    if (message.get_status() < 200 || message.get_status() >= 300)
                        throw new Error(`HTTP ${message.get_status()}`);
                    resolve(bytes);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _getImageUrl() {
        let bytes = await this._request(API);
        let text = new TextDecoder('utf-8').decode(bytes.get_data());
        let data = JSON.parse(text);
        if (!data.url)
            throw new Error('API не вернул url');
        return data.url;
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

            this._urls = urls;
            this._index = 0;
            this._files = [];
            this._activeImage.translation_x = 0;
            this._activeImage.translation_y = 0;
            this._inactiveImage.translation_x = 0;
            this._inactiveImage.translation_y = 0;

            await this._downloadPreview(0, generation);
            if (generation === this._requestGeneration)
                this._setStatus(`1/${this._urls.length}`);
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
            let path = new URL(url).pathname;
            let match = path.match(/\.(jpe?g|png|webp|gif)$/i);
            if (match)
                ext = '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (_) {}

        return Gio.File.new_for_path(
            GLib.build_filenamev([cacheDir, `image-${index}${ext}`])
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

        let file = this._files[index];
        if (!file) {
            file = this._tempFile(index, this._urls[index]);
            try {
                await this._downloadToFile(this._urls[index], file);
                this._files[index] = file;
            } catch (e) {
                logError(e, 'API Image Feed: image download failed');
                throw e;
            }
        }

        if (generation !== this._requestGeneration)
            return null;

        return file;
    }

    _setImageActorFile(actor, file) {
        actor.gicon = new Gio.FileIcon({ file });
        actor.opacity = 255;
        this._fitOneImage(actor);
    }

    _fitOneImage(actor) {
        if (!actor || !this._imageFrame)
            return;

        let w = this._imageFrame.width;
        let h = this._imageFrame.height;
        if (w <= 0 || h <= 0)
            return;

        let size = Math.max(16, Math.floor(Math.min(w, h) - 4));
        actor.icon_size = size;
        actor.set_position(Math.floor((w - size) / 2), Math.floor((h - size) / 2));
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

        let generation = this._requestGeneration;
        let file;
        try {
            file = await this._downloadPreview(target, generation);
        } catch (_) {
            this._setStatus('Err');
            return;
        }

        if (!file || generation !== this._requestGeneration)
            return;

        this._animating = true;
        this._index = target;
        this._setStatus(`${this._index + 1}/${this._urls.length}`);

        this._setImageActorFile(this._inactiveImage, file);

        let h = Math.max(1, this._imageFrame.height);
        let fromY = direction > 0 ? -h : h;
        let toY = direction > 0 ? h : -h;

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
            GLib.build_filenamev([downloads, `api-image-${Date.now()}${ext}`])
        );

        try {
            this._setStatus('...');
            await this._downloadToFile(source, file);
            this._setStatus(`OK ${this._index + 1}`);
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

        this._requestGeneration++;
        this._session.abort();
    }
}

function main(metadata, deskletId) {
    return new ApiImageFeedDesklet(metadata, deskletId);
}
