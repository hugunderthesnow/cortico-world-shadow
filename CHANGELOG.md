# Changelog

## 1.0.1

First public release. (1.0.0 was left in npm as a staged record and cannot be published as a stable version, so the first release ships as 1.0.1; the contents are the same.)

## 1.0.0

First release.

- A second, smaller body (0.45×) that follows the desktop pet and stands 130 px beside it; walks when the gap is small, runs when it is large, glides when the height differs.
- Takes pokes only: no grab cursor, no dragging, no patting, no throw. Poking it never reaches the model and costs no tokens.
- Copies the pet's sit, sleep, dance and dizzy states; startles when the pet is picked up or thrown; replays `pet_act` / `pet_say` motions.
- One tool, `pet_shadow`: the pet pokes the shadow once, the shadow plays one random motion, the receipt names it (`影子做了：转圈`).
- Shadow sound effects play at 20% of the pet's volume.
- Settings: size 0.2–1, follow gap 40–400 px, speed 0.3–2, volume 0–1, figure pack (dropdown of installed packs), reply timeout 500–8000 ms.
- Turning the extension off removes the shadow within 8 seconds: the rendering patch polls this extension and lets go when it stops answering.
