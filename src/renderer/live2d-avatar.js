(function exposeLive2DAvatar() {
  'use strict';

  const MAX_RESOLUTION = 2;
  const MODEL_SCALE = 1.55;

  class Live2DAvatar {
    constructor({ canvas, modelSrc }) {
      this.canvas = canvas;
      this.modelSrc = modelSrc;
      this.app = null;
      this.model = null;
      this.ready = false;
      this.resizeObserver = null;
      this.baseSize = null;
    }

    async load() {
      if (!window.PIXI || !window.PIXI.live2d) {
        throw new Error('Live2D runtime is unavailable');
      }

      const { Live2DModel } = window.PIXI.live2d;
      Live2DModel.registerTicker(window.PIXI.Ticker);

      const size = this.getSize();
      this.app = new window.PIXI.Application({
        view: this.canvas,
        width: size.width,
        height: size.height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION),
      });
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.display = 'block';

      this.model = await Live2DModel.from(this.modelSrc, { autoInteract: false });
      this.model.anchor.set(0.5, 0.5);
      this.model.on('hit', (areas) => {
        if (areas.includes('Body')) this.playMotion('Tap@Body');
      });
      this.app.stage.addChild(this.model);
      this.baseSize = { width: this.model.width, height: this.model.height };
      this.ready = true;
      this.resize();
      this.playMotion('Idle', 0);

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas.parentElement);
      return this;
    }

    getSize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      return {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    }

    resize() {
      if (!this.app || !this.model) return;
      const { width, height } = this.getSize();
      this.app.renderer.resize(width, height);
      const scale = Math.min((width * 0.94) / this.baseSize.width, (height * 0.94) / this.baseSize.height) * MODEL_SCALE;
      this.model.scale.set(scale, scale);
      this.model.x = width / 2;
      // Hiyori's model origin sits near the torso rather than the visual center.
      // Bottom-aligning the anchor keeps the face visible in the compact pet window.
      this.model.y = height * 0.9;
    }

    toStagePoint(clientX, clientY) {
      if (!this.app) return null;
      const rect = this.canvas.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
      return {
        x: (clientX - rect.left) * this.app.screen.width / rect.width,
        y: (clientY - rect.top) * this.app.screen.height / rect.height,
      };
    }

    isHit(clientX, clientY) {
      if (!this.ready || !this.model) return false;
      const point = this.toStagePoint(clientX, clientY);
      if (!point) return false;
      return this.model.hitTest(point.x, point.y).length > 0
        || this.model.containsPoint(new window.PIXI.Point(point.x, point.y));
    }

    focus(clientX, clientY) {
      if (!this.ready || !this.model) return;
      const point = this.toStagePoint(clientX, clientY);
      if (point) this.model.focus(point.x, point.y);
    }

    tap(clientX, clientY) {
      if (!this.ready || !this.model) return;
      const point = this.toStagePoint(clientX, clientY);
      if (point) this.model.tap(point.x, point.y);
    }

    setState(state) {
      if (state === 'idle') this.playMotion('Idle', 0);
    }

    playMotion(group, index) {
      if (!this.ready || !this.model) return;
      this.model.motion(group, index).catch(() => {});
    }

    destroy() {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.app) {
        this.app.destroy(true, { children: true, texture: true, baseTexture: true });
      } else if (this.model) {
        this.model.destroy();
      }
      this.app = null;
      this.model = null;
      this.baseSize = null;
      this.ready = false;
    }
  }

  window.Live2DAvatar = Live2DAvatar;
})();
