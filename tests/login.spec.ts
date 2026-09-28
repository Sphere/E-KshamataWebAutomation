import { test, expect } from '@playwright/test';
import { loginWithPassword } from './helpers/login';

const EMAIL = process.env.EKSHAMATA_EMAIL!;
const PASSWORD = process.env.EKSHAMATA_PASSWORD!;

/**
 * Replicates the mobile `login.e2e.ts`: log in with a pre-existing account
 * (EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD) and assert we leave the login screen.
 */
test.describe('Ekshamata web login (by password)', () => {
  test('logs in and leaves the login screen', async ({ page }) => {
    if (!EMAIL || !PASSWORD) {
      throw new Error('EKSHAMATA_EMAIL / EKSHAMATA_PASSWORD not set in .env');
    }

    await loginWithPassword(page, EMAIL, PASSWORD);

    const url = page.url();
    console.log('Post-login URL:', url);
    expect(url).not.toContain('/app/login');
    expect(url).not.toContain('/app/new-tnc');
  });
});
