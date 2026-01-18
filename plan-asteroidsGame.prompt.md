# Asteroids Game Implementation Plan (Snapshot: January 18, 2026)

## Recent Changes
- **Wave Progression**: Game now starts with 1 asteroid, adding 1 more per wave
- **Energy Conservation**: Asteroid splits preserve kinetic energy - smaller pieces move faster, larger pieces slower
- **Pause Menu**: Press ESC or P to pause; auto-pauses when window loses focus (desktop only)
- **Mobile Touch Controls**: Virtual buttons for rotation, thrust, fire, and pause on touch devices
- **Dynamic Window Sizing**: Canvas fills viewport and scales on resize/rotation
- **Delta-Time Movement**: Consistent game speed across all display refresh rates (60Hz, 90Hz, 120Hz, etc.)

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  asteroids.html                                                 │
├─────────────────────────────────────────────────────────────────┤
│  <!DOCTYPE html>                                                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <head>                                                    │  │
│  │   <meta viewport> (mobile-optimized, no zoom)             │  │
│  │   <style> Full-viewport canvas, HUD styling,              │  │
│  │           pause menu overlay, mobile touch buttons        │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <body>                                                    │  │
│  │   <canvas id="game"> (fills viewport)                     │  │
│  │   <div id="pause-menu"> (overlay with controls help)      │  │
│  │   <div id="mobile-controls"> (touch buttons)              │  │
│  │   <script>                                                │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ① CONFIG (constants object)                         │ │  │
│  │   │   • BASE_WIDTH/HEIGHT: 800x600 (reference dims)     │ │  │
│  │   │   • TARGET_FPS: 60 (for delta-time normalization)   │ │  │
│  │   │   • SHIP_SIZE, TURN_SPEED, THRUST                   │ │  │
│  │   │   • BULLET_SPEED, BULLET_LIFETIME                   │ │  │
│  │   │   • ASTEROID_BASE_COUNT: 1 (starts with 1 asteroid) │ │  │
│  │   │   • WAVE_ASTEROID_INCREMENT: 1, MAX_SPEED_MULTIPLIER│ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ② UTILITY FUNCTIONS                                 │ │  │
│  │   │   • resizeCanvas() — scale canvas & entity positions│ │  │
│  │   │   • getScaleFactor() — visual scaling relative to   │ │  │
│  │   │     base dimensions                                 │ │  │
│  │   │   • wrapValue(), distance(), randomRange()          │ │  │
│  │   │   • pointInPolygon(), circlePolygonCollision()      │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ③ CLASSES                                           │ │  │
│  │   │                                                     │ │  │
│  │   │   Ship ─────────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, angle, velocityX/Y                  │   │ │  │
│  │   │   │ • invulnerable, shootCooldown, thrusting    │   │ │  │
│  │   │   │ • update(canvas, dt), draw(), shoot()       │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Asteroid ─────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocityX/Y, radius, vertices[]     │   │ │  │
│  │   │   │ • update(canvas, dt), draw(), getPoints()   │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Bullet ───────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocityX/Y, lifetime               │   │ │  │
│  │   │   │ • update(canvas, dt), draw(), isExpired()   │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ④ GAME STATE                                        │ │  │
│  │   │   • ship, asteroids[], bullets[]                    │ │  │
│  │   │   • score, lives, wave, speedMultiplier             │ │  │
│  │   │   • state: 'playing'|'waveDelay'|'gameover'|'paused'│ │  │
│  │   │   • previousState (for resuming from pause)         │ │  │
│  │   │   • lastFrameTime (for delta-time calculation)      │ │  │
│  │   │   • keys{} (keyboard), touch{} (mobile input)       │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑤ GAME FUNCTIONS                                    │ │  │
│  │   │   • init() — reset state, spawn wave                │ │  │
│  │   │   • spawnWave() — create asteroids for wave         │ │  │
│  │   │   • togglePause() — pause/resume, reset lastFrame   │ │  │
│  │   │   • handleInput() — read keys{}/touch{}, apply      │ │  │
│  │   │   • checkCollisions() — bullets↔asteroids, ship↔ast │ │  │
│  │   │   • splitAsteroid() — energy-conserving split       │ │  │
│  │   │   • loseLife() — respawn or game over               │ │  │
│  │   │   • updateHUD(), drawCenteredText()                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑥ GAME LOOP (delta-time based)                      │ │  │
│  │   │                                                     │ │  │
│  │   │   gameLoop(timestamp) {                             │ │  │
│  │   │       ┌──────────────────────────┐                  │ │  │
│  │   │       │ Calculate dt (delta time)│                  │ │  │
│  │   │       │ dt = elapsed / (1000/60) │ normalized to 60fps│ │ │
│  │   │       └──────────┬───────────────┘                  │ │  │
│  │   │                  ▼                                  │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ handleInput()│                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ if (paused)  │──▶ skip updates              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────────┐                      │ │  │
│  │   │       │ UPDATE PHASE         │                      │ │  │
│  │   │       │ ship.update(dt)      │ ◀── all movement    │ │  │
│  │   │       │ asteroids[].update(dt)│     scaled by dt   │ │  │
│  │   │       │ bullets[].update(dt) │                      │ │  │
│  │   │       └──────┬───────────────┘                      │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkCollisions()│                          │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ RENDER PHASE │                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       requestAnimationFrame(gameLoop)               │ │  │
│  │   │   }                                                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑦ EVENT LISTENERS                                   │ │  │
│  │   │   • keydown/keyup → keys{} tracking                 │ │  │
│  │   │   • ESC/P → togglePause()                           │ │  │
│  │   │   • blur → auto-pause (desktop only)                │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑧ MOBILE TOUCH CONTROLS                             │ │  │
│  │   │   • isTouchDevice detection                         │ │  │
│  │   │   • Touch button handlers → touch{} state           │ │  │
│  │   │   • Prevents default touch gestures                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑨ WINDOW RESIZE HANDLING                            │ │  │
│  │   │   • resize event → resizeCanvas()                   │ │  │
│  │   │   • orientationchange → resizeCanvas()              │ │  │
│  │   │   • visualViewport resize → resizeCanvas()          │ │  │
│  │   │   • Initial resizeCanvas() before init()            │ │  │
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
 ┌──────────┐              ┌──────┴──────┐                   │
 │  Touch   │─────────────▶│  touch{}    │                   │
 │ Events   │              └──────┬──────┘                   │
 └──────────┘                     │                          │
                                  ▼                          │
                         ┌────────────────┐                  │
                         │  handleInput() │                  │
                         └───────┬────────┘                  │
                                 │                           │
                    ESC/P ───────┼───────▶ togglePause()     │
                                 ▼                           │
 ┌─────────┐  update(dt)  ┌─────────────┐     draw     ┌─────┴─────┐
 │  Ship   │◀────────────▶│             │─────────────▶│  Vector   │
 ├─────────┤              │  Game Loop  │              │  Lines    │
 │Asteroids│◀────────────▶│ (delta-time │─────────────▶│  (stroke) │
 ├─────────┤              │  based)     │              └───────────┘
 │ Bullets │◀────────────▶│             │                    │
 └─────────┘              └──────┬──────┘                    ▼
       ▲                         │                     ┌───────────┐
       │         ┌───────────────┘                     │    HUD    │
       │         ▼                                     │Score/Lives│
       │  ┌─────────────────┐                          │ /Wave/    │
       └──│checkCollisions()│                          │PauseMenu/ │
          └────────┬────────┘                          │TouchBtns  │
                   │ on hit                            └───────────┘
                   ▼
          ┌─────────────────┐
          │ splitAsteroid() │──▶ points += SIZE_SCORE
          │ (energy conserv)│──▶ smaller = faster, larger = slower
          │ or loseLife()   │──▶ lives -= 1
          └─────────────────┘

 ┌──────────────────────────────────────────────────────────────────┐
 │ RESIZE HANDLING                                                  │
 │                                                                  │
 │  window.resize ──┐                                               │
 │  orientationchange─┼──▶ resizeCanvas() ──▶ scale entity positions│
 │  visualViewport ──┘                                              │
 └──────────────────────────────────────────────────────────────────┘
```

## Delta-Time Movement

All movement is normalized to 60fps for consistent speed across devices:
```
dt = elapsed_ms / (1000 / TARGET_FPS)

At 60Hz:  dt ≈ 1.0  →  position += velocity × 1.0
At 120Hz: dt ≈ 0.5  →  position += velocity × 0.5  (half movement, twice the frames)
At 90Hz:  dt ≈ 0.67 →  position += velocity × 0.67
```

## Energy Conservation on Asteroid Split

When an asteroid splits, kinetic energy is conserved:
- **E = ½ × mass × v²** (mass ∝ radius² in 2D)
- Each child receives energy proportional to its mass
- Speed calculated as **v = √(E / r²)**
- Result: smaller fragments move faster, larger fragments move slower

## Controls

### Desktop
- **Arrow Keys / WASD** — Move ship
- **SPACE** — Shoot
- **ESC / P** — Pause/Resume
- **ENTER** — Restart (from game over or pause menu)

### Mobile (auto-detected)
- **◀ / ▶** — Rotate left/right
- **▲** — Thrust
- **FIRE** — Shoot
- **❚❚** — Pause
- **RESTART** — Appears on game over

## Live URL
**https://badvoidstar.github.io/asteroids/asteroids.html**

---

*This is a snapshot of the implementation plan and may not reflect subsequent changes.*
