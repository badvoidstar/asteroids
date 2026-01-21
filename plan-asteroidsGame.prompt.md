# Asteroids Game Implementation Plan (Snapshot: January 20, 2026)

## Recent Changes
- **Classic Arcade Sounds**: Web Audio API-generated sounds including thrust rumble, fire "pew", asteroid explosions (size-based pitch), ship explosion, background heartbeat, and new wave chime
- **Dynamic Background Beat**: Two-tone heartbeat that speeds up as asteroids are destroyed (like original arcade)
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
│  │   │ ⓪ AUDIO SYSTEM (Web Audio API)                      │ │  │
│  │   │   • AudioSystem object with ctx, masterVolume       │ │  │
│  │   │   • init(), resume() for browser autoplay policy    │ │  │
│  │   │   • thrustSound: low rumble (noise+filter)          │ │  │
│  │   │   • playFire(): descending square wave "pew"        │ │  │
│  │   │   • playExplosion(size): pitch varies by size       │ │  │
│  │   │   • playShipExplosion(): dramatic multi-tone death  │ │  │
│  │   │   • beat: alternating tones, tempo scales with      │ │  │
│  │   │     remaining asteroid area (fewer = faster)        │ │  │
│  │   │   • playNewWave(): ascending tone                   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
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
│  │   │   • init() — reset state, spawn wave, start beat    │ │  │
│  │   │   • spawnWave() — create asteroids for wave         │ │  │
│  │   │   • togglePause() — pause/resume, stop/start sounds │ │  │
│  │   │   • handleInput() — read keys{}/touch{}, apply      │ │  │
│  │   │     thrust sound start/stop based on state change   │ │  │
│  │   │   • checkCollisions() — bullets↔asteroids, ship↔ast │ │  │
│  │   │   • splitAsteroid() — energy-conserving split +     │ │  │
│  │   │     play explosion sound (size-based)               │ │  │
│  │   │   • handleShipHit() — ship explosion sound, respawn │ │  │
│  │   │   • updateHUD(), drawCenteredText()                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑥ GAME LOOP (delta-time based)                      │ │  │
│  │   │                                                     │ │  │
│  │   │   gameLoop(timestamp) {                             │ │  │
│  │   │       ┌──────────────────────────┐                  │ │  │
│  │   │       │ Calculate dt (delta time)│                  │ │  │
│  │   │       │ dt = elapsed / (1000/60) │ norm. to 60fps   │ │  │
│  │   │       └──────────┬───────────────┘                  │ │  │
│  │   │                  ▼                                  │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ handleInput()│                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ if (paused)  │--> skip updates              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌───────────────────────┐                     │ │  │
│  │   │       │ UPDATE PHASE          │                     │ │  │
│  │   │       │ ship.update(dt)       │ <-- all movement    │ │  │
│  │   │       │ asteroids[].update(dt)│     scaled by dt    │ │  │
│  │   │       │ bullets[].update(dt)  │                     │ │  │
│  │   │       └──────────┬────────────┘                     │ │  │
│  │   │                  ▼                                  │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkCollisions()│                          │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ Update beat tempo│ (asteroid area)          │ │  │
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
 │ Keyboard │------------->│   keys{}    │              │  Canvas  │
 │ Events   │              └──────┬──────┘              │ Rendering│
 └──────────┘                     │                     └────^─────┘
 ┌──────────┐              ┌──────┴──────┐                   │
 │  Touch   │------------->│  touch{}    │                   │
 │ Events   │              └──────┬──────┘                   │
 └──────────┘                     │                          │
                                  v                          │
                         ┌────────────────┐                  │
                         │  handleInput() │                  │
                         └───────┬────────┘                  │
                                 │                           │
                    ESC/P ───────┼-------> togglePause()     │
                                 │         (stop/start beat) │
                                 v                           │
 ┌─────────┐  update(dt)  ┌─────────────┐     draw     ┌─────┴─────┐
 │  Ship   │<------------>│             │------------->│  Vector   │
 ├─────────┤              │  Game Loop  │              │  Lines    │
 │Asteroids│<------------>│ (delta-time │------------->│  (stroke) │
 ├─────────┤              │  based)     │              └───────────┘
 │ Bullets │<------------>│             │                    │
 └─────────┘              └──────┬──────┘                    v
       ^                         │                     ┌───────────┐
       │         ┌───────────────┼─────────────────┐   │    HUD    │
       │         v               v                 │   │Score/Lives│
       │  ┌─────────────────┐  ┌────────────────┐  │   │ /Wave/    │
       └──┤checkCollisions()│  │ AudioSystem    │  │   │PauseMenu/ │
          └────────┬────────┘  │ • beat.tempo <─┼──┘   │TouchBtns  │
                   │ on hit    │ • thrustSound  │      └───────────┘
                   v           │ • playFire()   │
          ┌─────────────────┐  │ • playExplosion│      ┌───────────┐
          │ splitAsteroid() │──┤   (size-based) │----->│   Audio   │
          │ (energy conserv)│  │ • playShipExpl │      │  Output   │
          │ or handleShipHit│  │ • playNewWave  │      └───────────┘
          └─────────────────┘  └────────────────┘

 ┌──────────────────────────────────────────────────────────────────┐
 │ RESIZE HANDLING                                                  │
 │                                                                  │
 │  window.resize ───┐                                              │
 │  orientationchange┼--> resizeCanvas() --> scale entity positions │
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

## Audio System (Web Audio API)

All sounds are procedurally generated using the Web Audio API—no external audio files required.

| Sound | Description | Implementation |
|-------|-------------|----------------|
| **Thrust** | Continuous low rumble | Looped noise buffer → lowpass filter (150Hz) |
| **Fire** | Classic "pew" | Square wave 880Hz→110Hz exponential sweep |
| **Explosion** | Size-based pitch | Noise burst + sine thump, freq varies by size |
| **Ship Death** | Dramatic multi-tone | 3 descending sawtooth waves + noise burst |
| **Background Beat** | Two-tone heartbeat | Alternating triangle waves (55Hz/50Hz) |
| **New Wave** | Ascending chime | Sine wave 200Hz→600Hz sweep |

**Dynamic Beat Tempo:**
```
tempo = minTempo + (maxTempo - minTempo) × (asteroidArea / maxArea)

More asteroids → slower beat (1000ms)
Fewer asteroids → faster beat (150ms)
```

## CONFIG Reference

All tunable game parameters are centralized in a CONFIG object:

| Category | Parameter | Value | Description |
|----------|-----------|-------|-------------|
| **Display** | BASE_WIDTH | 800 | Reference canvas width (pixels) |
| | BASE_HEIGHT | 600 | Reference canvas height (pixels) |
| | TARGET_FPS | 60 | Frame rate for delta-time normalization |
| **Ship** | SHIP_SIZE | 15 | Ship radius (pixels) |
| | SHIP_THRUST | 0.15 | Acceleration per frame |
| | SHIP_FRICTION | 0.99 | Velocity damping per frame |
| | SHIP_TURN_SPEED | 0.08 | Rotation speed (radians/frame) |
| | SHIP_MAX_SPEED | 8 | Maximum velocity magnitude |
| | STARTING_LIVES | 3 | Initial lives |
| | INVULNERABILITY_TIME | 180 | Respawn protection (frames) |
| | INVULN_BLINK_RATE | 10 | Frames per blink during invuln |
| **Bullets** | BULLET_SPEED | 10 | Bullet velocity |
| | BULLET_LIFETIME | 60 | Frames until despawn |
| | BULLET_RADIUS | 2 | Collision radius |
| | MAX_BULLETS | 10 | Maximum active bullets |
| | SHOOT_COOLDOWN | 10 | Frames between shots |
| **Asteroids** | ASTEROID_BASE_COUNT | 1 | Starting asteroids (wave 1) |
| | ASTEROID_BASE_SPEED | 1.5 | Initial asteroid speed |
| | ASTEROID_SPEED_VARIANCE | 1 | Random speed variation ± |
| | ASTEROID_VERTICES | 10 | Points per asteroid shape |
| | ASTEROID_JAGGEDNESS | 0.4 | Shape irregularity (0-1) |
| | INITIAL_ASTEROID_RADIUS | 50 | Large asteroid size |
| | MIN_ASTEROID_RADIUS | 15 | Smallest fragment size |
| | MIN_SPLIT_RATIO | 0.1 | Minimum child size as ratio |
| **Waves** | WAVE_DELAY | 120 | Frames between waves |
| | WAVE_ASTEROID_INCREMENT | 1 | Additional asteroids per wave |
| | WAVE_SPEED_MULTIPLIER | 1.1 | Speed increase per wave |
| | MAX_SPEED_MULTIPLIER | 2.0 | Speed cap multiplier |
| **Scoring** | POINTS_LARGE | 20 | Large asteroid points |
| | POINTS_MEDIUM | 50 | Medium asteroid points |
| | POINTS_SMALL | 100 | Small asteroid points |

## Algorithm Details

### Ship Geometry
The ship is drawn as a triangle with two wing tips:
```javascript
// Nose (front)
nose = (x + cos(angle) × size, y + sin(angle) × size)

// Wings (rear corners at ±144° from nose direction)
wingAngle = angle + Math.PI × 0.8  // ~144 degrees
leftWing  = (x + cos(wingAngle) × size, y + sin(wingAngle) × size)
rightWing = (x + cos(-wingAngle) × size, y - sin(wingAngle) × size)
```

### Asteroid Shape Generation
Each asteroid has randomized vertices for irregular appearance:
```javascript
for (i = 0; i < ASTEROID_VERTICES; i++) {
    angle = (i / ASTEROID_VERTICES) × 2π
    variance = 1 + (random() - 0.5) × ASTEROID_JAGGEDNESS
    vertex = { angle, distance: radius × variance }
}
```

### Collision Detection: Point-in-Polygon (Ray Casting)
Used for checking if ship nose or bullet center is inside asteroid:
```javascript
pointInPolygon(x, y, polygon):
    inside = false
    for each edge (v1 → v2):
        if ray from (x,y) going right crosses edge:
            inside = !inside
    return inside
```

### Collision Detection: Circle-to-Polygon
Used for ship body collision (ship as circle against asteroid polygon):
```javascript
circlePolygonCollision(circle, polygon):
    // First check if circle center is inside polygon
    if pointInPolygon(circle.x, circle.y, polygon):
        return true
    
    // Then check if any polygon edge intersects circle
    for each edge (v1 → v2):
        // Find closest point on edge to circle center
        edgeVector = v2 - v1
        projection = clamp(dot(circleCenter - v1, edgeVector), 0, edgeLength)
        closestPoint = v1 + normalize(edgeVector) × projection
        
        if distance(closestPoint, circleCenter) ≤ circle.radius:
            return true
    
    return false
```

### Safe Spawn Distance
New asteroids spawn at safe distance from ship:
```javascript
minDistance = 150  // pixels from ship center
do {
    x = random(0, canvas.width)
    y = random(0, canvas.height)
} while (distance(x, y, ship.x, ship.y) < minDistance)
```

### Audio Frequencies Reference

| Sound | Frequencies / Parameters |
|-------|-------------------------|
| Thrust | Noise → Lowpass filter at 150Hz, gain 0.25 |
| Fire | Square wave 880Hz→110Hz exponential sweep, gain 0.075 |
| Explosion | Noise + Sine (60/90/120Hz based on size), gain 0.3 |
| Ship Death | 3× Sawtooth (300/200/100Hz) descending + noise, gain 0.3 |
| Beat High | Triangle wave at 55Hz, gain 0.3 |
| Beat Low | Triangle wave at 50Hz, gain 0.3 |
| Beat Tempo | Range: 150ms (fast) to 1000ms (slow) |
| New Wave | Sine 200Hz→600Hz exponential sweep, gain 0.2 |

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
