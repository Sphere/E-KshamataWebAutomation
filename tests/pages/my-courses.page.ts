import { Page, Locator } from '@playwright/test';

// EN / HI labels — the portal language is per-org (an account setting).
const MY_COURSES = /^(my courses|मेरे पाठ्यक्रम|मेरा पाठ्यक्रम)$/i;
const FOR_YOU = /for you|आपके लिए|आपके लिये/i;
const STARTED = /started|शुरू|प्रारंभ/i;
const COMPLETED = /completed|पूर्ण|पूरा/i;

/**
 * Page object for "My Courses" (`/app/user/my_courses`).
 *
 * DOM: <ws-my-courses> with a <mat-tab-group>. Tabs carry their count in the
 * label: "Started (N)", "For You (N)", "Completed (N)".
 *
 * Every selector is BILINGUAL. Some orgs (DMHUP, PVTBIHAR) serve the portal in
 * Hindi, where the tab reads "आपके लिए (N)" — matching only /for you/i returned
 * null there, which the content checks reported as "no courses" when the page
 * was in fact correct.
 */
export class MyCoursesPage {
  constructor(private readonly page: Page) {}

  /** Navigate to My Courses via the header nav and wait for the tabs. */
  async open(): Promise<void> {
    const nav = this.page.getByRole('button', { name: MY_COURSES })
      .or(this.page.getByText(MY_COURSES)).first();
    await nav.click().catch(() => {});
    await this.page.waitForURL(/\/my_?courses/i, { timeout: 20_000 }).catch(() => {});
    await this.page.locator('ws-my-courses, mat-tab-group').first()
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    await this.page.waitForTimeout(2_500);
  }

  private tab(re: RegExp): Locator {
    return this.page.getByRole('tab', { name: re }).first();
  }

  /** The number in a tab label, e.g. "For You (14)" → 14. null if not found. */
  private async tabCount(re: RegExp): Promise<number | null> {
    const txt = await this.tab(re).textContent().catch(() => null);
    const m = txt?.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  }

  forYouCount(): Promise<number | null> { return this.tabCount(FOR_YOU); }
  startedCount(): Promise<number | null> { return this.tabCount(STARTED); }
  completedCount(): Promise<number | null> { return this.tabCount(COMPLETED); }

  /** Count the program-cards in the home "PROGRAMS" section (ws-program-home). */
  async programCardCount(): Promise<number> {
    const cards = this.page.locator('[class*="program-card"]');
    await cards.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    return cards.count().catch(() => 0);
  }

  /** Open the "For You" tab and return the visible course-card titles. */
  async forYouCourseTitles(): Promise<string[]> {
    await this.tab(FOR_YOU).click().catch(() => {});
    await this.page.waitForTimeout(2_500);
    const titles = await this.page
      .locator('ws-web-course-card [class*="title" i], mat-tab-body [class*="course" i] [class*="title" i], ws-web-course-card')
      .allInnerTexts().catch(() => []);
    return [...new Set(titles.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }
}
