/**
 * dsh-rlm settings card, registered under `settings.plugin.item` keyed by the
 * `rlm` namespace. Mirrors the swarm `TeamSkillSettingsCard` shell and the
 * official CardForm semantics: a staged draft, per-field override badge, reset
 * to composition, and Save/Saving/Saved/Failed footer states.
 *
 * All stage/override/validation/save-state logic lives in the pure
 * `rlm-settings-model.ts` module (no React/DOM/DSH imports there) so it is
 * testable with `node --test`.
 */
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  RLM_SETTINGS_LOCALE_NS,
  deriveDraft,
  deriveOverrides,
  validateDraft,
  isDraftValid,
  isFieldOverridden,
  buildWrites,
  resetState,
  saveStateReducer,
  fieldSpec,
  tabFields,
  type RlmDraft,
  type RlmDraftProblem,
  type RlmFieldKey,
  type RlmSettings,
  type RlmTab,
} from './rlm-settings-model.js'
import { FIELD_HINT, FIELD_LABEL, TAB_LABEL } from './rlm-settings-locales.js'

export type RlmSettingsFace = { readonly scope: SettingsScope<RlmSettings> }
export type RlmSettingsCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<typeof RLM_SETTINGS_LOCALE_NS> & InjectFace<RlmSettingsFace>

const layout: Record<string, CSSProperties> = {
  card: { listStyle: 'none', border: '1px solid var(--dsh-color-border, #555)', borderRadius: 16, marginBottom: 16, overflow: 'hidden' },
  header: { width: '100%', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', padding: '18px 20px', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' },
  mark: { width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', fontWeight: 800, color: '#dbe2ff', background: 'linear-gradient(145deg, #3478c9, #1e4a7a)' },
  title: { display: 'block', fontWeight: 750, fontSize: 18 },
  description: { display: 'block', marginTop: 4, opacity: 0.72 },
  badge: { border: '1px solid var(--dsh-color-border, #555)', borderRadius: 999, padding: '3px 9px', fontSize: 12, opacity: 0.8 },
  body: { padding: '0 20px 20px', borderTop: '1px solid var(--dsh-color-border, #555)' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid var(--dsh-color-border, #555)', marginBottom: 20 },
  tab: { padding: '13px 10px', border: 0, borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: 'transparent', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  tabActive: { borderBottomColor: 'var(--dsh-color-primary, #7187ff)', fontWeight: 700 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 },
  field: { display: 'grid', gap: 6 },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 38 },
  hint: { margin: '10px 0', opacity: 0.72, fontSize: 13 },
  badgeRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  overrideBadge: { border: '1px solid var(--dsh-color-border, #555)', borderRadius: 999, padding: '1px 7px', fontSize: 11, opacity: 0.8 },
  invalid: { color: 'var(--dsh-color-danger, #d44)' },
  footer: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 16 },
}

export function RlmSettingsCard(props: RlmSettingsCardProps) {
  const snapshot = useSyncExternalStore(
    useCallback(listener => props.scope.subscribe(listener), [props.scope]),
    useCallback(() => props.scope.getSnapshot(), [props.scope]),
    useCallback(() => props.scope.getSnapshot(), [props.scope]),
  )
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<RlmTab>('core')
  const [draft, setDraft] = useState<RlmDraft>(() => deriveDraft(snapshot.value))
  const [dirty, setDirty] = useState<ReadonlySet<RlmFieldKey>>(new Set())
  const [stagedClear, setStagedClear] = useState<ReadonlySet<RlmFieldKey>>(new Set())
  const [saveState, dispatch] = useReducer(saveStateReducer, 'idle')

  const overrides = useMemo(() => deriveOverrides(snapshot.user as Record<string, unknown> | undefined), [snapshot.user])

  useEffect(() => {
    if (snapshot.status === 'ready' && dirty.size === 0) setDraft(deriveDraft(snapshot.value))
  }, [snapshot.status, snapshot.revision, snapshot.value, dirty.size])

  const editable = snapshot.status === 'ready' && snapshot.writable === true && saveState !== 'saving'
  const problems = useMemo(() => validateDraft(draft), [draft])
  const invalid = !isDraftValid(draft)

  const edit = (field: RlmFieldKey, value: RlmDraft[RlmFieldKey]) => {
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => new Set(current).add(field))
    setStagedClear(current => { const next = new Set(current); next.delete(field); return next })
    dispatch({ type: 'edit' })
  }

  const reset = () => {
    const next = resetState(snapshot.base as RlmSettings | undefined, snapshot.user as Record<string, unknown> | undefined)
    setDraft(next.draft)
    setDirty(next.dirty)
    setStagedClear(next.stagedClear)
    dispatch({ type: 'reset' })
  }

  const canSave = editable && dirty.size > 0 && !invalid

  const save = () => {
    if (!canSave) return
    void (async () => {
      dispatch({ type: 'begin' })
      try {
        for (const write of buildWrites(draft, dirty, stagedClear)) {
          if (write.op === 'clear') await props.scope.unset(write.key)
          else await props.scope.set(write.key, write.value)
        }
        setDirty(new Set())
        setStagedClear(new Set())
        dispatch({ type: 'succeed' })
      } catch {
        dispatch({ type: 'fail' })
      }
    })()
  }

  if (snapshot.status === 'unavailable') return null

  const firstProblem = firstProblemKey(problems)

  return (
    <li style={layout.card} data-rlm-settings-entry>
      <button type="button" style={layout.header} aria-expanded={open} aria-label={`${props.t(open ? 'close' : 'open')}: ${props.t('title')} ${props.t('subtitle')}`} onClick={() => { setOpen(value => !value) }}>
        <span aria-hidden="true" style={layout.mark}>RL</span>
        <span style={{ flex: 1 }}>
          <span style={layout.title}>{props.t('title')} · {props.t('subtitle')}</span>
          <span style={layout.description}>{props.t('description')}</span>
        </span>
        <span style={layout.badge}>{props.t('active')}</span>
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open ? (
        <div style={layout.body}>
          {!editable && snapshot.status === 'ready' ? <p role="status" style={layout.hint}>{props.t('readOnly')}</p> : null}
          <nav aria-label={props.t('title')} style={layout.tabs}>
            {(['core', 'bounded', 'recovery', 'guard'] as const).map(value => <TabButton key={value} current={tab} value={value} onSelect={setTab}>{props.t(TAB_LABEL[value])}</TabButton>)}
          </nav>
          <section style={layout.grid}>
            {tabFields(tab).map(field => <Field key={field} field={field} draft={draft} editable={editable} overridden={isFieldOverridden(field, { dirty: dirty.has(field), stagedClear: stagedClear.has(field), userOwns: overrides.has(field) })} problem={problems[field]} t={props.t} onEdit={edit} />)}
          </section>
          <p role={firstProblem === undefined ? undefined : 'alert'} style={{ ...layout.hint, color: firstProblem === undefined ? undefined : 'var(--dsh-color-danger, #d44)' }}>
            {firstProblem === undefined ? props.t('restart') : props.t(firstProblem)}
          </p>
          <div style={layout.footer}>
            {saveState === 'saved' ? <span role="status">{props.t('saved')} {props.t('restart')}</span> : null}
            {saveState === 'failed' ? <span role="alert">{props.t('saveFailed')}</span> : null}
            <button type="button" disabled={!canSave} onClick={save}>{props.t(saveState === 'saving' ? 'saving' : 'save')}</button>
            <button type="button" disabled={!editable || dirty.size === 0} onClick={reset}>{props.t('reset')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function TabButton(props: { readonly current: RlmTab; readonly value: RlmTab; readonly onSelect: (tab: RlmTab) => void; readonly children: string }) {
  return (
    <button type="button" role="tab" aria-selected={props.current === props.value} style={{ ...layout.tab, ...(props.current === props.value ? layout.tabActive : {}) }} onClick={() => { props.onSelect(props.value) }}>
      {props.children}
    </button>
  )
}

function Field(props: {
  readonly field: RlmFieldKey
  readonly draft: RlmDraft
  readonly editable: boolean
  readonly overridden: boolean
  readonly problem: RlmDraftProblem | undefined
  readonly t: RlmSettingsCardProps['t']
  readonly onEdit: (field: RlmFieldKey, value: RlmDraft[RlmFieldKey]) => void
}) {
  const spec = fieldSpec(props.field)
  const labelKey = FIELD_LABEL[props.field]
  const hintKey = FIELD_HINT[props.field]
  const controlled = !props.editable || (spec.key === 'enabled' ? false : !props.draft.enabled)
  const invalid = props.problem !== undefined
  return (
    <label style={layout.field}>
      <span style={layout.badgeRow}>
        {props.t(labelKey)}
        {props.overridden ? <span style={layout.overrideBadge}>{props.t('overridden')}</span> : null}
      </span>
      <FieldControl spec={spec} draft={props.draft} controlled={controlled} t={props.t} onEdit={props.onEdit} />
      {hintKey !== undefined ? <span style={layout.hint}>{props.t(hintKey)}</span> : null}
      {invalid ? <span role="alert" style={{ ...layout.hint, ...layout.invalid }}>{props.t(props.problem ?? 'invalidNumber')}</span> : null}
    </label>
  )
}

function FieldControl(props: {
  readonly spec: ReturnType<typeof fieldSpec>
  readonly draft: RlmDraft
  readonly controlled: boolean
  readonly t: RlmSettingsCardProps['t']
  readonly onEdit: (field: RlmFieldKey, value: RlmDraft[RlmFieldKey]) => void
}) {
  const { spec, draft, controlled, onEdit } = props
  switch (spec.kind) {
    case 'toggle':
      return <input type="checkbox" checked={draft[spec.key] as boolean} disabled={controlled} onChange={event => { onEdit(spec.key, event.target.checked) }} />
    case 'select':
      return (
        <select aria-label={props.t(FIELD_LABEL[spec.key])} style={layout.input} value={String(draft[spec.key])} disabled={controlled} onChange={event => { onEdit(spec.key, event.target.value) }}>
          {(spec.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      )
    case 'number':
      return <input type="number" min={spec.min} max={spec.max} step="1" style={layout.input} value={String(draft[spec.key])} disabled={controlled} onChange={event => { onEdit(spec.key, event.target.value) }} />
    case 'text':
      return <input type="text" style={layout.input} value={String(draft[spec.key])} disabled={controlled} onChange={event => { onEdit(spec.key, event.target.value) }} />
  }
}

function firstProblemKey(problems: Readonly<Partial<Record<RlmFieldKey, RlmDraftProblem>>>): RlmDraftProblem | undefined {
  for (const value of Object.values(problems)) if (value !== undefined) return value
  return undefined
}
