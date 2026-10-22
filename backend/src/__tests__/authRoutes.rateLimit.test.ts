/**
 * Brute-force limit and reset-window coverage for authRoutes (#2106).
 *
 * The router is mounted on a bare Express app so only the auth limiters run.
 * Date.now is pinned per test: express-rate-limit's MemoryStore reads it to
 * decide when a window has expired, so advancing it simulates the reset
 * without real waiting, and giving each test its own window keeps the
 * module-level limiter state from leaking between tests.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';

const fakeCacheStore = new Map<string, unknown>();
jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (key: string) => fakeCacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      fakeCacheStore.set(key, value);
    }),
    setNotExists: jest.fn(async (key: string, value: unknown) => {
      if (fakeCacheStore.has(key)) return false;
      fakeCacheStore.set(key, value);
      return true;
    }),
    deleteIfMatch: jest.fn(async (key: string, value: unknown) => {
      if (fakeCacheStore.get(key) !== value) return false;
      fakeCacheStore.delete(key);
      return true;
    }),
    delete: jest.fn(async (key: string) => {
      fakeCacheStore.delete(key);
    }),
    ping: jest.fn(async () => 'ok'),
  },
}));

const { default: authRoutes } = await import('../routes/authRoutes.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { generateJwtToken } = await import('../services/authService.js');

const WINDOW_MS = 60_000;
let clock = Date.UTC(2026, 0, 1);
const nowSpy = jest.spyOn(Date, 'now');

function buildApp(): Express {
  const app = express();
  // Lets tests pick a client IP through X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

// A body that passes schema validation but fails signature checks, so each
// accepted attempt reaches the controller and returns 401.
const badLogin = (publicKey: string) => ({
  publicKey,
  message: `Sign this message to log in. Timestamp: ${clock}`,
  signature: Buffer.alloc(64).toString('base64'),
});

const login = (ip: string, publicKey: string) =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send(badLogin(publicKey));

const challenge = (ip: string, publicKey: string) =>
  request(app).post('/api/auth/challenge').set('X-Forwarded-For', ip).send({ publicKey });

beforeEach(() => {
  // Jump past any window opened by the previous test.
  clock += WINDOW_MS * 10;
  nowSpy.mockImplementation(() => clock);
  fakeCacheStore.clear();
});

afterEach(() => {
  nowSpy.mockReset();
});

afterAll(() => {
  nowSpy.mockRestore();
  delete process.env.JWT_SECRET;
});

describe('POST /api/auth/login brute-force limits', () => {
  it('allows exactly 5 attempts per window, then returns the 429 contract', async () => {
    const publicKey = Keypair.random().publicKey();

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await login('10.0.0.1', publicKey);
      expect(res.status).toBe(401);
      expect(res.headers['ratelimit-remaining']).toBe(String(5 - attempt));
    }

    const blocked = await login('10.0.0.1', publicKey);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body).toEqual({
      success: false,
      message: 'Too many login attempts from this IP, please try again later.',
    });
  });

  it('blocks a fresh public key from an IP that already used its budget', async () => {
    for (let i = 0; i < 5; i++) {
      await login('10.0.0.2', Keypair.random().publicKey());
    }

    const res = await login('10.0.0.2', Keypair.random().publicKey());
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many login attempts from this IP, please try again later.');
  });

  it('keeps per-IP budgets isolated', async () => {
    const publicKey = Keypair.random().publicKey();
    for (let i = 0; i < 5; i++) {
      await login('10.0.0.3', publicKey);
    }
    expect((await login('10.0.0.3', publicKey)).status).toBe(429);

    const other = await login('10.0.0.4', Keypair.random().publicKey());
    expect(other.status).toBe(401);
  });

  it('counts schema-invalid attempts toward the limit', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.0.5')
        .send({});
      expect(res.status).toBe(400);
    }

    const blocked = await login('10.0.0.5', Keypair.random().publicKey());
    expect(blocked.status).toBe(429);
  });

  it('still blocks one millisecond before the window resets', async () => {
    const publicKey = Keypair.random().publicKey();
    const windowStart = clock;
    for (let i = 0; i < 5; i++) {
      await login('10.0.0.6', publicKey);
    }

    clock = windowStart + WINDOW_MS - 1;
    expect((await login('10.0.0.6', publicKey)).status).toBe(429);
  });

  it('restores the full budget once the window has elapsed', async () => {
    const publicKey = Keypair.random().publicKey();
    const windowStart = clock;
    for (let i = 0; i < 5; i++) {
      await login('10.0.0.7', publicKey);
    }
    expect((await login('10.0.0.7', publicKey)).status).toBe(429);

    clock = windowStart + WINDOW_MS;
    const res = await login('10.0.0.7', publicKey);
    expect(res.status).toBe(401);
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });
});

describe('POST /api/auth/challenge brute-force limits', () => {
  it('allows 10 challenges per window, then returns the 429 contract', async () => {
    const publicKey = Keypair.random().publicKey();

    for (let i = 0; i < 10; i++) {
      expect((await challenge('10.0.1.1', publicKey)).status).toBe(200);
    }

    const blocked = await challenge('10.0.1.1', publicKey);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body).toEqual({
      success: false,
      message: 'Too many challenge requests, please try again later.',
    });
  });

  it('does not share its budget with the login limiter', async () => {
    const publicKey = Keypair.random().publicKey();
    for (let i = 0; i < 10; i++) {
      await challenge('10.0.1.2', publicKey);
    }
    expect((await challenge('10.0.1.2', publicKey)).status).toBe(429);

    expect((await login('10.0.1.2', publicKey)).status).toBe(401);
  });

  it('resets after the window elapses', async () => {
    const publicKey = Keypair.random().publicKey();
    const windowStart = clock;
    for (let i = 0; i < 10; i++) {
      await challenge('10.0.1.3', publicKey);
    }
    expect((await challenge('10.0.1.3', publicKey)).status).toBe(429);

    clock = windowStart + WINDOW_MS;
    expect((await challenge('10.0.1.3', publicKey)).status).toBe(200);
  });
});

describe('authenticated auth routes', () => {
  it('rejects GET /verify without a token', async () => {
    const res = await request(app).get('/api/auth/verify');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('accepts GET /verify with a valid token', async () => {
    const publicKey = Keypair.random().publicKey();
    const res = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', `Bearer ${generateJwtToken(publicKey)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects POST /logout without a token', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });
});
