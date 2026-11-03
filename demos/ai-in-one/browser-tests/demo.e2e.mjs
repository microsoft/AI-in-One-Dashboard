import { test, expect } from '@playwright/test'
const app = process.env.DEMO_PACKAGED ? '/demo/ai-in-one/' : '/'

test('all sections and subviews render without live requests or sign-in', async ({ page }) => {
  const external = []
  const errors = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4317/') && !r.url().startsWith('data:')) external.push(r.url())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${app}?mode=live&tenant=not-a-tenant`)
  await expect(page.getByRole('heading', { name: 'AI in One', exact: true })).toBeVisible()
  await expect(page.getByText('Sample data', { exact: true })).toBeVisible()
  for (const section of ['Overview', 'M365 Copilot', 'Copilot Chat', 'Agents', 'Licence priority', 'Guide']) {
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: section, exact: true }).click()
    await expect(page.locator('.page-head h2')).toContainText(section)
  }
  const routes = ['overview', 'overview/leaderboard', 'copilot', 'copilot/leaderboard', 'copilot/habits',
    'chat', 'chat/leaderboard', 'chat/habits', 'agents', 'agents/leaderboard', 'agents/habits',
    'agents/health', 'agents/uses', 'licence', 'guide']
  for (const route of routes) {
    await page.goto(`${app}#/${route}`)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('main')).not.toBeEmpty()
    await expect(page.locator('main')).not.toContainText('NaN')
  }
  await page.evaluate(() => {
    localStorage.setItem('data-mode', 'live')
    sessionStorage.setItem('agent-inventory-mode', 'live')
  })
  await page.reload()
  await expect(page.getByText('Sample data', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
  expect(external).toEqual([])
})

test('organisation filter changes metrics and reset restores them', async ({ page }) => {
  await page.goto(app)
  const org = page.getByRole('combobox', { name: 'Organisation', exact: true })
  await expect(org).toBeVisible()
  const before = await page.locator('main').innerText()
  await org.selectOption('Aster Works')
  await expect(page.locator('main')).not.toHaveText(before, { useInnerText: true })
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(page.locator('main')).toHaveText(before, { useInnerText: true })
  await page.getByRole('button', { name: /About this demo/ }).click()
  await expect(page.getByRole('dialog')).toContainText('invented')
  await expect(page.locator('input[type=file]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
})

test('direct links and narrow layouts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${app}#/agents/health`)
  await expect(page.getByRole('heading', { name: 'AI in One', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('main')).toContainText('agent', { ignoreCase: true })
  const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(size.width).toBeLessThanOrEqual(size.viewport)
})
