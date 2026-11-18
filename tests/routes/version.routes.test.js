import request from 'supertest';
import app from '../../src/app.js';
import buildVersion from '../../src/config/build-version.js';

jest.mock('../../src/config/build-version.js', () => ({
  __esModule: true, default: { sha: null, builtAt: null },
}));

test('version reports the source identity and disables caching', async () => {
  expect(jest.requireActual('../../src/config/build-version.js').default).toEqual({ sha: null, builtAt: null });
  const previous = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'a'.repeat(40);
  try {
    const response = await request(app).get('/version').expect(200);
    expect(response.body).toEqual({ sha: 'a'.repeat(40), builtAt: null });
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    if (previous === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previous;
  }
});

test('stamped production builds report the artifact identity', async () => {
  const stamp = { sha: 'b'.repeat(40), builtAt: '2026-11-18T00:00:00.000Z' };
  Object.assign(buildVersion, stamp);
  try {
    const response = await request(app).get('/version').expect(200);
    expect(response.body).toEqual(stamp);
  } finally {
    Object.assign(buildVersion, { sha: null, builtAt: null });
  }
});
