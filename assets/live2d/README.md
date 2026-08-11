# Live2D Runtime And Model Assets

`runtime/live2dcubismcore.min.js` is the Live2D Cubism Core runtime, downloaded from the official Live2D Cubism Web SDK distribution.

`models/hiyori_free_zh/` is the official Hiyori Free Cubism sample model. Its bundled `ReadMe.txt` contains the original Chinese usage notice, creator credits, and the link to the applicable Live2D sample-model license terms:

https://www.live2d.com/zh-CHS/download/sample-data/

Replacing this model requires a Cubism 3/4/5 `.model3.json` model with all referenced files kept in the same relative layout.

## Runtime integration

The renderer is Live2D-only. `src/renderer/index.html` creates the model canvas and `src/renderer/live2d-avatar.js` loads the model through `pixi-live2d-display`.

Character interaction uses `Live2DAvatar.isHit()`, which checks both model hit areas and the rendered model geometry. The old `assets/character/` PNG fallback has been removed. The PNG files inside the model runtime directory, such as `texture_00.png`, are required Live2D textures and must remain next to the model files.
