/**
 * dsh-rlm Settings > Plugins card.
 *
 * The UI is deliberately simple-first: common controls are in General, while
 * limits, recovery/safety, and token guard settings stay discoverable without
 * overwhelming a first-time user. Writes remain staged until Save.
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
  type RlmFieldWrite,
  type RlmSettings,
  type RlmTab,
} from './rlm-settings-model.js'
import { FIELD_HINT, FIELD_LABEL, TAB_HELP, TAB_LABEL } from './rlm-settings-locales.js'

export type RlmSettingsFace = { readonly scope: SettingsScope<RlmSettings> }
export type RlmSettingsCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<typeof RLM_SETTINGS_LOCALE_NS> & InjectFace<RlmSettingsFace>

type SettingsMutationOp =
  | { op: 'set'; path: string[]; value: boolean | number | string }
  | { op: 'unset'; path: string[] }

const token = (name: string, fallback: string): string => `var(${name}, ${fallback})`

const layout: Record<string, CSSProperties> = {
  card: {
    listStyle: 'none',
    border: `0.5px solid ${token('--dsw-alias-border-l4', token('--dsh-color-border', '#555'))}`,
    borderRadius: 16,
    marginBottom: 16,
    overflow: 'hidden',
    background: token('--dsw-alias-bg-layer-3', 'transparent'),
  },
  header: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    textAlign: 'left',
    padding: '14px 16px',
    background: 'transparent',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  mark: {
    width: 36,
    height: 36,
    flex: '0 0 36px',
    borderRadius: 10,
    display: 'grid',
    placeItems: 'center',
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.04em',
    border: `0.5px solid ${token('--dsw-alias-border-l4', token('--dsh-color-border', '#555'))}`,
    background: token('--dsw-alias-bg-module-platform', 'transparent'),
    color: token('--dsw-alias-label-primary', 'inherit'),
  },
  titleWrap: { flex: 1, minWidth: 0, display: 'grid', gap: 3 },
  title: { display: 'block', fontWeight: 600, fontSize: 15, lineHeight: 1.4, color: token('--dsw-alias-label-primary', 'inherit') },
  description: { display: 'block', fontSize: 13, lineHeight: 1.5, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  statusRow: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' },
  badge: {
    borderRadius: 999,
    padding: '2px 8px',
    fontSize: 11,
    lineHeight: '17px',
    fontWeight: 500,
    background: token('--dsw-alias-bg-module-platform', 'transparent'),
    color: token('--dsw-alias-label-secondary', 'inherit'),
    whiteSpace: 'nowrap',
  },
  body: { margin: '0 16px', padding: '0 0 10px', borderTop: `0.5px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}` },
  intro: { margin: '14px 0 12px', display: 'grid', gap: 7 },
  introTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: token('--dsw-alias-label-primary', 'inherit') },
  introText: { margin: 0, fontSize: 12, lineHeight: 1.55, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  readOnly: { margin: '12px 0 0', fontSize: 12, lineHeight: 1.5, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  tabs: {
    display: 'flex',
    gap: 4,
    overflowX: 'auto',
    padding: '2px 0 0',
    borderBottom: `0.5px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}`,
  },
  tab: {
    appearance: 'none',
    flex: '0 0 auto',
    padding: '9px 10px',
    border: 0,
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: token('--dsw-alias-label-tertiary', 'inherit'),
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
  },
  tabActive: { borderBottomColor: token('--dsw-alias-brand-primary', token('--dsh-color-primary', '#7187ff')), color: token('--dsw-alias-label-primary', 'inherit'), fontWeight: 600 },
  tabHelp: { margin: '12px 0', fontSize: 12, lineHeight: 1.55, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 },
  field: {
    display: 'grid',
    gap: 7,
    padding: 12,
    border: `0.5px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}`,
    borderRadius: 12,
    background: token('--dsw-alias-bg-layer-3', 'transparent'),
    alignContent: 'start',
  },
  toggleField: { gridTemplateColumns: '1fr auto', alignItems: 'center', columnGap: 14 },
  fieldDisabled: { opacity: 0.58 },
  label: { fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: token('--dsw-alias-label-primary', 'inherit') },
  labelRow: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  overrideBadge: {
    borderRadius: 999,
    padding: '1px 7px',
    fontSize: 10,
    lineHeight: '16px',
    background: token('--dsw-alias-bg-module-platform', 'transparent'),
    color: token('--dsw-alias-label-secondary', 'inherit'),
  },
  hint: { margin: 0, fontSize: 11.5, lineHeight: 1.55, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  dependencyHint: { margin: 0, fontSize: 11.5, lineHeight: 1.5, color: token('--dsw-alias-label-secondary', 'currentColor') },
  valueMeta: { margin: 0, fontSize: 11, lineHeight: 1.4, color: token('--dsw-alias-label-dimmed', 'currentColor') },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 36,
    borderRadius: 8,
    border: `1px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}`,
    background: token('--dsw-alias-bg-layer-3', 'transparent'),
    color: token('--dsw-alias-label-primary', 'inherit'),
    padding: '7px 10px',
    font: 'inherit',
    fontSize: 13,
  },
  checkbox: { width: 18, height: 18, accentColor: token('--dsw-alias-brand-primary', token('--dsh-color-primary', '#7187ff')), cursor: 'pointer' },
  invalid: { color: token('--dsw-alias-label-error', token('--dsh-color-danger', '#d44')) },
  summary: {
    margin: '12px 0 0',
    padding: '9px 10px',
    borderRadius: 9,
    fontSize: 12,
    lineHeight: 1.5,
    background: token('--dsw-alias-bg-module-platform', 'transparent'),
    color: token('--dsw-alias-label-secondary', 'inherit'),
  },
  summaryError: { color: token('--dsw-alias-label-error', token('--dsh-color-danger', '#d44')) },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 12,
    padding: '12px 0 4px',
    borderTop: `0.5px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}`,
  },
  footerStatus: { flex: '1 1 260px', margin: 0, fontSize: 12, lineHeight: 1.5, color: token('--dsw-alias-label-tertiary', 'currentColor') },
  footerError: { color: token('--dsw-alias-label-error', token('--dsh-color-danger', '#d44')) },
  button: { appearance: 'none', borderRadius: 8, padding: '6px 12px', font: 'inherit', fontSize: 12, lineHeight: 1.5, cursor: 'pointer' },
  secondaryButton: { border: `1px solid ${token('--dsw-alias-border-l2', token('--dsh-color-border', '#555'))}`, background: 'transparent', color: token('--dsw-alias-label-secondary', 'inherit') },
  primaryButton: { border: '1px solid transparent', background: token('--dsw-alias-label-primary', 'currentColor'), color: token('--dsw-alias-bg-layer-3', 'white') },
}

const TAB_ORDER: readonly RlmTab[] = ['core', 'bounded', 'recovery', 'guard']

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
  const writes = useMemo(() => buildWrites(draft, dirty, stagedClear), [draft, dirty, stagedClear])

  const edit = (field: RlmFieldKey, value: RlmDraft[RlmFieldKey]) => {
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => new Set(current).add(field))
    setStagedClear(current => { const next = new Set(current); next.delete(field); return next })
    dispatch({ type: 'edit' })
  }

  const discard = () => {
    setDraft(deriveDraft(snapshot.value))
    setDirty(new Set())
    setStagedClear(new Set())
    dispatch({ type: 'reset' })
  }

  const reset = () => {
    const next = resetState(snapshot.base as RlmSettings | undefined, snapshot.user as Record<string, unknown> | undefined)
    setDraft(next.draft)
    setDirty(next.dirty)
    setStagedClear(next.stagedClear)
    dispatch({ type: 'reset' })
  }

  const canSave = editable && writes.length > 0 && !invalid && snapshot.revision !== undefined
  const canDiscard = saveState !== 'saving' && dirty.size > 0
  const canReset = editable && (dirty.size > 0 || overrides.size > 0)

  const save = () => {
    if (!canSave || snapshot.revision === undefined) return
    const expectedRevision = snapshot.revision
    const planned = [...writes]
    const ops = mutationOps(planned)
    void (async () => {
      dispatch({ type: 'begin' })
      try {
        const compatible = props.scope as SettingsScope<RlmSettings> & {
          mutate?: (ops: readonly SettingsMutationOp[], expectedRevision?: number) => Promise<void>
        }
        if (typeof compatible.mutate === 'function') {
          await compatible.mutate(ops, expectedRevision)
        } else {
          // dsh-client-runtime 0.1.1-rc.2 has only field writes. Keep that
          // supported baseline usable; #69/#77 track moving the minimum DSH
          // version to the atomic namespace mutation contract.
          for (const write of planned) {
            if (write.op === 'clear') await props.scope.unset(write.key)
            else await props.scope.set(write.key, write.value)
          }
        }
        const accepted = props.scope.getSnapshot()
        if (!writesLanded(accepted.user, planned)) {
          dispatch({ type: 'fail' })
          return
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
  const effectiveEnabled = draft.enabled

  return (
    <li style={layout.card} data-rlm-settings-entry>
      <button
        type="button"
        style={layout.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'close' : 'open')}: ${props.t('title')} ${props.t('subtitle')}`}
        onClick={() => { setOpen(value => !value) }}
      >
        <span aria-hidden="true" style={layout.mark}>RLM</span>
        <span style={layout.titleWrap}>
          <span style={layout.title}>{props.t('title')} · {props.t('subtitle')}</span>
          <span style={layout.description}>{props.t('description')}</span>
        </span>
        <span style={layout.statusRow}>
          {dirty.size > 0 ? <span style={layout.badge}>{props.t('unsaved')}</span> : null}
          <span style={layout.badge}>{props.t(effectiveEnabled ? 'enabledStatus' : 'disabledStatus')}</span>
          <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
        </span>
      </button>

      {open ? (
        <div style={layout.body}>
          <div style={layout.intro}>
            <p style={layout.introTitle}>{props.t('quickStartTitle')}</p>
            <p style={layout.introText}>{props.t('quickStart')}</p>
          </div>
          {!editable && snapshot.status === 'ready' && saveState !== 'saving'
            ? <p role="status" style={layout.readOnly}>{props.t('readOnly')}</p>
            : null}

          <div role="tablist" aria-label={props.t('sectionLabel')} style={layout.tabs}>
            {TAB_ORDER.map(value => (
              <TabButton key={value} current={tab} value={value} onSelect={setTab}>
                {props.t(TAB_LABEL[value])}
              </TabButton>
            ))}
          </div>

          <section
            id={`rlm-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`rlm-tab-${tab}`}
          >
            <p style={layout.tabHelp}>{props.t(TAB_HELP[tab])}</p>
            <div style={layout.grid}>
              {fieldsForTab(tab).map(field => (
                <Field
                  key={field}
                  field={field}
                  draft={draft}
                  editable={editable}
                  overridden={isFieldOverridden(field, {
                    dirty: dirty.has(field),
                    stagedClear: stagedClear.has(field),
                    userOwns: overrides.has(field),
                  })}
                  problem={problems[field]}
                  t={props.t}
                  onEdit={edit}
                />
              ))}
            </div>
          </section>

          <div
            role={firstProblem === undefined ? 'status' : 'alert'}
            style={{ ...layout.summary, ...(firstProblem === undefined ? {} : layout.summaryError) }}
          >
            {firstProblem === undefined
              ? props.t(dirty.size > 0 ? 'unsavedSummary' : 'restart')
              : props.t('validationSummary')}
          </div>

          <div style={layout.footer}>
            {saveState === 'saved'
              ? <p role="status" style={layout.footerStatus}>{props.t('saved')} {props.t('restart')}</p>
              : saveState === 'failed'
                ? <p role="alert" style={{ ...layout.footerStatus, ...layout.footerError }}>{props.t('saveFailed')}</p>
                : <span style={{ flex: 1 }} />}
            <button type="button" style={{ ...layout.button, ...layout.secondaryButton }} disabled={!canReset} onClick={reset}>
              {props.t('reset')}
            </button>
            <button type="button" style={{ ...layout.button, ...layout.secondaryButton }} disabled={!canDiscard} onClick={discard}>
              {props.t('discard')}
            </button>
            <button type="button" style={{ ...layout.button, ...layout.primaryButton }} disabled={!canSave} onClick={save}>
              {props.t(saveState === 'saving' ? 'saving' : 'save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function TabButton(props: { readonly current: RlmTab; readonly value: RlmTab; readonly onSelect: (tab: RlmTab) => void; readonly children: string }) {
  return (
    <button
      id={`rlm-tab-${props.value}`}
      type="button"
      role="tab"
      aria-selected={props.current === props.value}
      aria-controls={`rlm-panel-${props.value}`}
      style={{ ...layout.tab, ...(props.current === props.value ? layout.tabActive : {}) }}
      onClick={() => { props.onSelect(props.value) }}
    >
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
  const dependency = dependencyOf(props.field, props.draft)
  const controlled = !props.editable || dependency.disabled
  const invalid = props.problem !== undefined
  const meta = readableValue(props.field, props.draft)
  const fieldStyle = {
    ...layout.field,
    ...(spec.kind === 'toggle' ? layout.toggleField : {}),
    ...(dependency.disabled ? layout.fieldDisabled : {}),
  }

  return (
    <label style={fieldStyle}>
      <span style={{ display: 'grid', gap: 6 }}>
        <span style={layout.labelRow}>
          <span style={layout.label}>{props.t(labelKey)}</span>
          {props.overridden ? <span style={layout.overrideBadge}>{props.t('overridden')}</span> : null}
        </span>
        {hintKey !== undefined ? <span style={layout.hint}>{props.t(hintKey)}</span> : null}
        {dependency.message !== undefined ? <span style={layout.dependencyHint}>{props.t(dependency.message)}</span> : null}
        {meta !== undefined ? <span style={layout.valueMeta}>{props.t('effectiveValue')}: {meta}</span> : null}
        {invalid ? <span role="alert" style={{ ...layout.hint, ...layout.invalid }}>{props.t(props.problem ?? 'invalidNumber')}</span> : null}
      </span>
      <FieldControl spec={spec} draft={props.draft} controlled={controlled} t={props.t} onEdit={props.onEdit} />
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
      return (
        <input
          aria-label={props.t(FIELD_LABEL[spec.key])}
          type="checkbox"
          checked={draft[spec.key] as boolean}
          disabled={controlled}
          style={layout.checkbox}
          onChange={event => { onEdit(spec.key, event.target.checked) }}
        />
      )
    case 'select':
      return (
        <select
          aria-label={props.t(FIELD_LABEL[spec.key])}
          style={layout.input}
          value={String(draft[spec.key])}
          disabled={controlled}
          onChange={event => { onEdit(spec.key, event.target.value) }}
        >
          {(spec.options ?? []).map(option => <option key={option} value={option}>{sandboxOption(option, props.t)}</option>)}
        </select>
      )
    case 'number':
      return (
        <input
          aria-label={props.t(FIELD_LABEL[spec.key])}
          type="number"
          min={spec.min}
          max={spec.max}
          step="1"
          style={layout.input}
          value={String(draft[spec.key])}
          disabled={controlled}
          onChange={event => { onEdit(spec.key, event.target.value) }}
        />
      )
    case 'text':
      return (
        <input
          aria-label={props.t(FIELD_LABEL[spec.key])}
          type="text"
          style={layout.input}
          value={String(draft[spec.key])}
          disabled={controlled}
          onChange={event => { onEdit(spec.key, event.target.value) }}
        />
      )
  }
}

function fieldsForTab(tab: RlmTab): readonly RlmFieldKey[] {
  if (tab === 'core') return [...tabFields('core'), 'timeout']
  if (tab === 'bounded') return tabFields('bounded').filter(field => field !== 'timeout')
  return tabFields(tab)
}

function dependencyOf(field: RlmFieldKey, draft: RlmDraft): { disabled: boolean; message?: 'dependency.snapshotRecovery' | 'dependency.tokenGuard' } {
  if (field === 'durableRoot' && !draft.snapshotRecovery) return { disabled: true, message: 'dependency.snapshotRecovery' }
  if (field === 'maxQueryTokensPerCell' && !draft.guardQueryTokens) return { disabled: true, message: 'dependency.tokenGuard' }
  return { disabled: false }
}

function readableValue(field: RlmFieldKey, draft: RlmDraft): string | undefined {
  const raw = draft[field]
  if (typeof raw === 'boolean') return undefined
  const numeric = Number(String(raw))
  if (!Number.isFinite(numeric)) return undefined
  if (field === 'timeout') return formatDuration(numeric)
  if (field === 'maxStdout' || field === 'maxResult' || field === 'maxContextBytes') return formatBytes(numeric)
  if (field === 'maxQueryTokensPerCell') return numeric === 0 ? '0' : numeric.toLocaleString('en-US')
  return undefined
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  if (ms % 1_000 === 0) return `${ms / 1_000} s`
  return `${ms} ms`
}

function formatBytes(bytes: number): string {
  const mib = 1024 * 1024
  const kib = 1024
  if (bytes % mib === 0) return `${bytes / mib} MiB`
  if (bytes % kib === 0) return `${bytes / kib} KiB`
  return `${bytes.toLocaleString('en-US')} B`
}

function sandboxOption(option: string, t: RlmSettingsCardProps['t']): string {
  if (option === 'auto') return t('sandbox.auto')
  if (option === 'require') return t('sandbox.require')
  if (option === 'off') return t('sandbox.off')
  return option
}

function mutationOps(writes: readonly RlmFieldWrite[]): SettingsMutationOp[] {
  return writes.map(write => write.op === 'clear'
    ? { op: 'unset', path: [write.key] }
    : { op: 'set', path: [write.key], value: write.value })
}

function writesLanded(user: unknown, writes: readonly RlmFieldWrite[]): boolean {
  const layer = user !== null && typeof user === 'object' && !Array.isArray(user)
    ? user as Record<string, unknown>
    : undefined
  for (const write of writes) {
    const owns = layer !== undefined && Object.prototype.hasOwnProperty.call(layer, write.key)
    if (write.op === 'clear') {
      if (owns) return false
      continue
    }
    if (!owns || layer?.[write.key] !== write.value) return false
  }
  return true
}

function firstProblemKey(problems: Readonly<Partial<Record<RlmFieldKey, RlmDraftProblem>>>): RlmDraftProblem | undefined {
  for (const value of Object.values(problems)) if (value !== undefined) return value
  return undefined
}
