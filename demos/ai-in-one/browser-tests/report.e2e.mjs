import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const layout = JSON.parse(readFileSync(new URL('../src/report/layout.json', import.meta.url), 'utf8'))
const report = process.env.DEMO_PACKAGED ? '/demo/ai-in-one-report/' : '/report.html'

test('all original report pages navigate without errors or live requests', async ({ page }, testInfo) => {
  const external = []
  const errors = []
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4317/') && !r.url().startsWith('data:')) external.push(r.url()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${report}?mode=live`)
  const picker = page.getByRole('combobox', { name: 'Report page', exact: true })
  await expect(picker).toBeVisible()
  for (const original of layout.pages) {
    await picker.selectOption(original.id)
    await expect(page.getByRole('main')).toHaveAttribute('aria-label', original.name)
    await expect(page.locator('.report-visual')).not.toHaveCount(0)
    await expect(page.locator('.report-canvas')).not.toContainText('NaN')
    const clippedLegends = await page.locator('.report-visual:has(.legend)').evaluateAll((panels) => panels.filter((panel) => panel.querySelector('.legend').getBoundingClientRect().bottom > panel.getBoundingClientRect().bottom + 1).map((panel) => ({ title: panel.querySelector('h3')?.textContent, panelHeight: panel.clientHeight, legendHeight: panel.querySelector('.legend').clientHeight })))
    expect(clippedLegends, original.name).toEqual([])
    if (original === layout.pages[0] || original === layout.pages[2] || original === layout.pages[16]) await page.screenshot({ path: testInfo.outputPath(`report-${layout.pages.indexOf(original)}.png`), fullPage: true })
  }
  expect(errors).toEqual([])
  expect(external).toEqual([])
})

test('report filters, reset and agent drillthrough work', async ({ page }) => {
  await page.goto(report)
  const activeUsers = page.locator('.report-cardVisual').filter({ has: page.getByRole('heading', { name: 'Active users', exact: true }) }).locator('.report-kpi')
  await expect(activeUsers).toHaveText('150')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('dialog').getByRole('combobox', { name: 'Organisation', exact: true }).selectOption('Aster Works')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(activeUsers).toHaveText('40')
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await expect(activeUsers).toHaveText('150')
  await page.locator('.report-row-link').first().click()
  await expect(page.getByRole('combobox', { name: 'Report page', exact: true })).toHaveValue('a1093020260000000002')
  await page.reload()
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', /Agent Details/)
  await page.getByRole('button', { name: 'About the report demo', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('does not implement Power BI RLS')
})

test('report date, agent, glossary and monthly controls use local data', async ({ page }) => {
  const external = []
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4317/') && !r.url().startsWith('data:')) external.push(r.url()) })
  await page.goto(report)
  await page.getByRole('combobox', { name: 'Report page', exact: true }).selectOption(layout.pages[2].id)
  await page.getByRole('button', { name: 'Monthly comparison', exact: true }).first().click()
  await expect(page.locator('.report-monthly')).toContainText('2026-09')
  await page.getByRole('button', { name: 'Back to weekly patterns' }).click()
  await page.getByRole('combobox', { name: 'Report page', exact: true }).selectOption(layout.pages[4].id)
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('Research helper 1')
  await expect(page.locator('.report-provenance')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('Research helper 1')
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('')
  await page.getByRole('combobox', { name: 'Report page', exact: true }).selectOption(layout.pages[16].id)
  await page.getByRole('combobox', { name: 'Guide page', exact: true }).selectOption('Copilot Overall - Combined Trends')
  await expect(page.locator('.report-table tbody tr')).toHaveCount(9)
  await page.getByRole('combobox', { name: 'Report page', exact: true }).selectOption(layout.pages[0].id)
  await page.getByRole('main').getByLabel('From date', { exact: true }).fill('2026-05-04')
  await page.getByRole('main').getByLabel('To date', { exact: true }).fill('2026-05-04')
  const prompts = page.locator('.report-cardVisual').filter({ has: page.getByRole('heading', { name: 'Prompts', exact: true }) }).locator('.report-kpi')
  await expect(prompts).not.toHaveText('40,966')
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await expect(prompts).toHaveText('40,966')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('combobox', { name: 'Report page', exact: true })).toBeVisible()
  expect(await page.locator('.report-scroll').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  expect(external).toEqual([])
  if (process.env.DEMO_PACKAGED) {
    await page.getByRole('link', { name: 'App demo', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'AI in One', exact: true })).toBeVisible()
  }
})
