# Particle Sim

A canvas-based particle simulation gardening game built with TypeScript and Vite.

**[▶ Play it here](https://thomasphorton.github.io/particle-sim/)**

## Features

- **Particle physics** — sand, water, and powder simulation with gravity, flow, and displacement
- **Gardening** — plant seeds in watered dirt, grow stems and flowers, harvest blooms with shears
- **Water systems** — faucets with adjustable flow, sprinklers that spray in parabolic arcs
- **Soil mechanics** — dirt absorbs and wicks moisture, grass grows on wet surfaces and retains moisture
- **Inventory** — spend harvested flowers on upgrades

## Development

```bash
npm install
npm run dev
```

## Build version metadata

The production build now emits a `dist/version.json` file and shows a subtle version badge in the game UI. The badge uses the GitHub Actions commit SHA when available, with local fallbacks such as `local` when the build is run outside CI.
