# Asteroids Game Implementation Plan (Snapshot: January 16, 2026)

## Recent Changes
- **Wave Progression**: Game now starts with 1 asteroid, adding 1 more per wave
- **Energy Conservation**: Asteroid splits preserve kinetic energy - smaller pieces move faster, larger pieces slower
- **Pause Menu**: Press ESC or P to pause; auto-pauses when window loses focus

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  asteroids.html                                                 │
├─────────────────────────────────────────────────────────────────┤
│  <!DOCTYPE html>                                                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <head>                                                    │  │
│  │   <style> Canvas centering, background, HUD styling,      │  │
│  │           pause menu overlay                              │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <body>                                                    │  │
│  │   <canvas id="game">                                      │  │
│  │   <div id="pause-menu"> (overlay with controls help)      │  │
│  │   <script>                                                │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ① CONFIG (constants object)                         │ │  │
│  │   │   • SHIP_SIZE, TURN_SPEED, THRUST                   │ │  │
│  │   │   • BULLET_SPEED, BULLET_LIFETIME                   │ │  │
│  │   │   • ASTEROID_BASE_COUNT: 1 (starts with 1 asteroid) │ │  │
│  │   │   • ASTEROID_SIZES, ASTEROID_SPEED                  │ │  │
│  │   │   • STARTING_LIVES, POINTS_PER_SIZE                 │ │  │
│  │   │   • WAVE_ASTEROID_INCREMENT: 1, MAX_SPEED_MULTIPLIER│ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ② CLASSES                                           │ │  │
│  │   │                                                     │ │  │
│  │   │   Ship ─────────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, angle, velocity                     │   │ │  │
│  │   │   │ • vertices[], invulnerable, thrust          │   │ │  │
│  │   │   │ • update(), draw(), getVertices(), shoot()  │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Asteroid ─────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocity, size, vertices[]          │   │ │  │
│  │   │   │ • update(), draw(), generateShape()         │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Bullet ───────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocity, lifetime                  │   │ │  │
│  │   │   │ • update(), draw(), isExpired()             │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ③ HELPER FUNCTIONS                                  │ │  │
│  │   │   • pointInPolygon(point, vertices)                 │ │  │
│  │   │   • circlePolygonCollision(circle, polygon)         │ │  │
│  │   │   • wrapPosition(entity, canvas)                    │ │  │
│  │   │   • spawnAsteroidAwayFromShip(ship)                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ④ GAME STATE                                        │ │  │
│  │   │   • ship, asteroids[], bullets[]                    │ │  │
│  │   │   • score, lives, wave                              │ │  │
│  │   │   • state: 'playing'|'waveDelay'|'gameover'|'paused'│ │  │
│  │   │   • previousState (for resuming from pause)         │ │  │
│  │   │   • keys{} (input tracking)                         │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑤ GAME FUNCTIONS                                    │ │  │
│  │   │   • init() — reset state, spawn wave                │ │  │
│  │   │   • spawnWave(waveNumber) — create asteroids        │ │  │
│  │   │   • togglePause() — pause/resume game               │ │  │
│  │   │   • handleInput() — read keys{}, apply to ship      │ │  │
│  │   │   • checkCollisions() — bullets↔asteroids, ship↔ast │ │  │
│  │   │   • splitAsteroid(asteroid) — spawn smaller pieces  │ │  │
│  │   │     with ENERGY CONSERVATION (v = √(E/m))           │ │  │
│  │   │   • respawnShip() — invulnerability timer           │ │  │
│  │   │   • drawHUD() — score, lives, wave, messages        │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑥ GAME LOOP                                         │ │  │
│  │   │                                                     │ │  │
│  │   │   gameLoop(timestamp) {                             │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ handleInput()│                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ if (paused)  │──▶ skip updates              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ UPDATE PHASE │                              │ │  │
│  │   │       │ ship.update()│                              │ │  │
│  │   │       │ asteroids[]  │                              │ │  │
│  │   │       │ bullets[]    │                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkCollisions()│                          │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkWaveComplete│ → spawnWave() if empty   │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ RENDER PHASE │                              │ │  │
│  │   │       │ clearCanvas()│                              │ │  │
│  │   │       │ ship.draw()  │                              │ │  │
│  │   │       │ asteroids[]  │                              │ │  │
│  │   │       │ bullets[]    │                              │ │  │
│  │   │       │ drawHUD()    │                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       requestAnimationFrame(gameLoop)               │ │  │
│  │   │   }                                                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑦ EVENT LISTENERS & INIT                            │ │  │
│  │   │   • keydown → keys[e.code] = true                   │ │  │
│  │   │   • keydown → ESC/P toggles pause                   │ │  │
│  │   │   • keyup   → keys[e.code] = false                  │ │  │
│  │   │   • blur    → auto-pause when window loses focus    │ │  │
│  │   │   • init() called on load                           │ │  │
│  │   │   • requestAnimationFrame(gameLoop) to start        │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   </script>                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagram

```
    INPUTS                    GAME STATE                   OUTPUTS
 ┌──────────┐              ┌─────────────┐              ┌──────────┐
 │ Keyboard │─────────────▶│   keys{}    │              │  Canvas  │
 │ Events   │              └──────┬──────┘              │ Rendering│
 └──────────┘                     │                     └────▲─────┘
                                  ▼                          │
                         ┌────────────────┐                  │
                         │  handleInput() │                  │
                         └───────┬────────┘                  │
                                 │                           │
                    ESC/P ───────┼───────▶ togglePause()     │
                                 ▼                           │
 ┌─────────┐    update    ┌─────────────┐     draw     ┌─────┴─────┐
 │  Ship   │◀────────────▶│             │─────────────▶│  Vector   │
 ├─────────┤              │  Game Loop  │              │  Lines    │
 │Asteroids│◀────────────▶│ (skip if    │─────────────▶│  (stroke) │
 ├─────────┤              │  paused)    │              └───────────┘
 │ Bullets │◀────────────▶│             │                    │
 └─────────┘              └──────┬──────┘                    ▼
       ▲                         │                     ┌───────────┐
       │         ┌───────────────┘                     │    HUD    │
       │         ▼                                     │Score/Lives│
       │  ┌─────────────────┐                          │ /Wave/    │
       └──│checkCollisions()│                          │PauseMenu  │
          └────────┬────────┘                          └───────────┘
                   │ on hit
                   ▼
          ┌─────────────────┐
          │ splitAsteroid() │──▶ points += SIZE_SCORE
          │ (energy conserv)│──▶ smaller = faster, larger = slower
          │ or loseLife()   │──▶ lives -= 1
          └─────────────────┘
```

## Energy Conservation on Asteroid Split

When an asteroid splits, kinetic energy is conserved:
- **E = ½ × mass × v²** (mass ∝ radius² in 2D)
- Each child receives energy proportional to its mass
- Speed calculated as **v = √(E / r²)**
- Result: smaller fragments move faster, larger fragments move slower

## Controls
- **Arrow Keys / WASD** — Move ship
- **SPACE** — Shoot
- **ESC / P** — Pause/Resume
- **ENTER** — Restart (from game over or pause menu)

---

*This is a snapshot of the implementation plan and may not reflect subsequent changes.*
