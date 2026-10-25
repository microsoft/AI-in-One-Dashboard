import { describe, expect, it } from 'vitest'
import { buildDataset, loadFiles } from './load'
import { inactiveLicensed, licensedNote, totalLicensed } from './store'

const INTERACTIONS = 'UserKey,ThreadId,InteractionDate,CreationDate,License Status\n'
const USERS = 'UserKey,Organization,Has license\n'
const AGENTS = 'Agent name,Agent creator\n'
const csv = (name: string, text: string) => new File([text], name, { type: 'text/csv' })

const interactions = [
  { UserKey: 'u1', ThreadId: 't1', InteractionDate: '2026-09-01', CreationDate: '2026-09-01', 'License Status': 'Licensed' },
  { UserKey: 'u2', ThreadId: 't2', InteractionDate: '2026-09-02', CreationDate: '2026-09-02', 'License Status': 'Licensed' },
]

describe('inactive licensed users', () => {
  it('is never negative', () => {
    expect(inactiveLicensed(1, 2)).toBe(0)
    expect(inactiveLicensed(5, 2)).toBe(3)
  })

  it('is blank, with a hint, when there is no users file', () => {
    const ds = buildDataset(interactions, [], [], 'upload', 'test')
    const total = totalLicensed(ds, '')
    expect(total).toBe(0)
    expect(inactiveLicensed(total, 2)).toBeNaN()
    expect(licensedNote(ds, total, 'of 0 licensed')).toBe('load the users file to see licences')
  })

  it('says nobody is licensed when the users file has no licensed people', () => {
    const ds = buildDataset(interactions, [{ UserKey: 'u1', Organization: 'Sales', 'Has license': 'No' }], [], 'upload', 'test')
    expect(licensedNote(ds, totalLicensed(ds, ''), 'x')).toBe('no licensed users in this view')
  })

  it('keeps the normal note when people are licensed', () => {
    const ds = buildDataset(interactions, [{ UserKey: 'u1', Organization: 'Sales', 'Has license': 'Yes' }], [], 'upload', 'test')
    expect(licensedNote(ds, totalLicensed(ds, ''), 'of 1 licensed')).toBe('of 1 licensed')
  })
})

describe('dates with no rows', () => {
  it('leaves the date range blank instead of 9999-12-31', () => {
    const ds = buildDataset([], [], [], 'upload', 'test')
    expect(ds.minDate).toBe('')
    expect(ds.maxDate).toBe('')
  })
})

describe('loading files', () => {
  it('rejects a headers-only interactions file so the current data stays', async () => {
    await expect(loadFiles([csv('i.csv', INTERACTIONS)])).rejects.toThrow('no usable rows')
  })

  it('still requires an interactions file', async () => {
    await expect(loadFiles([csv('u.csv', `${USERS}u1,Sales,Yes\n`)])).rejects.toThrow('No PAX interactions file found')
  })

  it('loads interactions alone, or with headers-only users and agents files', async () => {
    const rows = `${INTERACTIONS}u1,t1,2026-09-01,2026-09-01,Licensed\n`
    const alone = await loadFiles([csv('i.csv', rows)])
    expect(alone.dataset.rows).toHaveLength(1)
    expect(alone.found).toEqual(['interactions'])
    const withEmpty = await loadFiles([csv('i.csv', rows), csv('u.csv', USERS), csv('a.csv', AGENTS)])
    expect(withEmpty.dataset.people.size).toBe(0)
    expect(withEmpty.dataset.agents).toHaveLength(0)
  })
})
