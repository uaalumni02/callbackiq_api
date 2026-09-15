import 'dotenv/config';
import fs from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
if (process.env.SCALE_ALLOW_STAGING_LOAD !== 'true') throw new Error('Staging acceptance requires explicit opt-in');
const origin = new URL(process.env.SCALE_UI_URL);
if (origin.protocol !== 'https:') throw new Error('Test the real HTTPS deployment');
for (const key of ['SCALE_LOGIN', 'SCALE_PASSWORD', 'SCALE_API_SHA', 'SCALE_UI_SHA']) if (!process.env[key]) throw new Error(`Missing ${key}`);
const results = [];
for (const [name, engine, viewport] of [['chromium-desktop', chromium, { width:1280, height:900 }], ['chromium-mobile', chromium, { width:390, height:844 }], ['webkit-mobile', webkit, { width:390, height:844 }]]) {
  const browser = await engine.launch({ headless:true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(); let errors = 0;
  page.on('pageerror', () => errors++);
  try {
    await page.goto(new URL('/login', origin).href);
    await page.locator('#login').fill(process.env.SCALE_LOGIN);
    await page.locator('#password').fill(process.env.SCALE_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(url => ['/dashboard','/inbox'].includes(url.pathname), { timeout:30000 });
    // No injected token, API interception, fabricated response or saved auth state.
    for (const route of ['/dashboard','/inbox','/appointments','/intervention-center','/settings','/billing']) {
      await page.goto(new URL(route, origin).href);
      await page.waitForLoadState('networkidle');
      if (new URL(page.url()).pathname !== route) throw new Error('Unexpected route after authenticated navigation');
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) throw new Error('Horizontal overflow');
      if (viewport.width < 500) {
        await page.getByRole('button', { name:'Menu', exact:true }).click();
        await page.getByRole('link', { name:'Needs Attention', exact:true }).first().waitFor({ state:'visible' });
        await page.keyboard.press('Escape');
      }
    }
    if (errors) throw new Error('Browser runtime error');
    results.push({ name, passed:true });
  } catch { results.push({ name, passed:false, reason:'Login/navigation/browser acceptance failed; inspect interactively with the staging account.' }); }
  finally { await context.close(); await browser.close(); }
}
const report = { apiSha:process.env.SCALE_API_SHA, uiSha:process.env.SCALE_UI_SHA, observedAt:new Date().toISOString(), results,
  note:'Browser engines with mobile viewports; real-device and provider journey observations remain separate.' };
await fs.writeFile(process.env.SCALE_BROWSER_REPORT || 'staging-browser-report.json', JSON.stringify(report,null,2)+'\n', { mode:0o600 });
if (results.some(x => !x.passed)) process.exitCode=1;
