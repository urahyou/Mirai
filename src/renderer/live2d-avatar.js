(function exposeLive2DAvatar() {
  'use strict';

  const MAX_RESOLUTION = 2;
  const MODEL_SCALE = 1.55;
  const ALPHA_HIT_THRESHOLD = 24;

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
        preserveDrawingBuffer: true,
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
      this.model.y = height * 0.57;
      // 0.57 是经验值：头部须低于顶部对话气泡区（约窗口上方 160px）
      // 且腿部不得超出窗口底边；配合 WINDOW.height=600 时两者兼得。
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
      return this.isRenderedPixelHit(clientX, clientY) === true;
    }

    isRenderedPixelHit(clientX, clientY) {
      const renderer = this.app?.renderer;
      const gl = renderer?.gl;
      const rect = this.canvas.getBoundingClientRect();
      if (!gl || !rect.width || !rect.height) return null;
      const xIn = clientX - rect.left;
      const yIn = clientY - rect.top;
      if (xIn < 0 || yIn < 0 || xIn >= rect.width || yIn >= rect.height) return false;

      const pixelX = Math.min(gl.drawingBufferWidth - 1, Math.floor(xIn * gl.drawingBufferWidth / rect.width));
      const pixelY = Math.min(gl.drawingBufferHeight - 1, Math.floor(gl.drawingBufferHeight - 1 - yIn * gl.drawingBufferHeight / rect.height));
      const pixel = new Uint8Array(4);
      try {
        gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (pixel[3] >= ALPHA_HIT_THRESHOLD) return true;
        // 单像素未命中时再扫一个小邻域：角色边缘/细发丝/抗锯齿处单像素 alpha 常偏低，
        // 容易误判成“没点在人物上”而把点击穿透到桌面。
        return this.scanNeighborhood(pixelX, pixelY);
      } catch (error) {
        console.warn('[Live2D] alpha hit extraction failed:', error);
        return null;
      }
    }

    // 在命中点周围扫一个小邻域（7x7），任一像素不透明即视为命中，消除边缘误判
    scanNeighborhood(cx, cy) {
      const renderer = this.app?.renderer;
      const gl = renderer?.gl;
      if (!gl) return false;
      const r = 3;
      const x0 = Math.max(0, cx - r);
      const y0 = Math.max(0, cy - r);
      const x1 = Math.min(gl.drawingBufferWidth - 1, cx + r);
      const y1 = Math.min(gl.drawingBufferHeight - 1, cy + r);
      const width = x1 - x0 + 1;
      const height = y1 - y0 + 1;
      const buffer = new Uint8Array(width * height * 4);
      try {
        gl.readPixels(x0, y0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        for (let i = 3; i < buffer.length; i += 4) {
          if (buffer[i] >= ALPHA_HIT_THRESHOLD) return true;
        }
      } catch (error) {
        console.warn('[Live2D] neighborhood hit extraction failed:', error);
        return false;
      }
      return false;
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
