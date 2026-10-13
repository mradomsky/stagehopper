# Four public theme tokens; every other shade derived with color-mix()

The Theme is exactly four CSS custom properties (`--sh-bg`, `--sh-surface`, `--sh-text`, `--sh-accent`). Every other UI shade (surface steps, borders, muted text, accent hover) is a private token computed from them with `color-mix()`, never a fixed value, so overriding four colours restyles every consumer screen coherently. The cost: at default values derived shades sit a few RGB levels off the old hardcoded palette, so "renders identically" means no perceptible difference, not pixel equality. Exposing the shades as more public tokens was rejected to keep a prospect's brand to four inputs; keeping them fixed was rejected because a light brand would leave dark-grey leftovers.

Not themed: Pick gold, stage and participant colours, notification blue, warning amber, black backdrops and shadows, admin screens. Text on the accent stays `#fff`, so whoever supplies a Theme (#112, #116) must keep the accent dark enough for white text.

Source: #106
