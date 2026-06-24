CUSTOM CAR SPRITES
==================

Drop your own PNG images here to replace the drawn cars.

File name must match the model id:
  classic.png      -> Classic
  sports.png       -> Sportster
  muscle.png       -> Muscle
  suv.png          -> Off-Roader
  f1.png           -> Formula

Rules for best results:
- PNG with a TRANSPARENT background.
- The car should point UP (front of the car at the top of the image).
- Roughly 2:3 ratio (taller than wide), e.g. 120 x 200 px. It is auto-scaled.
- Keep it small (under ~100 KB) so it loads fast online.

Where to find free sprites (check the license allows use):
- kenney.nl/assets  (free, no attribution needed)  <- easiest
- opengameart.org   (filter by "top-down car")
- itch.io game-assets

After adding files: hard-refresh the page (Ctrl+Shift+R).
If a PNG is missing or fails to load, the built-in drawn sprite is used instead.

To add a BRAND-NEW car, also add an entry to the MODELS array in public/game.js
(e.g. { id: 'police', name: 'Police' }) and drop a police.png here.
