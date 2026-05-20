import { test } from 'node:test';
import assert from 'node:assert/strict';

function parseBooleanLike(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return undefined;
    }
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
    return undefined;
}

function coerceConfigOverrideValue(rawValue, currentValue) {
    if (typeof currentValue === 'boolean') {
        return parseBooleanLike(rawValue);
    }
    if (typeof currentValue === 'number') {
        const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue);
        return Number.isFinite(numeric) ? numeric : undefined;
    }
    if (typeof currentValue === 'string') {
        if (typeof rawValue === 'string') {
            return rawValue.length > 0 ? rawValue : undefined;
        }
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
            return String(rawValue);
        }
        if (typeof rawValue === 'boolean') {
            return rawValue ? 'true' : 'false';
        }
        return undefined;
    }
    const booleanLike = parseBooleanLike(rawValue);
    if (booleanLike !== undefined) return booleanLike;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    return undefined;
}

function applyConfigOverride(config, key, rawValue) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) return false;
    const value = coerceConfigOverrideValue(rawValue, config[key]);
    if (value === undefined) return false;
    config[key] = value;
    return true;
}

function applyUrlConfigOverrides(config, search) {
    const params = new URLSearchParams(search);
    for (const [paramKey, rawValue] of params.entries()) {
        if (!paramKey.startsWith('cfg.')) continue;
        const configKey = paramKey.slice(4);
        applyConfigOverride(config, configKey, rawValue);
    }
}

function applySessionConfigMetadata(metadata, config, keys) {
    if (!metadata || typeof metadata !== 'object') return;
    const overrides = metadata.config;
    if (!overrides || typeof overrides !== 'object') return;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            applyConfigOverride(config, key, overrides[key]);
        }
    }
}

function buildSessionConfigMetadata(config, keys) {
    const out = {};
    for (const key of keys) out[key] = config[key];
    return out;
}

test('URL overrides: no params preserves defaults', () => {
    const cfg = { FRACTURE_ENABLED: false, FRACTURE_JAGGEDNESS: 0.35 };
    applyUrlConfigOverrides(cfg, '');
    assert.equal(cfg.FRACTURE_ENABLED, false);
    assert.equal(cfg.FRACTURE_JAGGEDNESS, 0.35);
});

test('URL overrides: booleans parse true/false/1/0/on/off', () => {
    const cases = [
        ['?cfg.FRACTURE_ENABLED=true', true],
        ['?cfg.FRACTURE_ENABLED=1', true],
        ['?cfg.FRACTURE_ENABLED=on', true],
        ['?cfg.FRACTURE_ENABLED=false', false],
        ['?cfg.FRACTURE_ENABLED=0', false],
        ['?cfg.FRACTURE_ENABLED=off', false],
    ];
    for (const [query, expected] of cases) {
        const cfg = { FRACTURE_ENABLED: false };
        applyUrlConfigOverrides(cfg, query);
        assert.equal(cfg.FRACTURE_ENABLED, expected, `query ${query}`);
    }
});

test('URL overrides: numeric values are parsed and applied', () => {
    const cfg = { FRACTURE_ENABLED: false, FRACTURE_JAGGEDNESS: 0.35 };
    applyUrlConfigOverrides(cfg, '?cfg.FRACTURE_JAGGEDNESS=0.6');
    assert.equal(cfg.FRACTURE_JAGGEDNESS, 0.6);
});

test('session metadata: creator config is serializable and joiner adopts it', () => {
    const keys = ['FRACTURE_ENABLED'];
    const creatorCfg = { FRACTURE_ENABLED: true };
    const sessionMetadata = { config: buildSessionConfigMetadata(creatorCfg, keys) };
    const joinerCfg = { FRACTURE_ENABLED: false };
    applySessionConfigMetadata(sessionMetadata, joinerCfg, keys);
    assert.equal(joinerCfg.FRACTURE_ENABLED, true);
});

test('session metadata precedence: session config wins over local URL-derived value', () => {
    const keys = ['FRACTURE_ENABLED'];
    const cfg = { FRACTURE_ENABLED: false };
    applyUrlConfigOverrides(cfg, '?cfg.FRACTURE_ENABLED=1');
    assert.equal(cfg.FRACTURE_ENABLED, true);
    applySessionConfigMetadata({ config: { FRACTURE_ENABLED: false } }, cfg, keys);
    assert.equal(cfg.FRACTURE_ENABLED, false);
});

test('URL overrides: string-typed config accepts arbitrary string values', () => {
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=rectilinear');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'rectilinear');
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=classic');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'classic');
});

test('URL overrides: empty string-typed value is rejected (keeps current value)', () => {
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'polar');
});

test('string-typed config: numeric / boolean raw values are stringified', () => {
    // The debug BroadcastChannel may send a Number for sliders; the
    // session metadata path may carry a Boolean from an older client. Both
    // are coerced into the string-typed slot rather than silently dropped.
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    assert.equal(coerceConfigOverrideValue(42, cfg.TOUCH_CONTROL_SCHEME), '42');
    assert.equal(coerceConfigOverrideValue(true, cfg.TOUCH_CONTROL_SCHEME), 'true');
    assert.equal(coerceConfigOverrideValue(false, cfg.TOUCH_CONTROL_SCHEME), 'false');
    assert.equal(coerceConfigOverrideValue(NaN, cfg.TOUCH_CONTROL_SCHEME), undefined);
    assert.equal(coerceConfigOverrideValue(null, cfg.TOUCH_CONTROL_SCHEME), undefined);
});

test('session metadata: string-typed config round-trips creator → joiner', () => {
    const keys = ['TOUCH_CONTROL_SCHEME'];
    const creatorCfg = { TOUCH_CONTROL_SCHEME: 'rectilinear' };
    const sessionMetadata = { config: buildSessionConfigMetadata(creatorCfg, keys) };
    const joinerCfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applySessionConfigMetadata(sessionMetadata, joinerCfg, keys);
    assert.equal(joinerCfg.TOUCH_CONTROL_SCHEME, 'rectilinear');
});
